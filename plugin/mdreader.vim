" Browser-quality Markdown reading inside the current terminal Vim window.
if exists('g:loaded_mdreader') || &compatible
  finish
endif
let g:loaded_mdreader = 1

command! MDReaderToggle call mdreader#toggle()
nnoremap <silent> <Plug>(MDReaderToggle) <Cmd>call mdreader#toggle()<CR>
inoremap <silent> <Plug>(MDReaderToggle) <Esc><Cmd>call mdreader#toggle()<CR>
xnoremap <silent> <Plug>(MDReaderToggle) <Esc><Cmd>call mdreader#toggle()<CR>

" Route clicks into a preview even when another split has keyboard focus.
" Preserve existing mouse mappings and pass through clicks outside previews.
if get(g:, 'mdreader_mouse', 1)
  for [s:lhs, s:kind] in [['<LeftMouse>','down'], ['<2-LeftMouse>','down'], ['<3-LeftMouse>','down'],
        \ ['<LeftDrag>','drag'], ['<LeftRelease>','up'], ['<ScrollWheelUp>','wheelup'], ['<ScrollWheelDown>','wheeldown']]
    if empty(maparg(s:lhs, 'n'))
      execute 'nnoremap <silent><expr> ' . s:lhs . ' mdreader#mouse_route(' . string(s:kind) . ', "\' . s:lhs . '")'
    endif
  endfor
endif

augroup mdreader
  autocmd!
  autocmd FileType markdown call mdreader#setup()
  autocmd BufWinLeave * call mdreader#leaving(str2nr(expand('<abuf>')))
  autocmd VimResized,WinEnter,BufWinEnter,TabEnter * call mdreader#sync()
  autocmd CmdlineLeave * call mdreader#paint()
  if exists('##WinResized')
    autocmd WinResized * call mdreader#sync()
  endif
  if exists('##SafeState')
    autocmd SafeState * call mdreader#paint()
  endif
  autocmd VimSuspend * call mdreader#hide()
  autocmd VimResume,ShellCmdPost * call mdreader#sync()
  autocmd VimLeavePre * call mdreader#shutdown()
augroup END
if &filetype ==# 'markdown' | call mdreader#setup() | endif
