# MX File Manager 设计方案

> 目标:用纯前端技术做一个比 Windows 资源管理器好用的文件管理器。核心差异化:**点击任意常见格式的文件,原地变成查看器 / 编辑器 / 播放器**。

---

## 1. 关键决策:"纯前端"的形态

浏览器沙箱不允许网页随意读写磁盘,所以必须先明确产品形态。三条路线:

| | A. 纯浏览器应用 | B. Tauri 桌面应用 | C. Electron 桌面应用 |
|---|---|---|---|
| 文件访问 | File System Access API(Edge/Chrome) | 完整文件系统 | 完整文件系统 |
| 安装 | 零安装,打开即用 | ~10MB 安装包 | ~150MB 安装包 |
| 任意路径访问 | ❌ 只能授权目录 | ✅ | ✅ |
| 文件夹重命名 / 跨盘移动 | ❌ 受限 | ✅ | ✅ |
| 双击系统文件直接打开 | ⚠️ PWA file handler 可近似 | ✅ | ✅ |
| 技术栈 | 100% 前端 | 前端 + 少量 Rust 配置 | 前端 + Node |

**推荐:按 A 开发,架构上预留 B。** 理由:你的核心诉求(点击即看、即播、即编辑)在浏览器里体验几乎无损;真正的短板只在"文件夹重命名、跨盘移动、任意路径"这类低频管理操作。通过 FS Provider 抽象层(见下),以后想升级 Tauri 时,UI 和全部查看器一行不改。

## 2. 总体架构

四层分层,核心是第三层的 FS Provider 接口:

```
┌─────────────────────────────────────────────────────┐
│ UI 层   React + TS:工作区 / 标签页 / 文件区 / 预览面板   │
├─────────────────────────────────────────────────────┤
│ 应用层  Zustand 状态 · 命令系统(撤销重做) · 快捷键       │
├─────────────────────────────────────────────────────┤
│ 服务层  FS Provider 接口 · 格式探测 · 缩略图 · 搜索       │
├─────────────────────────────────────────────────────┤
│ 适配层  FSA Provider(浏览器) · Tauri Provider(预留)    │
└─────────────────────────────────────────────────────┘
```

全部 UI 只依赖这个接口,不感知文件系统来自浏览器还是桌面壳:

```ts
interface FSProvider {
  addRoot(mode): Promise<RootHandle>       // 授权一个根目录
  list(dir): AsyncIterable<FileEntry>      // 流式枚举,大目录不卡
  stat(path): Promise<FileStat>
  read(path): Promise<ReadableStream>      // 大文件流式读
  write(path): Promise<WritableStream>     // 流式写回(编辑保存)
  mkdir(path): Promise<void>
  rename / move / copy / remove(...): Promise<void>
  watch?(dir, cb): Unsubscribe             // 浏览器可选,桌面壳必有
}
```

A 形态下根目录的来源:① "添加文件夹"选择器;② 从资源管理器**拖拽文件夹**进窗口;③ 授权句柄存 IndexedDB,下次启动自动恢复。

## 3. UI 设计

```
┌────────────────────────────────────────────────────────┐
│ ← → ↑ │ 面包屑 / 路径栏(可编辑) │ 🔍 搜索 │ 视图切换  ⚙    │
├─────────┬────────────────────────────────┬─────────────┤
│ 收藏夹   │  [标签1] [标签2] [+]             │             │
│ 磁盘     │                                │  预览面板     │
│ 颜色标签 │   详细列表 / 大图标 / 超大图标      │  (可折叠)     │
│ 最近文件 │   (虚拟滚动,十万级文件不卡)        │  空格快速预览 │
├─────────┴────────────────────────────────┴─────────────┤
│ 12 个项目 · 选中 3 个 (2.4 GB)                  就绪      │
└────────────────────────────────────────────────────────┘
```

- **点击文件 → 主区直接切换为对应查看器/编辑器**(可返回);空格 = 预览面板轻预览(类 macOS QuickLook);行为可在设置里调整。
- 多标签页 + 分屏(左右两个目录并排,拖拽即复制/移动)。
- 右键菜单自绘;复制/剪切/粘贴/重命名 F2/删除(带确认)/撤销 Ctrl+Z。
- 批量重命名(编号/替换/大小写)。
- 深浅主题、紧凑模式。

## 4. 查看 / 编辑器矩阵(核心卖点)

统一注册表驱动,新增格式 = 注册一个查看器组件,核心零改动:

```ts
interface Viewer {
  id: string
  match(entry: FileEntry): boolean   // 扩展名 + magic bytes 双重判断
  editable: boolean
  component: FC<{ file: FileRef; onDirty(dirty: boolean): void }>
}
```

