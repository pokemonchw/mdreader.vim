" mdreader.vim: window-local browser rendering and input routing.
let s:root = fnamemodify(expand('<sfile>:p'), ':h:h')
let s:sessions = {}
let s:watch = -1
let s:directories = {}
let s:drag = -1
let s:window_options = ['number', 'relativenumber', 'signcolumn', 'foldcolumn', 'foldenable', 'wrap', 'list', 'cursorline', 'cursorcolumn', 'colorcolumn', 'statusline', 'conceallevel', 'scrolloff']

function! s:WindowView(win) abort
  let l:info = getwininfo(a:win)
  if empty(l:info)
    return {}
  endif
  let l:i = l:info[0]
  let l:cell = exists('*getcellpixels') ? getcellpixels() : []
  if len(l:cell) != 2 || min(l:cell) <= 0
    let l:cell = [9, 18]
  endif
  return {'row': l:i.winrow + l:i.winbar, 'col': l:i.wincol,
        \ 'rows': l:i.height, 'cols': l:i.width,
        \ 'cellWidth': l:cell[0], 'cellHeight': l:cell[1]}
endfunction

function! s:Send(session, message) abort
  if has_key(a:session, 'job') && job_status(a:session.job) ==# 'run'
    call ch_sendraw(job_getchannel(a:session.job), json_encode(a:message) . "\n")
  endif
endfunction

function! s:Erase(session, ...) abort
  let l:kind = a:0 && a:1 ? 'I' : 'i'
  call echoraw("\e_Ga=d,d=" . l:kind . ',i=' . a:session.imageId . ",q=2;\e\\")
  let a:session.visible = 0
endfunction

function! s:CanPaint(session) abort
  let l:info = getwininfo(a:session.win)
  if empty(l:info) || l:info[0].bufnr != a:session.buf || l:info[0].tabnr != tabpagenr()
    return 0
  endif
  " Do not paint over Vim popups (including NERDTree previews).
  let l:v = a:session.view
  for l:id in popup_list()
    let l:p = popup_getpos(l:id)
    if get(l:p, 'visible', 0) && l:p.line < l:v.row + l:v.rows && l:p.line + l:p.height > l:v.row
          \ && l:p.col < l:v.col + l:v.cols && l:p.col + l:p.width > l:v.col
      return 0
    endif
  endfor
  return 1
endfunction

function! s:Paint(session) abort
  if empty(a:session.frame) || !s:CanPaint(a:session)
    return
  endif
  if a:session.upload
    let l:output = a:session.frame
    let a:session.upload = 0
  else
    " Re-show the already uploaded image after a Vim redraw: only a few bytes.
    let l:output = "\e[" . a:session.view.row . ';' . a:session.view.col . 'H'
          \ . "\e_Ga=p,i=" . a:session.imageId . ",p=1,q=2,C=1;\e\\"
  endif
  call echoraw("\e7" . l:output . "\e8")
  let a:session.visible = 1
endfunction

function! s:RestoreOptions(session) abort
  if !empty(getwininfo(a:session.win))
    for [l:name, l:value] in items(a:session.options)
      call setwinvar(a:session.win, '&' . l:name, l:value)
    endfor
  endif
endfunction

