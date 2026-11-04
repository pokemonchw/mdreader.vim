#!/usr/bin/env node
'use strict';

// Browser layout, displayed as replaceable PNG placements in Konsole.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { copyText: writeClipboard } = require('./clipboard.cjs');
const { pngFrame, deleteFrame, InputQueue } = require('./terminal-graphics.cjs');
const { chromium } = require('playwright-core');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const sanitize = require('sanitize-html');

const md = new MarkdownIt({
  html: true, linkify: true, typographer: false, breaks: false,
  highlight(code, language) {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value : '';
  },
}).use(require('markdown-it-task-lists')).use(require('markdown-it-footnote'));
const escape = s => md.utils.escapeHtml(String(s));
const slugCounts = new Map();
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const text = tokens[idx + 1].content;
  const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const n = slugCounts.get(slug) || 0;
  slugCounts.set(slug, n + 1);
  tokens[idx].attrSet('id', slug + (n ? '-' + n : ''));
  return self.renderToken(tokens, idx, options);
};

function documentHtml(source, filename) {
  slugCounts.clear();
  const content = sanitize(md.render(source), {
    allowedTags: sanitize.defaults.allowedTags.concat(['img', 'input', 'details', 'summary', 'del', 's', 'sup', 'sub']),
    allowedAttributes: {
      '*': ['id', 'class'], a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'],
      input: ['type', 'checked', 'disabled'], th: ['align', 'style'], td: ['align', 'style'],
      ol: ['start'], details: ['open'],
    },
    allowedStyles: { '*': { 'text-align': [/^(left|right|center)$/] } },
    allowedSchemes: ['http', 'https', 'mailto', 'file'],
    allowedSchemesByTag: { img: ['http', 'https', 'file', 'data'] },
    transformTags: { input: sanitize.simpleTransform('input', { type: 'checkbox', disabled: 'disabled' }) },
  });
  const base = pathToFileURL(path.dirname(filename) + path.sep).href;
  const css = fs.readFileSync(path.join(__dirname, 'reader.css'), 'utf8');
  const highlight = fs.readFileSync(require.resolve('highlight.js/styles/github-dark.css'), 'utf8');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data: https: http:; style-src 'unsafe-inline'; font-src file: data:;">
  <base href="${escape(base)}"><title>${escape(path.basename(filename))}</title>
  <style>${highlight}\n${css}</style></head><body>
  <main><header><span>MARKDOWN</span><span>${escape(path.basename(filename))}</span></header>
  <article class="markdown-body">${content}</article></main></body></html>`;
}

async function createReader(config, width, height) {
  const executable = config.browser || 'chromium';
  const executablePath = executable.includes(path.sep) ? path.resolve(executable)
    : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, executable))
      .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }) || executable;
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--disable-dev-shm-usage', '--allow-file-access-from-files'],
  });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1,
      colorScheme: 'dark', reducedMotion: 'reduce' });
    const htmlPath = path.join(path.dirname(config.snapshot), 'preview.html');
    fs.writeFileSync(htmlPath, documentHtml(fs.readFileSync(config.snapshot, 'utf8'), config.filename));
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await Promise.race([
      page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(
        img => img.complete ? Promise.resolve() : new Promise(resolve => { img.onload = img.onerror = resolve; })
      )); }),
      new Promise(resolve => setTimeout(resolve, 3500)),
    ]);
    await page.evaluate(zoom => { document.documentElement.style.fontSize = `${zoom}px`; }, config.zoom || 18);
    await page.evaluate(() => {
      for (const pre of document.querySelectorAll('pre')) {
        const button = document.createElement('button');
        button.className = 'copy-code'; button.textContent = '复制代码';
        pre.append(button);
      }
      const all = document.createElement('button');
      all.className = 'copy-all'; all.textContent = '复制全文';
      document.querySelector('header').append(all);
      // Navigation and clipboard access are handled by the terminal host.
      document.addEventListener('click', event => {
        if (event.target.closest('a,button')) event.preventDefault();
      }, true);
    });
    await page.evaluate(y => window.scrollTo(0, y), config.y || 0);
    return { browser, page };
  } catch (error) { await browser.close(); throw error; }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const embedded = !!config.embedded;
  let layout = config.view || {};
  const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
  // The same rendering path is available without a terminal for verification.
  if (process.argv[3] === '--screenshot') {
    const { browser, page } = await createReader(config, 1200, 900);
    try { await page.screenshot({ path: process.argv[4], fullPage: true }); }
    finally { await browser.close(); }
    return;
  }
  if (!embedded && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('请在 Konsole 中运行 Markdown 阅读模式。');
  let browser, page, cdp, stopping = false, buffer = '', cellW = 9, cellH = 18;
  let width = 1000, height = 700, zoom = config.zoom || 18, scroll = config.y || 0;
  let resize = false, dirty = false, searching = false, query = '', lastG = false;
  let revision = 0, dragging = false, mouseDown = null, lastClick = null;
  let message = '', wake, cachedKey = '', lastFrameAt = 0;
  const out = s => process.stdout.write(s);
  const wakeup = () => { if (wake) { const f = wake; wake = null; f(); } };
  const markDirty = () => { dirty = true; wakeup(); };
  const finish = () => { stopping = true; wakeup(); };
  const geometry = () => {
    if (embedded) {
      cellW = layout.cellWidth || 9; cellH = layout.cellHeight || 18;
      width = Math.max(1, Math.min(8192, Math.floor(layout.cols * cellW)));
      height = Math.max(1, Math.min(8192, Math.floor(layout.rows * cellH)));
      return;
    }
    width = Math.max(200, Math.min(4096, Math.floor((process.stdout.columns || 100) * cellW)));
    height = Math.max(100, Math.min(4096, Math.floor(((process.stdout.rows || 40) - 1) * cellH)));
  };
  const status = () => {
    const hint = searching ? '/' + query : (message || `Shift+F2 返回 · 拖选即复制 · 滚轮/j/k · 空格/b 翻页 · / 搜索 · +/- 字号`);
    if (embedded) { emit({ type: 'status', text: hint, y: scroll, zoom }); return; }
    let fit = '', cells = 0;
    for (const char of hint.replace(/[\r\n\x1b]/g, ' ')) {
      cells += char.codePointAt(0) > 255 ? 2 : 1;
      if (cells >= (process.stdout.columns || 100)) break;
      fit += char;
    }
    out(`\x1b[${process.stdout.rows || 40};1H\x1b[2K\x1b[38;2;139;148;158m${fit}\x1b[0m`);
  };
  async function copyText(text) {
    if (!text) { message = '请用鼠标拖选文字，或点击“复制代码 / 复制全文”。'; status(); return; }
    try {
      await writeClipboard(text, config.clipboard);
    } catch (error) { throw new Error('系统剪贴板不可用：' + error.message); }
    message = `已复制 ${[...text].length} 个字符 · 可直接粘贴 · Shift+F2 返回源码`;
    status();
  }
  async function find(backwards = false) {
    if (!query) return;
    const found = await page.evaluate(({ query, backwards }) => {
      const ok = window.find(query, false, backwards, true);
      if (ok) {
        const range = window.getSelection().getRangeAt(0);
        const rect = range.getBoundingClientRect();
        window.scrollBy(0, rect.top - innerHeight / 3);
      }
      return { ok, y: scrollY };
    }, { query, backwards });
    scroll = found.y; revision++; message = found.ok ? `搜索：${query}  ·  n/N 下一个/上一个  ·  Shift+F2 返回源码` : `未找到：${query}`;
    markDirty();
  }
  const actions = new InputQueue();
  const action = (fn, kind) => { actions.push(fn, kind); markDirty(); };
  function key(key) {
    if (['\x1b[1;2Q', '\x1b[12;2~', '\x1b[26~', '\x1bO2Q', '\x1b[57365;2u'].includes(key)) return finish();
    if (searching) {
      if (key === '\r' || key === '\n') { searching = false; action(() => find()); }
      else if (key === '\x1b') searching = false;
      else if (key === '\x7f' || key === '\b') query = [...query].slice(0, -1).join('');
      else if (!key.startsWith('\x1b') && key >= ' ') query += key;
      status(); return;
    }
    if (key === 'q' || key === '\x1b') return finish();
    if (!page) return;
    if (key === '\x03' || key === 'y') { action(async () => copyText(await page.evaluate(() => getSelection().toString()))); return; }
    message = '';
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
    if (mouse) {
      const button = Number(mouse[1]);
      if (button === 64 || button === 65) { scroll += button === 64 ? -100 : 100; markDirty(); }
      else if (button === 0 && mouse[4] === 'M') {
        const x = (Number(mouse[2]) - 0.5) * cellW, y = (Number(mouse[3]) - 0.5) * cellH;
        const clicks = lastClick && Date.now() - lastClick.time < 400 && Math.abs(x - lastClick.x) < cellW * 2 && Math.abs(y - lastClick.y) < cellH
          ? Math.min(3, lastClick.clicks + 1) : 1;
        lastClick = { x, y, time: Date.now(), clicks }; mouseDown = { x, y }; dragging = true;
        action(async () => {
          await page.mouse.move(x, y); await page.mouse.down({ clickCount: clicks });
          revision++; markDirty();
        });
      } else if (button === 32 && mouse[4] === 'M' && dragging) {
        const x = Math.max(0, Math.min(width - 1, (Number(mouse[2]) - 0.5) * cellW));
        const y = Math.max(0, Math.min(height - 1, (Number(mouse[3]) - 0.5) * cellH));
        action(async () => {
          await page.mouse.move(x, y);
          scroll = await page.evaluate(() => scrollY);
          revision++; markDirty();
        }, 'move');
      } else if (mouse[4] === 'm' && dragging) {
        dragging = false;
        const x = (Number(mouse[2]) - 0.5) * cellW, y = (Number(mouse[3]) - 0.5) * cellH;
        const moved = mouseDown && (Math.abs(x - mouseDown.x) > cellW || Math.abs(y - mouseDown.y) > cellH / 2);
        action(async () => {
          await page.mouse.move(x, y); await page.mouse.up();
          revision++; markDirty();
          const target = await page.evaluate(({ x, y }) => {
            const node = document.elementFromPoint(x, y);
            const selected = getSelection().toString();
            if (node?.closest('.copy-code')) return { copy: node.closest('pre').querySelector('code').textContent };
            if (node?.closest('.copy-all')) {
              const article = document.querySelector('article').cloneNode(true);
              article.querySelectorAll('button').forEach(button => button.remove());
              document.body.append(article); const text = article.innerText; article.remove();
              return { copy: text };
            }
            return { selected, href: node?.closest('a')?.href || '' };
          }, { x, y });
          if (target.selected) { await copyText(target.selected); return; }
          if (!moved && target.copy !== undefined) { await copyText(target.copy); return; }
          if (moved) return;
          const href = target.href;
          if (!href) return;
          const url = new URL(href);
          const current = new URL(page.url());
          const source = pathToFileURL(config.filename);
          if (url.hash && (url.pathname === current.pathname || url.pathname === source.pathname || url.pathname === path.dirname(source.pathname) + '/')) {
            scroll = await page.evaluate(id => { document.getElementById(id)?.scrollIntoView(); return scrollY; }, decodeURIComponent(url.hash.slice(1)));
            markDirty();
          } else if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
            const opener = spawn('xdg-open', [href], { stdio: 'ignore', detached: true });
            opener.on('error', () => { message = '无法打开链接：请安装 xdg-utils。'; status(); });
            opener.unref();
          } else { message = '本地链接：' + decodeURIComponent(url.pathname); status(); }
        });
      }
      return;
    }
    if (['j', '\x1b[B', '\x0e'].includes(key)) scroll += 70;
    else if (['k', '\x1b[A', '\x10'].includes(key)) scroll -= 70;
    else if ([' ', '\x06', '\x1b[6~'].includes(key)) scroll += height - 50;
    else if (['b', '\x02', '\x1b[5~'].includes(key)) scroll -= height - 50;
    else if (key === '\x04') scroll += height / 2;
    else if (key === '\x15') scroll -= height / 2;
    else if (key === 'G' || key === '\x1b[F' || key === '\x1b[4~') scroll = 1e9;
    else if (key === '\x1b[H' || key === '\x1b[1~' || (key === 'g' && lastG)) scroll = 0;
    else if (key === 'g') { lastG = true; return; }
    else if (key === '+' || key === '=' || key === '-') {
      zoom = Math.max(12, Math.min(36, zoom + (key === '-' ? -2 : 2)));
      action(async () => { await page.evaluate(z => { document.documentElement.style.fontSize = `${z}px`; }, zoom); markDirty(); });
      return;
    } else if (key === '/') { searching = true; query = ''; status(); return; }
    else if (key === 'n' || key === 'N') { action(() => find(key === 'N')); return; }
    else if (key === 'r' || key === '\x0c') { cachedKey = ''; markDirty(); return; }
    else return;
    lastG = false; markDirty();
  }
  let escapeTimer;
  let commands = '';
  function receive(data) {
    commands += data;
    let end;
    while ((end = commands.indexOf('\n')) !== -1) {
      const line = commands.slice(0, end); commands = commands.slice(end + 1);
      if (!line) continue;
      const command = JSON.parse(line);
      if (command.type === 'quit') finish();
      else if (command.type === 'key') input(command.key);
      else if (command.type === 'view') {
        layout = command.view; geometry(); resize = true; markDirty();
      } else if (command.type === 'redraw') { cachedKey = ''; markDirty(); }
    }
  }
  function input(data) {
    clearTimeout(escapeTimer); buffer += data.toString('utf8');
    while (buffer) {
      // Consume terminal geometry/capability replies before interpreting keys.
      const size = /^\x1b\[(4|6);(\d+);(\d+)t/.exec(buffer);
      if (size) {
        if (size[1] === '6') { cellH = Number(size[2]); cellW = Number(size[3]); }
        else { cellH = Number(size[2]) / (process.stdout.rows || 40); cellW = Number(size[3]) / (process.stdout.columns || 100); }
        geometry(); resize = true; markDirty(); buffer = buffer.slice(size[0].length); continue;
      }
      const response = /^\x1b\[\?[\d;]*c/.exec(buffer);
      if (response) { buffer = buffer.slice(response[0].length); continue; }
      let match = /^\x1b\[<?[\d;]*[A-Za-z~]/.exec(buffer) || /^\x1bO[\d;]*[A-Za-z]/.exec(buffer);
      if (match) { buffer = buffer.slice(match[0].length); key(match[0]); }
      else if (buffer.startsWith('\x1b')) {
        escapeTimer = setTimeout(() => { const rest = buffer; buffer = ''; if (rest === '\x1b') key(rest); }, 150);
        break;
      } else { const char = [...buffer][0]; buffer = buffer.slice(char.length); key(char); }
    }
  }
  if (!embedded) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8'); process.stdin.resume(); process.stdin.on('data', embedded ? receive : input);
  if (embedded) process.stdin.on('end', finish);
  process.once('SIGINT', finish); process.once('SIGTERM', finish); process.once('SIGHUP', finish);
  if (!embedded) process.stdout.on('resize', () => { out('\x1b[14t\x1b[16t'); geometry(); resize = true; markDirty(); });
  // The existing image remains visible until Konsole replaces its placement.
  if (!embedded) out('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H正在排版 Markdown…\x1b[14t\x1b[16t');
  try {
    if (!embedded) await new Promise(resolve => setTimeout(resolve, 160));
    geometry();
    if (stopping) return;
    ({ browser, page } = await createReader(config, width, height));
    cdp = await page.context().newCDPSession(page);
    markDirty();
    while (!stopping) {
      if (!dirty) { await new Promise(resolve => { wake = resolve; }); continue; }
      // Bound the frame rate without blocking terminal input. Events arriving
      // during capture/transmission are merged before the next browser update.
      const delay = 33 - (performance.now() - lastFrameAt);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      dirty = false;
      for (const { run } of actions.take()) {
        if (stopping) break;
        try { await run(); } catch (error) { message = error.message; }
      }
      if (stopping) break;
      const frameLayout = { ...layout }, frameWidth = width, frameHeight = height;
      if (resize) { resize = false; await page.setViewportSize({ width: frameWidth, height: frameHeight }); }
      scroll = await page.evaluate(y => { window.scrollTo(0, y); return scrollY; }, scroll);
      const frameKey = `${frameWidth}:${frameHeight}:${scroll}:${zoom}:${query}:${revision}:${frameLayout.version}`;
      if (cachedKey !== frameKey) {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        if (stopping) break;
        if (embedded) {
          await new Promise(resolve => process.stdout.write(JSON.stringify({ type: 'frame',
            version: frameLayout.version, width: frameWidth, height: frameHeight,
            data: pngFrame(data, { row: frameLayout.row, col: frameLayout.col, id: config.imageId }),
          }) + '\n', resolve));
        } else await new Promise(resolve => process.stdout.write(pngFrame(data), resolve));
        cachedKey = frameKey; lastFrameAt = performance.now();
      }
      status();
    }
  } finally {
    clearTimeout(escapeTimer);
    if (page && config.state) {
      try { fs.writeFileSync(config.state, JSON.stringify({ y: scroll, zoom })); }
      catch (error) { if (error.code !== 'ENOENT') console.error(error.message); }
    }
    // Restore the terminal immediately, even if browser cleanup takes a moment.
    if (embedded) emit({ type: 'closed', y: scroll, zoom });
    else {
      out(deleteFrame + '\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l');
      process.stdin.setRawMode(false);
    }
    process.stdin.pause(); process.stdin.removeListener('data', embedded ? receive : input);
    if (browser) await browser.close();
  }
}

module.exports = { documentHtml, createReader };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
