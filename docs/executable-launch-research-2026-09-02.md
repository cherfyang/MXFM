# MX 文件管理器 · 「启动可执行程序」能力调研报告

- 日期：2026-09-02
- 方式：4 个只读 subagent 并行调研（格式全景 / 安全模型 / 技术实现 / 交互形态）
- 目标：补齐 `.exe` / `.app` / 脚本 / 安装包 / 快捷方式 等可直接运行条目的启动能力，对标并超越资源管理器与访达

---

## 0. 结论摘要

**一句话**：启动能力本身不是新功能——`shell:open` 早就存在；真正缺的是**分类识别、风险分级、确认与审计**。而当前 `Ctrl+O` / 右键「用系统默认程序打开」走的是无确认的 `shell.openPath`，**对 `.exe` 已经是"任意程序执行"原语**，这是必须先堵的口子。

| 维度 | 现状 | 目标 |
|---|---|---|
| 分类 | `.exe/.msi/.app/.lnk/.desktop` 全落 `binary` 或 `folder`，双击进 HEX 查看器 | 新增 `executable` / `installer` / `shortcut`，脚本保留 `code` + 派生标志 |
| 执行 | `shell.openPath` 无确认、无分级、无日志、无图标 | 分级路由 + 原生确认 + 审计日志 + 系统图标 |
| 安全 | `checkPath` 只挡系统目录的写，执行路径只做 `path.resolve`（不 realpath） | 执行级校验 + `realpath` + 高危投递区告警 + 分级策略 |
| 差异化 | 无 | ExecutableViewer（版本+签名+架构+运行）、卸载入口、主页「应用程序」分类 |

---

## 1. 现状基线（改动落点）

| 位置 | 现状 | 影响 |
|---|---|---|
| `electron/main.cjs:720` | `shell:open` → `shell.openPath(checkPath(p,false))` | 已是执行原语，无确认无日志 |
| `electron/main.cjs:309-336` `listDir` | 只回 `{name, kind, size, modified}`，`st` 用完即弃 | 无 mode / 可执行位 / bundle 标记 |
| `src/fs/electron.ts:207` | 目录 `ext` 恒为 `''` | `.app` 拿不到扩展名 |
| `src/utils/categories.ts:48` | `kind==='directory'` 短路返回 `folder` | `.app` 必被当普通文件夹，双击钻进 `Contents/` |
| `src/utils/categories.ts:33-36` | `.sh/.bat/.ps1` 在 `code` 且 `EDITABLE_CATEGORIES` 含 `code` | 双击进编辑器而非执行 |
| `src/stores/settings.ts:49` | `singleClickOpen` 默认 true | **单击即运行的风险放大器** |
| `src/viewers/registry.tsx:62` / `Icons.tsx:18` / `categories.ts:59` | `VIEWERS` / `MAP` / `LABELS` 三个穷举 Record | 加一个 Category 值，TS 会同时报 3 处错（好事，编译器列全待补点） |
| `src/stores/scan.ts:45` | `SKIP_DIRS` 含 `applications/windows/library/system/usr/program files` | 现有全盘扫描**永远扫不到已安装程序**，应用分类必须独立扫描 |
| `electron/main.cjs:48-56` | `sandbox:true` + contextIsolation + nodeIntegration:false | 安全地基在；但 CSP 含 `unsafe-inline`（HMR 包袱），XSS 面仍在 |

---

## 2. 格式全景与优先级

### P0（必须，80% 用户价值）
| 平台 | 类型 | 正确行为 |
|---|---|---|
| Win | `.exe` `.com` `.scr` | 直接运行；Subsystem=3（控制台）自动走终端 |
| Win | `.msi` | `msiexec /i`，UAC 由系统弹 |
| Win | `.lnk` | 解析 target，默认**只显示不执行** |
| Win | `.bat` `.cmd` | 经 `cmd.exe /d /s /c` 执行（spawn 直跑必失败） |
| mac | `.app`（目录 bundle） | 当作一个可执行文件：图标取系统、双击=运行、右键才有"显示包内容" |
| mac | `.pkg` | 走安装器 |
| Linux | 无扩展名 ELF（`mode & 0o111`） | 直接执行，靠 stat 而非扩展名 |
| Linux | `.desktop` | 解析 `Exec=`（剥 `%f/%u/%U` 字段码）、`Terminal=true` 开终端 |
| 全平台 | `.AppImage` `.jar` `.command` | 依平台处理 |

### P1
`.msix/.appx`（UWP，仅经 `.lnk` 的 appUserModelId）、`.dmg`（挂载）、`.iso`（挂载）、`.deb/.rpm/.flatpakref/.snap`、`.url`（解析 URL=，仅放行 http/https/mailto）、无扩展名文件的内容嗅探（MZ / ELF / `#!` / Mach-O）

