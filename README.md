# MX 文件管理器

一款开源的 Windows / macOS 桌面文件管理器(另有零安装的浏览器版),核心卖点:**点击任意常见格式的文件,主区域直接变成对应的查看器 / 编辑器 / 播放器**——图片、视频、音频、文档、电子书、压缩包,无需安装任何外部程序。

![平台](https://img.shields.io/badge/平台-Windows%20%7C%20macOS-blue)
![技术栈](https://img.shields.io/badge/React%2019-Electron%2032%2B-TypeScript-blue)
![CI](https://github.com/cherfyang/MXFM/actions/workflows/release.yml/badge.svg)

## 下载安装

到 [Releases](https://github.com/cherfyang/MXFM/releases) 下载对应平台的安装包:

| 文件 | 平台 |
| --- | --- |
| `MXFileManager-Setup-x.x.x.exe` | Windows(一键安装,自动创建桌面快捷方式) |
| `MXFileManager-x.x.x.dmg` | macOS |

每次推送 `v*` 标签(或在 [Actions](https://github.com/cherfyang/MXFM/actions/workflows/release.yml) 手动运行)都会自动构建两个平台的安装包并发布。

> 安装包未做代码签名:
>
> - **Windows**:首次运行如遇 SmartScreen 提示,点「仍要运行」即可。
> - **macOS**:首次打开若提示**「已损坏,无法打开,建议移到废纸篓」**,并非文件真的损坏,而是系统拦截了未签名的应用。打开前在终端执行下面一条命令即可(以后每次更新版本重新拖入后,需再执行一次):
>
>   ```bash
>   xattr -cr "/Applications/MX文件管理器.app"
>   ```

## 核心功能

### 🏠 主页 · 文件总览

启动时**自动扫描本机全部磁盘**,像手机文件管理器一样把文件分好类:

- 按 图片 / 视频 / 音频 / 文档 / 压缩包 / 电子书 六类统计数量与容量
- 「最近文件」跨分类按时间排序,点击直接打开
- 每次启动自动更新;也可一键重扫,结果本地缓存秒开

### 📁 文件管理

- 多标签页、可编辑面包屑路径(直接粘贴任意路径回车跳转)
- 详细列表 / 大图标双视图,虚拟滚动(十万级文件、两万行文本不卡)
- 排序 / 实时搜索 / 隐藏文件开关
- 新建 / 重命名(F2)/ 删除(进回收站)/ 复制 / 剪切 / 粘贴 / 拖拽移动
- 同名冲突处理(覆盖 / 跳过 / 保留两者)、撤销(Ctrl+Z)、操作进度条
- 空格键 QuickLook 式快速预览
- 右键菜单:在资源管理器 / Finder 中显示、用系统默认程序打开

### 👁 点击即开的查看器 / 编辑器

| 类别 | 格式 | 能力 |
| --- | --- | --- |
| 图片 | png jpg webp gif bmp svg avif ico · **tif/tiff · heic/heif(iPhone 照片)· psd** | 缩放 / 旋转 / 翻转 / 同类前后切换;TIFF、HEIC、PSD 自动解码(含缩略图) |
| 图片编辑 | 所有可显示格式 | 内置开源 **Filerobot 编辑器**:裁剪 / 标注 / 文字 / 滤镜,保存为新文件 |
| 视频 | mp4 webm mkv mov m4v ogv · **avi wmv flv mpg ts m2ts vob 3gp asf rm/rmvb f4v** | 内置播放器:倍速 / 截图 / 画中画 / 全屏 / 循环 / 记忆播放位置;冷门格式**自动 ffmpeg 转码**(优先秒级重封装) |
| 音频 | mp3 wav ogg flac m4a aac opus · **ape tta wv amr ac3 dts mka caf** | 播放 + 前后切换;冷门格式自动转码为 MP3 |
| 文本 / 代码 | 50+ 扩展名自动识别 | CodeMirror 6:语法高亮 / 查找替换 / Ctrl+S 保存 / GBK 自动检测 |
| Markdown | md | 编辑 + 实时分屏预览 |
| 表格 | csv · xlsx xls xlsm **xlsb ods dif sylk** | 多 sheet、单元格编辑、Ctrl+S 写回 |
| 文档 | pdf · docx · **epub 电子书** | PDF 翻页缩放;EPUB 分页阅读器(← → 翻页) |
| 压缩包 | **zip rar 7z tar gz/tgz bz2 xz** | 包内浏览、文件直接预览;ZIP 一键解压 |
| 旧版 Office | doc / ppt 等 | 引导用系统默认程序打开 |
| 未知 / 二进制 | 其他 | 内容嗅探:文本进编辑器,二进制进 HEX 查看器 |

### 🎨 界面

- 5 套主题:**深色 / 浅色(白天)/ 护眼绿 / 暖阳米黄 / 海洋深蓝**,编辑器配色随动
- 内存占用诊断面板(渲染进程堆、主进程内存、缓存指标)

## 快捷键

应用内随时按 `?` 弹出速查表(内容随平台自动切换 Win / mac 键位)。桌面版 `Ctrl` 即 macOS 的 `Cmd`。

**导航与定位**

| 键 | 功能 |
| --- | --- |
| `Alt+←` / `Alt+→` | 后退 / 前进 |
| `Backspace`(mac 另有 `⌘↑`) | 上一级 |
| `Alt+Home`(mac `⌘⇧H`) | 回主页 |
| `Ctrl+L`(mac 另有 `⌘⇧G`) | 编辑当前路径 |
| `Ctrl+F` | 搜索当前目录 |
| `Esc` | 逐级退出:菜单 → 预览 → 查看器 → 清除选择 |

**文件操作**

| 键 | 功能 |
| --- | --- |
| `Ctrl+C` / `X` / `V` | 复制 / 剪切 / 粘贴 |
| `Ctrl+A` | 全选 |
| `Ctrl+D` | 复制副本(原地生成「名称 (2)」) |
| `Ctrl+Z` / `Ctrl+Shift+Z`(Win 另有 `Ctrl+Y`) | 撤销 / 重做 |
| `F2` | 重命名 |
| `Delete` | 删除(进回收站/废纸篓) |
| `Shift+Delete`(mac `⌘⌫`) | 彻底删除(不进回收站,需二次确认) |
| `Ctrl+Shift+N` / `Ctrl+N` | 新建文件夹 / 新建文本文档 |
| `Enter` / `Space` | 打开 / 快速预览 |
| `Ctrl+O` | 用系统默认程序打开 |
| `Ctrl+Shift+R` | 在资源管理器 / Finder 中显示 |
| `Ctrl+Shift+.` | 显示 / 隐藏文件 |
| `F5` | 刷新(主页 = 重新扫描) |

**标签页与视图**

| 键 | 功能 |
| --- | --- |
| `Alt+T` | 新建标签页 |
| `Ctrl+W` | 关闭当前标签页(有未保存修改时确认) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`(mac `⌘⇧]` / `⌘⇧[`) | 下一个 / 上一个标签页 |
| `Alt+1` ~ `9`(mac `⌘1` ~ `⌘9`) | 跳转到第 N 个标签页 |
| `Ctrl+1` / `Ctrl+2`(仅 Windows) | 详细列表 / 大图标视图 |
| `Ctrl+,` | 更多选项菜单 |

**查看器内**

| 键 | 生效范围 | 功能 |
| --- | --- | --- |
| `Space` / `←` `→` / `↑` `↓` | 视频 | 播放暂停 / 快退快进 5 秒 / 音量 |
| `F` / `M` / `Esc` | 视频 | 全屏 / 静音 / 退出全屏 |
| `←` / `→` | 图片 / EPUB | 同类切换 / 翻页 |
| `+` / `−` / `0` | 图片 | 放大 / 缩小 / 复位 |
| `R` / `Shift+R` | 图片 | 顺时针 / 逆时针旋转 |
| `↑` / `↓` | 音频 | 音量 |
| `Ctrl+S` | 文本 / md / 表格 | 保存 |

## 桌面版 vs 浏览器版

| | 桌面版(Electron) | 浏览器版(Edge/Chrome) |
| --- | --- | --- |
| 文件访问 | 完整文件系统,免授权 | 需逐目录授权(句柄持久化) |
| 任意路径 | ✅ 面包屑直接输入 | ❌ 仅授权过的根 |
| 文件夹重命名 / 移动 | ✅ 原生瞬时 | 重建 + 迁移(大目录慢) |
| 删除 | ✅ 进回收站 | 永久删除 |
| 冷门格式播放 | ✅ 自动 ffmpeg 转码 | ❌ 仅原生格式 |
| 视频大文件 | ✅ 流式协议零拷贝 | blob URL |

两版共用同一套 UI 与全部查看器,差异全部被 `FSProvider` 接口隔离,运行时自动探测环境。

## 架构

```
UI 层   React 19 + Tailwind 4:主页 / 标签页 / 文件区 / 预览面板 / 查看器
应用层  Zustand:文件系统 / 分类扫描 / 撤销重做 / 快捷键 / 设置
服务层  FSProvider 接口 · 格式嗅探 · 图片解码网关 · 缩略图 LRU · ffmpeg 转码
适配层  ElectronProvider(Node fs + 流式协议) · FsaProvider(浏览器) · MemoryProvider(演示)
```

- Electron 壳(`electron/main.cjs`):IPC 文件操作、`mxfile://` 流式协议(大视频拖进度条秒切)、ffmpeg 转码服务、中文应用菜单、窗口状态记忆
- 格式解码全部基于成熟开源库:[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)(转码)、[utif](https://github.com/photopea/UTIF.js)(TIFF)、[heic-to](https://github.com/catdad-experiments/heic-to)(HEIC)、[ag-psd](https://github.com/Agamnentzar/ag-psd)(PSD)、[epub.js](https://github.com/futurepress/epub.js.js)(电子书)、[libarchive.js](https://github.com/nickolson-/libarchive.js)(RAR/7z/tar)、[Filerobot Image Editor](https://github.com/scaleflex/filerobot-image-editor)(图片编辑)

## 开发

```bash
npm install

npm run dev          # 浏览器版开发(localhost:5173)
npm run build        # 类型检查 + 构建渲染层
npm run app          # 打包当前平台安装包

# 桌面版开发:终端 1
npm run electron:dev # 启动 vite(5188)
# 终端 2
npx electron .

# 重新生成应用图标(SVG → ico/icns)
npx electron scripts/gen-icon.cjs
```

## 已知限制

- RAW 相机格式(CR2/NEF/ARW)、JPEG XL 暂不支持;旧版 .doc / .ppt 引导外部程序打开
- 冷门视频完整转码时大文件耗时较长(优先尝试秒级重封装)
- RAR / 7z 支持包内浏览与单文件提取,一键解压目前仅 ZIP
- Excel 保存会丢失单元格样式与公式(SheetJS 重写文件)
- 安装包未签名(见上)

## 路线图

- [ ] FileSystemObserver 实时刷新(文件变更免手动刷新)
- [ ] PPTX 只读预览
- [ ] 全局递归搜索、批量重命名、文件标签
- [ ] 视频转码进度百分比
- [ ] 安装包代码签名

## License

MIT