| 类别 | 格式 | 能力 | 实现 |
|---|---|---|---|
| 图片 | png jpg webp gif bmp svg avif ico | 缩放/旋转/幻灯片/EXIF;裁剪翻转另存 | 原生解码 + Canvas |
| 视频 | mp4 webm mkv mov | 倍速/进度/音量/全屏/画中画/截图/记忆播放位置 | `<video>` + blob URL |
| 音频 | mp3 flac wav ogg m4a | 播放/波形可视化/播放列表 | Web Audio API |
| 文本/代码 | 50+ 扩展名自动识别 | 高亮/行号/查找替换/多标签编辑 | CodeMirror 6 |
| Markdown | md | 编辑 + 实时分屏预览 | markdown-it |
| PDF | pdf | 翻页/缩放/目录/文本搜索 | pdf.js |
| 表格 | csv tsv | 虚拟表格/编辑单元格/排序筛选/导出 | 自研 + TanStack Virtual |
| Excel | xlsx xls | 多 sheet 查看/单元格编辑/导出 | SheetJS |
| Word | docx | 高保真只读;或转 HTML 编辑后导出 | docx-preview / mammoth |
| PPT | pptx | 只读放映 | 解包渲染 |
| 压缩包 | zip | 浏览/解压/直接打开包内文件 | fflate |
| 二进制/未知 | 其他 | Hex + ASCII 查看,magic 识别 | 自研 |

> 编解码说明:视频能否播放取决于浏览器解码器——H.264 / VP9 / AV1 ✅;HEVC 需系统支持;avi / wmv 等老格式受限(可选 ffmpeg.wasm 兜底,性能一般)。

**保存链路**:编辑产生 dirty → Ctrl+S → `provider.write` 流式写回 → 自动生成 `.bak` 备份 → 撤销可回滚;未保存关闭有拦截提示。

## 5. 关键技术设计

- **大文件**:任何环节不整读入内存;流式 + 分块;缩略图/搜索跑在 Web Worker。
- **缩略图**:图片用 canvas 压缩;视频用 `<video>` seek 抽帧;IndexedDB 做 LRU 缓存。
- **格式探测**:扩展名 + magic bytes 双保险,避免改了扩展名的文件看错。
- **权限持久化**:目录句柄存 IndexedDB,启动时 `queryPermission` 恢复;失效则提示一键重新授权。
- **虚拟滚动**:TanStack Virtual,文件区与 CSV 表格共用同一方案。

## 6. 技术选型

Vite · React 18 · TypeScript · Tailwind CSS + shadcn/ui · Zustand · TanStack Virtual · CodeMirror 6 · pdf.js · SheetJS · docx-preview · markdown-it · fflate · Vitest

## 7. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | FS Provider + 目录浏览/导航/排序/虚拟滚动 | 能用的文件浏览器 |
| M2 | 文件操作:复制/移动/删除/重命名/新建 + 撤销 + 冲突处理 | 管理能力齐全 |
| M3 | 查看器框架 + 图片/视频/音频/PDF | 核心卖点立住 |
| M4 | 文本/代码编辑器 + Markdown + CSV | 编辑能力齐全 |
| M5 | xlsx / docx / pptx / zip / hex | 格式全覆盖 |
| M6 | 搜索/收藏/批量重命名/主题/设置持久化 | 打磨 |
| M7(可选) | Tauri 壳 + provider 替换 | 解除浏览器限制 |

## 8. A 形态的已知限制(坦白列出)

- 首次使用需授权目录(之后持久化);无法凭路径字符串直接进入未授权目录。
- 文件夹重命名 = 重建 + 迁移(大目录慢);跨根移动 = 复制 + 删除。
- 无实时文件变更监听(新版 Chromium 的 FileSystemObserver 可作增强),手动刷新兜底。
- 拖出文件到资源管理器受限(仅下载语义)。

哪天这些限制硌手 → 补 M7 的 Tauri 壳,UI 零改动。

## 9. 目录结构(建议)

```
fileManger/
├── docs/DESIGN.md
├── index.html
├── src/
│   ├── app/            # 布局、标签页、路由
│   ├── fs/             # FS Provider 抽象 + FSA 实现(预留 Tauri 实现)
│   ├── components/     # 文件表格、树、面包屑、右键菜单、预览面板
│   ├── viewers/        # 查看器注册表 + 各格式实现
│   │   ├── registry.ts
│   │   ├── image/  video/  audio/  text/  pdf/  office/  archive/  hex/
│   ├── stores/         # Zustand 状态
│   ├── workers/        # 缩略图、搜索
│   └── utils/
└── package.json
```