### P2
Linux 图标主题解析、`Icon=` 主题名回退、macOS quarantine 角标（按需，不进列举主链路）

### 明确不做
manifest `requireAdministrator` 的完整资源树解析（让 UAC 自己弹，系统比我们准）、macOS Alias 解析（无公开 API）、PE 资源树完整解析

### 冲突清单（按危害排序）
1. `.sh/.bat/.ps1` 现在进编辑器（Explorer/Finder 约定是执行）
2. `.app` 被当文件夹，双击钻进 `Contents/`
3. `.exe/.msi/.dll` 进 HEX 查看器，还先做 4096 字节文本嗅探（对 PE 是纯浪费）
4. `.lnk/.url/.desktop` 全落 `binary`
5. **安全反向风险**：`.js/.vbs/.hta/.reg` 现在安全地落在 `code`（编辑器打开），若图省事并进"可执行"并按执行处理 = 打开 WSH 攻击面。**`EDITABLE_CATEGORIES` 绝不能加脚本类**

---

## 3. 安全模型

### 分级策略
| 级别 | 类型 | 默认行为 | 原生确认 | 可记住 |
|---|---|---|---|---|
| L0 | 媒体/文档（无执行语义） | 直接 `openPath` | 否 | — |
| L1 | `.exe` `.app` `.AppImage` `.command` | 确认后执行 | 首次 + realpath 变化时 | ✅ |
| L2 | `.bat` `.cmd` `.ps1` `.vbs` `.js` `.hta` `.reg` `.scr` `.jar` | **默认查看/编辑**，执行需显式菜单 | 强制 | ❌ 禁止 |
| L3 | `.lnk` `.desktop` `.url` | **只显示目标，不执行** | 强制 | ❌ 禁止 |
| L4 | 以管理员/root 运行 | **红线：不提供** | — | — |

### 攻击面与对策（要点）
- **XSS → RCE**：渲染层有 `mxAPI` 全量暴露，CSP 含 `unsafe-inline` 挡不住注入 → 执行 IPC 必须独立命名（`exec:*`），且**必须主进程 `dialog.showMessageBox`（渲染层自绘框可被伪造/自点）**
- **参数注入**：永远 `spawn(cmd, argsArray, {shell:false})`；`.desktop` 的 `Exec=`、`.lnk` 的 `args` 必须自行分词；禁止 `exec()` / `cmd /c <string>` / `shell:true`
- **软链穿越**：`checkPath` 现在只 `path.resolve` 不 `realpath`，挡不住 `.lnk`/软链 → 执行路径必须 `fs.realpath()` 后再判一次
- **DLL 劫持**：cwd 不是缓解手段（Windows 应用程序目录永远排 DLL 搜索首位）；真正控制是"不执行不可信 exe + 确认 + 下载区/Temp 区强制高危告警"
- **提权**：`runas`/`osascript admin`/`pkexec` 一旦暴露，XSS 即可 UAC 提权，危害从用户级升到系统级 → 红线
- **Unicode 欺骗**：`U+202E` 等双向控制字符可把 `photo‮gpj.exe` 伪装成 `photojpg.exe` → 展示时转义为 `<U+202E>` 并标注
- **审计日志**：`userData/exec-log.jsonl`，记 `{ts, path, realpath, argvCount, cwd, decision, pid, exitCode}`，**不记完整参数**（可能含 token），滚动 2000 条

### 红线清单（10 条）
1. 禁止任何提权 IPC
2. 禁止把 `Exec=` / `args` 整串交 shell
3. 禁止用渲染层自绘弹窗做执行确认
4. 禁止对 L2/L3 类型提供"始终允许"
5. 禁止把"记住的选择"写进 localStorage/IndexedDB（渲染层可写），只写主进程 `userData`
6. 禁止复用 `allowedPaths` 当执行授权（渲染层可自 `fs:grant` 注入，不是安全边界）
7. 禁止只靠文件名/扩展名做安全判定
8. 禁止 `openExternal` 放行 `file:` 或未经 `new URL()` 白名单的字符串
9. 禁止执行路径只 `resolve` 不 `realpath`
10. 禁止 `shell:open` 与 `exec:open` 并存同一能力（必然策略漂移）

---

## 4. 技术方案要点