function! s:Close(buf, restore) abort
  if !has_key(s:sessions, a:buf)
    return
  endif
  let l:s = remove(s:sessions, a:buf)
  if empty(s:sessions) && s:watch != -1
    call timer_stop(s:watch)
    let s:watch = -1
  endif
  if s:drag == a:buf | let s:drag = -1 | endif
  call s:Erase(l:s, 1)
  call setbufvar(l:s.source, 'mdreader_state', l:s.state)
  call s:Send(l:s, {'type': 'quit'})
  " A slow browser must not hold up returning to source or closing a window.
  if has_key(l:s, 'job')
    call timer_start(1500, {-> job_status(l:s.job) ==# 'run' ? job_stop(l:s.job) : 0})
  endif
  call s:RestoreOptions(l:s)
  if a:restore && bufexists(l:s.source) && !empty(getwininfo(l:s.win))
    call win_execute(l:s.win, 'hide buffer ' . l:s.source)
    call win_execute(l:s.win, 'call winrestview(' . string(l:s.sourceView) . ')')
  endif
  if bufexists(l:s.buf) && empty(win_findbuf(l:s.buf))
    execute 'silent! bwipeout! ' . l:s.buf
  endif
  " Keep the snapshot alive until a renderer still starting up has shut down.
  call timer_start(2000, {-> s:Cleanup(l:s.directory)})
  redraw
endfunction

function! s:Receive(buf, channel, line) abort
  if !has_key(s:sessions, a:buf) | return | endif
  let l:s = s:sessions[a:buf]
  try
    let l:m = json_decode(a:line)
    if l:m.type ==# 'frame'
      if l:m.version != l:s.view.version | return | endif
      let l:s.frame = l:m.data
      let l:s.upload = 1
      redraw
      call s:Paint(l:s)
    elseif l:m.type ==# 'status' || l:m.type ==# 'closed'
      let l:s.state = {'y': l:m.y, 'zoom': l:m.zoom}
      if l:m.type ==# 'closed'
        call s:Close(a:buf, 1)
      else
        call setbufvar(a:buf, 'mdreader_status', l:m.text)
        redrawstatus
        call s:Paint(l:s)
      endif
    endif
  catch
    let l:s.error = v:exception
  endtry
endfunction

function! s:Error(buf, channel, line) abort
  if has_key(s:sessions, a:buf)
    let s:sessions[a:buf].error = a:line
  endif
endfunction

function! s:Exited(buf, job, status) abort
  if has_key(s:sessions, a:buf)
    let l:error = get(s:sessions[a:buf], 'error', '')
    call s:Close(a:buf, 1)
    if a:status != 0
      echohl ErrorMsg | echom 'Markdown 阅读器：' . l:error | echohl None
    endif
  endif
endfunction

function! mdreader#sync(...) abort
  for l:s in values(copy(s:sessions))
    let l:info = getwininfo(l:s.win)
    if empty(l:info) || l:info[0].bufnr != l:s.buf
      call s:Close(l:s.buf, 0)
      continue
    endif
    if l:info[0].tabnr != tabpagenr()
      if l:s.visible | call s:Erase(l:s) | endif
      continue
    endif
    let l:view = s:WindowView(l:s.win)
    let l:previous = copy(l:s.view)
    call remove(l:previous, 'version')
    if l:view != l:previous
      call s:Erase(l:s)
      let l:view.version = l:s.view.version + 1
      let l:s.view = l:view
      let l:s.frame = ''
      call s:Send(l:s, {'type': 'view', 'view': l:view})
    elseif !s:CanPaint(l:s)
      if l:s.visible | call s:Erase(l:s) | endif
    elseif !l:s.visible
      call s:Paint(l:s)
    endif
  endfor
endfunction

function! mdreader#paint() abort
  for l:s in values(s:sessions)
    call s:Paint(l:s)
  endfor
endfunction

function! mdreader#key(key) abort
  if has_key(s:sessions, bufnr('%'))
    call s:Send(s:sessions[bufnr('%')], {'type': 'key', 'key': a:key})
  endif
endfunction

function! mdreader#search() abort
  call inputsave()
  try
    let l:query = input('搜索: ')
  finally
    call inputrestore()
  endtry
  if !empty(l:query)
    call mdreader#key('/' . l:query . "\r")
  endif
  redraw
  call mdreader#paint()
endfunction

function! mdreader#mouse_route(kind, fallback) abort
  let l:m = getmousepos()
  let l:buf = winbufnr(l:m.winid)
  if a:kind !=# 'down' && s:drag > 0 && index(['drag', 'up'], a:kind) >= 0
    let l:buf = s:drag
  endif
  if !has_key(s:sessions, l:buf)
    return a:fallback
  endif
  let l:s = s:sessions[l:buf]
  let l:row = l:m.screenrow - l:s.view.row + 1
  let l:col = l:m.screencol - l:s.view.col + 1
  if index(['down', 'wheelup', 'wheeldown'], a:kind) >= 0
        \ && (l:row < 1 || l:row > l:s.view.rows || l:col < 1 || l:col > l:s.view.cols)
    return a:fallback
  endif
  let l:row = max([1, min([l:s.view.rows, l:row])])
  let l:col = max([1, min([l:s.view.cols, l:col])])
  return "\<Cmd>call mdreader#mouse(" . string(a:kind) . ',' . l:buf . ',' . l:row . ',' . l:col . ")\<CR>"
endfunction

function! mdreader#mouse(kind, buf, row, col) abort
  if !has_key(s:sessions, a:buf) | return | endif
  let l:s = s:sessions[a:buf]
  if a:kind ==# 'down'
    call win_gotoid(l:s.win)
    let s:drag = a:buf
  elseif a:kind ==# 'up'
    let s:drag = -1
  endif
  let l:button = get({'down': 0, 'drag': 32, 'up': 0, 'wheelup': 64, 'wheeldown': 65}, a:kind, 0)
  let l:key = "\e[<" . l:button . ';' . a:col . ';' . a:row . (a:kind ==# 'up' ? 'm' : 'M')
  call s:Send(l:s, {'type': 'key', 'key': l:key})
endfunction

function! mdreader#toggle() abort
  if has_key(s:sessions, bufnr('%'))
    call s:Close(bufnr('%'), 1)
    return
  endif
  if &filetype !=# 'markdown' || &buftype !=# '' | return | endif
  if !s:Ready() | return | endif
  let l:node = get(g:, 'mdreader_node', 'node')
  let l:browser = s:Browser()
  let l:s = {'source': bufnr('%'), 'win': win_getid(), 'sourceView': winsaveview(),
        \ 'directory': tempname(), 'options': {}, 'frame': '', 'upload': 0, 'visible': 0, 'error': ''}
  for l:name in s:window_options
    let l:s.options[l:name] = eval('&l:' . l:name)
  endfor
  let l:s.state = get(b:, 'mdreader_state', {'y': 0, 'zoom': max([12, min([36, get(g:, 'mdreader_font_size', 18)])])})
  call mkdir(l:s.directory, '', 0700)
  let s:directories[l:s.directory] = 1
  call writefile(getline(1, '$'), l:s.directory . '/source.md')
  let l:filename = empty(expand('%:p')) ? getcwd() . '/未命名.md' : expand('%:p')
  " Give the scratch buffer a name before BufEnter: existing MRU plugins use
  " <afile> and cannot handle an unnamed :enew buffer here.
  let l:preview = bufadd('mdreader://' . l:s.source . '-' . l:s.win)
  call setbufvar(l:preview, '&buftype', 'nofile')
  call setbufvar(l:preview, '&bufhidden', 'wipe')
  execute 'hide buffer ' . l:preview
  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted
  setlocal nonumber norelativenumber signcolumn=no foldcolumn=0 nofoldenable nowrap nolist
  setlocal nocursorline nocursorcolumn colorcolumn= conceallevel=0 scrolloff=0
  let b:mdreader_status = '正在排版 Markdown…'
  setlocal statusline=%{get(b:,'mdreader_status','Markdown')}
  call setline(1, '正在排版 Markdown…')
  setlocal nomodifiable
  setfiletype mdreader
  let l:s.buf = bufnr('%')
  let l:s.imageId = 917031 + l:s.buf
  let l:s.view = s:WindowView(l:s.win)
  let l:s.view.version = 1
  let s:sessions[l:s.buf] = l:s
  let l:config = {'embedded': v:true, 'view': l:s.view, 'imageId': l:s.imageId,
        \ 'snapshot': l:s.directory . '/source.md', 'filename': l:filename,
        \ 'state': l:s.directory . '/state.json', 'y': l:s.state.y, 'zoom': l:s.state.zoom,
        \ 'browser': exepath(l:browser), 'clipboard': get(g:, 'mdreader_clipboard', [])}
  call writefile([json_encode(l:config)], l:s.directory . '/config.json')
  for l:lhs in ['q', '<Esc>']
    execute 'nnoremap <silent><buffer> ' . l:lhs . ' <Cmd>call mdreader#toggle()<CR>'
  endfor
  for [l:lhs, l:key] in [['j','j'], ['k','k'], ['<Down>',"\e[B"], ['<Up>',"\e[A"],
        \ ['<Space>',' '], ['b','b'], ['<C-f>',"\x06"], ['<C-b>',"\x02"],
        \ ['<C-d>',"\x04"], ['<C-u>',"\x15"], ['<PageDown>',"\e[6~"], ['<PageUp>',"\e[5~"],
        \ ['g','g'], ['G','G'], ['<Home>',"\e[H"], ['<End>',"\e[F"], ['+','+'], ['=','='], ['-','-'],
        \ ['n','n'], ['N','N'], ['y','y'], ['<C-c>',"\x03"], ['r','r'], ['<C-l>',"\x0c"]]
    execute 'nnoremap <silent><buffer> ' . l:lhs . ' <Cmd>call mdreader#key(' . string(l:key) . ')<CR>'
  endfor
  nnoremap <silent><buffer> / <Cmd>call mdreader#search()<CR>
  call mdreader#setup()
  let l:s.job = job_start([exepath(l:node), s:root . '/renderer/reader.cjs', l:s.directory . '/config.json'],
        \ {'in_mode': 'raw', 'out_mode': 'nl', 'err_mode': 'nl', 'stoponexit': 'term',
        \ 'out_cb': function('s:Receive', [l:s.buf]), 'err_cb': function('s:Error', [l:s.buf]),
        \ 'exit_cb': function('s:Exited', [l:s.buf])})
  if s:watch == -1
    let s:watch = timer_start(150, function('mdreader#sync'), {'repeat': -1})
  endif
  if job_status(l:s.job) ==# 'fail'
    call s:Close(l:s.buf, 1)
    echoerr '无法启动 Markdown 阅读器。'
  endif
endfunction

function! mdreader#leaving(buf) abort
  if has_key(s:sessions, a:buf)
    let l:s = s:sessions[a:buf]
    " :split file briefly clones the preview into the new window. Leaving
    " that clone must not close the preview still visible in its own window.
    if l:s.win != win_getid() && winbufnr(l:s.win) == a:buf
      call s:RestoreOptions({'win': win_getid(), 'options': l:s.options})
      return
    endif
  endif
  call s:Close(a:buf, 0)
endfunction

function! mdreader#hide() abort
  for l:s in values(s:sessions)
    if l:s.visible | call s:Erase(l:s) | endif
  endfor
endfunction

function! s:Cleanup(directory) abort
  call delete(a:directory, 'rf')
  if has_key(s:directories, a:directory) | call remove(s:directories, a:directory) | endif
endfunction

function! mdreader#shutdown() abort
  for l:s in values(copy(s:sessions))
    call s:Close(l:s.buf, 0)
  endfor
  for l:directory in keys(s:directories)
    call s:Cleanup(l:directory)
  endfor
endfunction

function! mdreader#setup() abort
  if !get(g:, 'mdreader_default_mappings', 1) | return | endif
  for l:mode in ['n', 'i', 'x']
    for l:lhs in ['<S-F2>', '<F14>']
      if empty(maparg(l:lhs, l:mode))
        execute l:mode . 'map <silent><buffer> ' . l:lhs . ' <Plug>(MDReaderToggle)'
      endif
    endfor
  endfor
endfunction

function! s:Browser() abort
  if exists('g:mdreader_browser') | return g:mdreader_browser | endif
  for l:command in ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
    if executable(l:command) | return l:command | endif
  endfor
  return ''
endfunction

function! s:Ready() abort
  if has('nvim') || has('gui_running') || !has('job') || !has('channel') || !has('timers')
        \ || !exists('*echoraw') || !exists('*getcellpixels') || !exists('*getmousepos')
        \ || !exists('*popup_list') || !exists('##WinResized') || !exists('##SafeState')
    echoerr 'mdreader: requires terminal Vim with jobs, channels, timers and getcellpixels() (tested on Vim 9.2).'
    return 0
  endif
  if !executable(get(g:, 'mdreader_node', 'node'))
    echoerr 'mdreader: Node.js is missing; install Node.js 20.19+ or set g:mdreader_node.'
    return 0
  endif
  if empty(s:Browser()) || !executable(s:Browser())
    echoerr 'mdreader: Chromium is missing; install Chromium or set g:mdreader_browser.'
    return 0
  endif
  if !isdirectory(s:root . '/node_modules/playwright-core')
    echoerr 'mdreader: dependencies are missing; run npm ci in ' . s:root
    return 0
  endif
  return 1
endfunction
