'use strict';

// Replace one existing placement only after the complete PNG has arrived.
// No palette conversion, clear-screen escape, or intermediate blank frame.
const IMAGE_ID = 917031;
function pngFrame(base64, { row = 1, col = 1, id = IMAGE_ID } = {}) {
  const parts = [`\x1b[${row};${col}H`];
  for (let offset = 0; offset < base64.length; offset += 4096) {
    const more = offset + 4096 < base64.length ? 1 : 0;
    const options = offset === 0
      ? `a=T,f=100,i=${id},p=1,q=2,C=1,m=${more}`
      : `q=2,m=${more}`;
    parts.push(`\x1b_G${options};${base64.slice(offset, offset + 4096)}\x1b\\`);
  }
  return parts.join('');
}
const deleteFrame = `\x1b_Ga=d,d=I,i=${IMAGE_ID},q=2;\x1b\\`;

// Preserve clicks/releases, but replace consecutive mouse moves with the newest
// position. A slow render must never turn a drag into seconds of queued input.
class InputQueue {
  constructor() { this.items = []; }
  push(run, kind = 'action') {
    const last = this.items[this.items.length - 1];
    if (kind === 'move' && last?.kind === 'move') last.run = run;
    else this.items.push({ run, kind });
  }
  take() { return this.items.splice(0); }
}

module.exports = { pngFrame, deleteFrame, InputQueue };