### API 能力矩阵（关键坑）
| API | 坑 |
|---|---|
| `shell.openPath` | 空串=成功；**拿不到 PID/退出时机**；**无法指定 cwd**（便携软件会崩）；UAC 由系统弹；mac 走 LaunchServices 会弹 Gatekeeper |
| `shell.readShortcutLink` | Win only，非 Win 平台属性不存在；对符号链接抛错；返回 `args` 是字符串需自行分词 |
| `app.getFileIcon` | 仅主进程；`.toDataURL()` 才能过 IPC；**同步系统 API**，大目录批量调用会卡；顺带解决 `.icns` 无法在浏览器解码的问题 |
| `spawn(cmd, args)` | Win 上 `.bat/.cmd` 不能直跑（必须 cmd.exe 中转，且 `windowsVerbatimArguments:true`）；Linux `execvp` 的 ENOEXEC 会让无 shebang 文本文件被 `/bin/sh` 兜底执行 |
| `dialog.showMessageBox` | 项目当前零调用，需从零加；`checkboxLabel` 实现"记住选择" |

### 三平台选型
- **Windows**：exe → 先 `spawn`（可指定 cwd=exe 目录、拿 PID），EACCES/740 回落 `openPath`（触发 UAC）；msi → `msiexec /i`；bat/cmd → `cmd /d /s /c`；脚本 → `openPath`（走文件关联）
- **macOS**：`.app` → 一律 `openPath`（尊重 Gatekeeper，spawn 会绕过 LaunchServices）；裸可执行文件 → `spawn`。**最大坑**：GUI 进程的 PATH 不含 `/usr/local/bin`、`/opt/homebrew/bin`，脚本里 node/python 大概率找不到 → 脚本统一走"终端打开"链路
- **Linux**：`.desktop` → `gtk-launch` → `gio launch` → 自解析降级；ELF/AppImage → `spawn`（缺 x 位先提示 chmod）；未知 → `xdg-open`

### 新增 IPC 契约（建议）
```
exec:probe(paths[])   → 批量返回 {kind, executable, icon?, arch, subsystem, signed, requiresAdmin, motw, risky}
exec:run({path, elevate, args})  → {pid?, mode:'spawn'|'open'}（内部走分级+确认）
exec:icon({path, size})  → dataURL（主进程 LRU 500）
exec:versionInfo(path) → 版本/发布者（Win PowerShell / mac plutil）
exec:uninstallList() / exec:uninstall({uninstallString})
exec:isSensitive(path) → 复用已有 isSensitive()
事件 exec:exit {pid, code, signal}  → onExecExit(cb) 返回取消订阅
```
渲染层：`src/fs/electron.ts` 的 Api 加**可选方法** + `nativeLaunch()` 独立能力探测（缺一个整体降级，不影响 watch/clip/trash/search）

### 进程管理
- 一律 detached + unref（关掉文件管理器不该杀用户打开的程序）
- 要跟踪退出就不能 unref → 只对安装包做退出跟踪（其余发射后不管）
- 同一路径 600ms 内重复双击去重；并发跟踪上限 8
- 错误映射成人话：ENOENT→"找不到（可能已移动或缺少运行环境如 Java）"、EACCES→"没有权限或需要管理员"、ENOEXEC→"不是有效的可执行程序"

---

## 5. 交互设计

### 分类与图标
- 新增 `executable`（AppWindow / indigo）+ `installer`（Package / orange）两个 Category；**脚本保留在 `code`**，用派生标志 `ExecRole` 处理（避免三处 Record 被撑爆）
- 图标两级：桌面版 `app.getFileIcon` → dataURL（LRU 300，key 含 mtime）；失败/浏览器版用 lucide 通用图标
- 角标（右下，最多 1 个）：安装包 > 需管理员 > 未签名/来自网络 > 脚本
- **性能护栏**：只对虚拟滚动可见行请求，并发 ≤ 8，滚动停止 120ms 触发，先占位后替换

### 双击路由（4 档）
| 档 | 条件 | 行为 |
|---|---|---|
| ① 直接运行 | 有有效签名 + 版本信息 + 非受保护目录 + 非安装包/脚本 | 直接 spawn + toast |
| ② 轻量确认 | 一般 exe（无签名/来自下载目录） | 单次确认，默认焦点=取消 |
| ③ 强化确认 | 安装包/需管理员/受保护目录/名称命中 install·setup/脚本 | 红色危险框 + 3 秒倒计时 + 路径防欺骗展示 |
| ④ 强制查看 | `Alt+双击` / `Alt+Enter` / dll·so·node / `.app` bundle 默认 | 进 ExecutableViewer |

**必须豁免 `singleClickOpen`**：可执行文件单击只选中不打开（这是本功能最重要的安全决策）

