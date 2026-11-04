"""Real Vim job/PTY integration, without touching desktop or system clipboard."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent


def vim_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def run(directory):
    source = directory / '中文 example.md'
    shutil.copy(ROOT / 'test/fixtures/example.md', source)
    shutil.copy(ROOT / 'test/fixtures/image.svg', directory / 'image.svg')
    sidebar = directory / 'sidebar.txt'
    sidebar.write_text('文件树\n项目目录\nREADME.md\n')
    other = directory / 'other.txt'
    other.write_text('Other split remains editable\n')
    clipboard = directory / 'clipboard.txt'
    receiver = directory / 'clipboard.py'
    receiver.write_text('import sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_bytes(sys.stdin.buffer.read())\n')
    init = directory / 'init.vim'
    init.write_text(f"""set nocompatible
set mouse=a laststatus=2 ttimeout ttimeoutlen=100
execute 'set runtimepath^=' . fnameescape({vim_string(ROOT)})
let g:mdreader_clipboard = [{vim_string(sys.executable)}, {vim_string(receiver)}, {vim_string(clipboard)}]
let g:mdreader_browser = {vim_string(os.environ.get('MDREADER_BROWSER', 'chromium'))}
runtime plugin/mdreader.vim
filetype plugin indent on
""")
    setup = directory / 'setup.vim'
    setup.write_text(f"""call append(2, '未保存的中文修改')
call cursor(9, 3)
let g:source_buffer = bufnr('%')
let g:source_state = {{'cursor':getpos('.'),'modified':&modified,'undo':changenr(),'text':getline(1,'$'),'number':&number,'wrap':&wrap,'statusline':&l:statusline}}
execute 'topleft 24vsplit ' . fnameescape({vim_string(sidebar)})
wincmd p
function! DumpState(file) abort
  let windows = []
  for info in getwininfo()
    let info.ft = getbufvar(info.bufnr, '&filetype')
    call add(windows, info)
  endfor
  call writefile([json_encode({{'windows':windows,'current':win_getid(),'buf':bufnr('%'),'source':g:source_buffer,'name':bufname('%'),'ft':&filetype,'cursor':getpos('.'),'modified':&modified,'undo':changenr(),'text':getline(1,'$'),'number':&number,'wrap':&wrap,'statusline':&l:statusline,'original':g:source_state,'messages':execute('messages')}})],a:file)
endfunction
""")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 1440, 900))
    process = subprocess.Popen([os.environ.get('VIM', 'vim'), '-N', '-u', str(init), '-n', '-i', 'NONE', str(source), '-S', str(setup)],
                               stdin=slave, stdout=slave, stderr=slave,
                               env={**os.environ, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'})
    os.close(slave)
    log = bytearray()

    def pump(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            ready, _, _ = select.select([master], [], [], min(.03, max(0, end - time.monotonic())))
            if ready:
                try:
                    data = os.read(master, 1048576)
                except OSError:
                    return
                if not data:
                    return
                log.extend(data)

    def send(data):
        os.write(master, data.encode() if isinstance(data, str) else data)

    def wait(predicate, message, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            pump(.05)
            if predicate():
                return
        raise AssertionError(message)

    def dump():
        output = directory / 'state.json'
        output.unlink(missing_ok=True)
        send(':call DumpState(' + vim_string(output) + ')\r')
        wait(output.exists, 'Vim stopped responding')
        return json.loads(output.read_text())

    def previews(state):
        return [window for window in state['windows'] if window['ft'] == 'mdreader']

    def frames():
        result, chunks, anchor = [], [], None
        for match in re.finditer(rb'\x1b_G([^;]*);([^\x1b]*)\x1b\\', log):
            if b'a=T,f=100' in match[1]:
                chunks = []
                positions = re.findall(rb'\x1b\[(\d+);(\d+)H', log[max(0, match.start()-30):match.start()])
                anchor = tuple(map(int, positions[-1])) if positions else None
            elif not match[1].startswith(b'q=2,m='):
                continue
            chunks.append(match[2])
            if b'm=0' in match[1]:
                png = base64.b64decode(b''.join(chunks))
                result.append((anchor, struct.unpack('>II', png[16:24])))
        return result

    try:
        pump(.4)
        send(b'\x1b[1;2Q')
        wait(lambda: bool(frames()), 'No rendered PNG arrived')
        first = dump()
        preview = previews(first)[0]
        assert len(first['windows']) == 2 and preview['wincol'] > 24, first
        anchor, dimensions = frames()[0]
        assert anchor == (preview['winrow'], preview['wincol']), (anchor, preview)
        assert dimensions == (preview['width'] * 9, preview['height'] * 18), (dimensions, preview)

        send(b'\x17hj')
        pump(.15)
        left = dump()
        assert left['name'].endswith('sidebar.txt') and len(previews(left)) == 1
        right = (dimensions[0] + min(dimensions[0], 1100)) / 2 - 54
        col = preview['wincol'] + int((right - 38) / 9)
        row = preview['winrow'] + int(43 / 18)
        send(f'\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m')
        wait(clipboard.exists, 'Cross-split mouse copy failed')
        assert '未保存的中文修改' in clipboard.read_text() and '代码块' in clipboard.read_text()
        assert dump()['current'] == preview['winid']

        send(':vertical resize 60\r')
        wait(lambda: frames()[-1][1][0] == 60 * 9, 'Preview did not resize horizontally')
        narrow = dump()
        send(':execute "belowright split " . fnameescape(' + vim_string(other) + ')\r')
        wait(lambda: frames()[-1][1][1] < dimensions[1], 'Preview did not resize vertically')
        three = dump()
        assert len(three['windows']) == 3 and len(previews(three)) == 1, three
        assert three['name'].endswith('other.txt')
        assert previews(three)[0]['height'] < previews(narrow)[0]['height']

        send(b'\x17k\x1b[1;2Q')
        pump(.2)
        back = dump()
        assert not previews(back) and back['buf'] == back['source'], back
        for key, value in back['original'].items():
            assert back[key] == value, key
        assert not re.search(r'\bE\d+:', back['messages']), back['messages']
        send(':qa!\r')
        process.wait(timeout=5)
        assert process.returncode == 0
        print('PASS: Shift+F2; PNG bounds; sibling navigation; DOM copy of unsaved text; horizontal/vertical resize; source, undo and window options restored.')
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix='mdreader-vim-') as temporary:
    run(Path(temporary))
