# mdreader.vim

在 **Vim 当前分屏**中阅读浏览器排版的 Markdown。按 **Shift+F2** 在原始文本和阅读视图之间切换，文件树、其他分屏和 Vim 状态栏仍可使用。

Chromium 负责排版，终端通过 Kitty graphics 协议显示图像；鼠标操作传到浏览器 DOM，因此拖选的文字可以复制到系统剪贴板。

## 功能

- 标题、表格、任务列表、引用、脚注、代码高亮和本地/远程图片。
- 中文排版、深色样式、可调整字号；相对图片路径按 Markdown 原文件目录解析。
- 拖选松开即复制，支持双击选词、三击选段，以及“复制代码”“复制全文”。
- 搜索、滚动、页内锚点；点击外部链接用系统默认应用打开。
- 预览当前缓冲区的未保存内容；返回后保留光标、修改状态、撤销历史和原窗口选项。
- 预览尺寸随当前分屏变化；拖动事件合并，画面直接更新已有图像，避免逐帧清屏。

## 环境要求

已在 **Linux、Vim 9.2、Konsole 26.08.2、Chromium 155、Node.js 26** 上验证。

- 终端 Vim，支持 `+job`、`+channel`、`+timers`、`getcellpixels()`、`echoraw()`、`WinResized` 和 popup API。建议 Vim 9.2。
- 支持 Kitty graphics 协议 PNG 传输与图像放置的终端；目前以 Konsole 为验证目标。
- Node.js **20.19+**、npm，以及系统安装的 Chromium / Google Chrome。
- 复制功能需要 `wl-copy`、`xclip`、`xsel`，或 KDE Klipper + `qdbus6` / `qdbus`；也可设置自定义命令。
- 鼠标操作需在 vimrc 中设置 `set mouse=a`。打开外部链接需要 `xdg-open`。

Neovim、GUI Vim 和 tmux/screen 透传尚未支持或验证。显示用的是图像，复制由插件读取 DOM 文字完成；终端自身的 Shift+拖选无法提取图像里的文字。语法采用 markdown-it 默认规则，加任务列表和脚注扩展，并非完整复刻 GitHub 的所有扩展；暂不渲染 Mermaid、数学公式或文档内脚本。

## 安装

### vim-plug

在 `plug#begin()` 与 `plug#end()` 之间加入：

```vim
Plug 'pokemonchw/mdreader.vim', { 'do': 'npm ci' }
```

执行 `:PlugInstall`。运行时使用系统浏览器，安装依赖不会下载 Chromium。

### Vim 原生 packages

```sh
git clone https://github.com/pokemonchw/mdreader.vim.git ~/.vim/pack/mdreader/start/mdreader.vim
cd ~/.vim/pack/mdreader/start/mdreader.vim
npm ci
```

生成帮助索引：

```vim
:helptags ~/.vim/pack/mdreader/start/mdreader.vim/doc
```

确保 vimrc 启用文件类型识别和鼠标：

```vim
filetype plugin indent on
set mouse=a
```

## 使用

打开 `.md` 文件后按 **Shift+F2**，再次按下返回原文，也可执行 `:MDReaderToggle`。部分终端把 Shift+F2 识别为 F14，插件同时提供该映射。已有按键映射会保留。

| 操作 | 按键 / 鼠标 |
| --- | --- |
| 返回原文 | Shift+F2、`q`、Esc |
| 滚动 | 滚轮、`j` / `k`、方向键 |
| 翻页 / 半页 | Space / `b`、Ctrl+F / Ctrl+B、Ctrl+D / Ctrl+U |
| 文首 / 文末 | `gg` / `G`、Home / End |
| 字号 | `+` / `-`（12–36 px） |
| 搜索 / 下一个 / 上一个 | `/`、`n` / `N` |
| 复制选中文字 | 拖选松开自动复制；`y` 或 Ctrl+C 再次复制 |
| 复制代码 / 全文 | 点击相应按钮 |
| 重绘 | `r` 或 Ctrl+L |
| 切换其他分屏 | Vim 原有 Ctrl+W 系列按键 |

预览取自切换时的缓冲区快照。在另一个分屏修改源文件后，返回原文再进入阅读模式即可更新内容；`r` 只重绘现有快照。

## 配置

以下均为可选项，放在 vimrc 中：

```vim
" 可执行文件名或绝对路径；包含空格的路径不需要 shell 转义。
let g:mdreader_node = 'node'
let g:mdreader_browser = '/usr/bin/chromium'

" 默认 18，允许 12–36；每个源缓冲区记住本次会话中的字号和滚动位置。
let g:mdreader_font_size = 18

" 默认自动检测；自定义命令以参数列表传入，UTF-8 文本写入其标准输入。
let g:mdreader_clipboard = ['wl-copy']

" 禁用默认 Shift+F2 / F14 映射，改用自定义按键。
let g:mdreader_default_mappings = 0
nmap <Leader>m <Plug>(MDReaderToggle)

" 默认 1；设为 0 可禁用插件的全局鼠标路由。
let g:mdreader_mouse = 1
```

未指定浏览器时依次查找 `chromium`、`chromium-browser`、`google-chrome`、`google-chrome-stable`。自动剪贴板依次尝试当前桌面可用的 `wl-copy`、`xclip`、`xsel`、Klipper。Klipper 对超长文本的参数长度有限制，复制大文档时可使用接收标准输入的提供程序。

插件不会覆盖原文的配色、折叠或隐藏标记设置。若希望原文始终显示全部 Markdown 标记，可额外设置：

```vim
autocmd FileType markdown setlocal conceallevel=0
```

## 说明与排错

- 阅读模式只覆盖源文件所在窗口的文本区域。关闭该分屏、切换缓冲区或退出 Vim 会释放预览。
- 插件保留已有全局鼠标映射。若别的插件占用了左键或滚轮，可用 `:verbose nmap <LeftMouse>` 查看冲突。
- 若只能看到“正在排版 Markdown…”而没有画面，先检查终端的 Kitty graphics 支持；`:messages` 显示浏览器启动或依赖错误。
- 文档 HTML 会经过过滤，文档脚本不会执行。相对图片保留本地访问，远程图片会向相应地址发起请求。
- 预览无需本地 HTTP 服务；临时文件位于私有目录，关闭预览后清理。
- 进一步说明见 `:help mdreader`。

## 开发

```sh
npm ci
npm test
npm run test:vim
```

测试需要系统 Chromium；Vim 集成测试还需要 Python 3 和满足上述要求的 Vim。集成测试使用独立伪终端和临时剪贴板接收器，不操作桌面窗口或覆盖系统剪贴板。