### ExecutableViewer（差异化核心）
主区一屏给全，比 Explorer 属性对话框 + 访达简介都强：
- **头部**：系统图标 + 名称 + 类型 + 主按钮组（运行 / 以管理员运行 / 安装 / 在终端打开）
- **标识**：产品名、版本、发布者、文件说明（Win `Get-Item VersionInfo` / mac `plutil` / Linux `.desktop`）
- **技术**：架构（x64/x86/arm64）、子系统（GUI/CUI）、大小、修改时间 —— **无需新 IPC，复用已有的 `readBytes(0,4096)` 解析 PE/Mach-O/ELF 头**
- **安全**：数字签名状态 + 签名者、是否来自网络、是否需要管理员
- **操作**：在资源管理器/Finder 中显示、复制路径、卸载（命中时）、解除锁定（命中时）

### 右键菜单树
```
运行
以管理员身份运行（Win，条件显示）
---
打开方式 ▸  可执行信息(Alt+Enter) / 在终端运行 / 系统默认程序(Ctrl+O)
---
复制 / 剪切 / 重命名 / 删除
---
在资源管理器中显示 / 复制路径
---
显示包内容（仅 bundle）/ 卸载（命中时，danger）/ 解除锁定（命中时）
```
禁用态：受保护目录→运行项全禁用；dll/so→无运行项；多选→运行项隐藏（禁止批量运行）；浏览器/演示版→整组隐藏

### 设置项（settings version 2 + migrate）
`execRunPolicy`(askUntrusted) / `execAppBundleDoubleClick`(viewer) / `execScriptDefault`(view) / `execRememberChoices`(true) / `execTrusted`({}) / `execSafeModeSystemDirs`(true) / `execShowBadges`(true)

### 顺带补无障碍
`FileList` 行加 `role="option"`+`aria-selected`；`ContextMenu` 补 `↑↓/→/←/Enter` 键盘导航（当前完全没有）

---

## 6. 实施路线图

**P0（地基 + 堵口子）**
1. `shell:open` 收敛：命中可执行扩展名时拒绝并引导走 `exec:run`（堵住现有无确认执行）
2. `listDir` 吐出 `mode` / `executable` / `isBundle`（`st` 已在手，零额外 syscall）
3. 新增 2 个 Category，按编译器报错补齐 `VIEWERS`/`MAP`/`LABELS`
4. `exec:run` + 分级策略 + 原生确认框（主进程 `userData` 持久化"记住的选择"）
5. `singleClickOpen` 对可执行类豁免
6. 审计日志

**P1（体验）**
7. `exec:icon` + 主进程 LRU + 虚拟滚动可见行限流
8. `.lnk` 解析（Win `readShortcutLink`）/ `.desktop` 解析
9. PE Subsystem 判断（CUI 自动走终端）
10. ExecutableViewer
11. 卸载入口（Win 注册表）

**P2（差异化）**
12. 主页「应用程序」分类（独立扫描，不能复用 scan.ts）
13. 启动历史 + 非 0 退出 toast
14. 便携软件识别
15. 无障碍补齐

---

## 7. 待验证清单（实机确认后再写死）

1. `app.getFileIcon()` 传 `.app` **目录路径**能否返回应用图标（回退：读 `Info.plist` 的 `CFBundleIconFile`）
2. macOS `spawn` 直跑 vs `openPath` 对同一 quarantine `.app` 的 Gatekeeper 行为差异
3. Electron 44 是否已 backport CVE-2026-70611（`shell.openPath` 对 exe 会启动进程）的修复
4. `shell.openPath('shell:AppsFolder\\<PFN>!App')` 启动 UWP 是否可行
5. `gtk-launch` / `gio launch` 在目标发行版的覆盖率
6. `Mount-DiskImage`（ISO 挂载）是否需要管理员
7. PowerShell / codesign 冷启动 200-400ms 是否可接受（版本信息/签名）
8. Windows `process.kill(pid, 0)` 探活可靠性
9. AppImage `--appimage-extract-and-run` 降级有效性
10. Android/Capacitor 下 APK 安装能力形态

---

## 8. 需要拍板的 3 个决策

| # | 决策 | 建议 |
|---|---|---|
| 1 | `singleClickOpen` 对可执行文件豁免 | **必须做**，否则单击即运行，误触无法避免 |
| 2 | `.app` 双击默认「进查看器」还是「直接运行」 | 建议默认**查看器**（安全 + 差异化），设置可切为访达式直接运行 |
| 3 | 版本信息/签名走 PowerShell / codesign（冷启动 200-400ms + 子进程） | 建议接受 + 主进程缓存；若不愿引入则砍掉标识/安全分区，只保留架构（可从已有 4096 字节免费获得） |
