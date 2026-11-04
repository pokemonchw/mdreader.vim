'use strict';

const { spawn } = require('node:child_process');

function write(command, text, argument = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...(argument ? [text] : [])],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('clipboard command timed out')); }, 3000);
    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.stderr.on('data', data => { error = (error + data).slice(-1000); });
    child.stdin.on('error', () => {}); // A command may fail before reading stdin.
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(error.trim() || `clipboard command exited with ${code}`));
    });
    child.stdin.end(argument ? undefined : text);
  });
}

async function copyText(text, command = []) {
  if (!Array.isArray(command) || command.some(arg => typeof arg !== 'string')) {
    throw new Error('g:mdreader_clipboard must be a list of command arguments');
  }
  if (command.length) return write(command, text);
  const candidates = [];
  if (process.env.WAYLAND_DISPLAY) candidates.push([['wl-copy'], false]);
  if (process.env.DISPLAY) candidates.push([['xclip', '-selection', 'clipboard'], false], [['xsel', '--clipboard', '--input'], false]);
  // Klipper's DBus API takes an argument; avoid the OS per-argument size limit.
  if (Buffer.byteLength(text) < 120000) {
    for (const executable of ['qdbus6', 'qdbus']) candidates.push([[executable,
      'org.kde.klipper', '/klipper', 'org.kde.klipper.klipper.setClipboardContents'], true]);
  }
  for (const [candidate, argument] of candidates) {
    try { await write(candidate, text, argument); return; } catch { /* Try the next installed provider. */ }
  }
  throw new Error('No clipboard provider available; install wl-clipboard/xclip or configure g:mdreader_clipboard.');
}

module.exports = { copyText };
