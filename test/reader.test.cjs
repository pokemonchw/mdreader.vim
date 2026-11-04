'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReader } = require('../renderer/reader.cjs');
const { copyText } = require('../renderer/clipboard.cjs');

test('browser lays out Markdown, resolves local images and selects actual text', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdreader-browser-'));
  let browser;
  try {
    const filename = path.join(__dirname, 'fixtures/example.md');
    const snapshot = path.join(directory, 'source.md');
    fs.writeFileSync(snapshot, fs.readFileSync(filename, 'utf8') +
      '\n<script>window.documentScriptRan = true</script>\n<img src="missing" onerror="window.documentScriptRan = true">\n');
    const reader = await createReader({ snapshot, filename, browser: process.env.MDREADER_BROWSER || 'chromium', zoom: 20 }, 900, 700);
    browser = reader.browser;
    const result = await reader.page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('pre code'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const localImage = document.querySelector('img[alt="本地图片"]');
      return {
        headings: [...document.querySelectorAll('h1,h2')].map(node => node.id),
        cells: document.querySelectorAll('td').length,
        checkbox: document.querySelector('input[type=checkbox]').checked,
        image: [new URL(localImage.src).protocol, localImage.naturalWidth],
        selected: getSelection().toString(),
        code: document.querySelector('pre code').textContent,
        unsafe: !!window.documentScriptRan || !!document.querySelector('[onerror], script'),
        size: getComputedStyle(document.documentElement).fontSize,
      };
    });
    assert.deepEqual(result.headings, ['markdown-阅读示例', '代码块']);
    assert.equal(result.cells, 4);
    assert.equal(result.checkbox, true);
    assert.deepEqual(result.image, ['file:', 420]);
    assert.equal(result.selected, 'print("你好，Vim!")');
    assert.equal(result.code, 'print("你好，Vim!")\n');
    assert.equal(result.unsafe, false);
    assert.equal(result.size, '20px');
  } finally {
    if (browser) await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('custom clipboard command receives large Unicode text literally on stdin', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdreader-clipboard-'));
  try {
    const output = path.join(directory, 'copied text.txt');
    const text = '中文 `literal` $(not-a-command) $HOME\n'.repeat(10000);
    await copyText(text, [process.execPath, '-e',
      "require('node:fs').writeFileSync(process.argv[1], require('node:fs').readFileSync(0))", output]);
    assert.equal(fs.readFileSync(output, 'utf8'), text);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
