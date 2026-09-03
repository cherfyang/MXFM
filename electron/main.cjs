const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net, Menu, nativeImage, clipboard } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const chokidar = require('chokidar')

// 允许渲染进程通过自定义协议流式访问本地文件(视频拖动进度条需要 Range 支持)
// standard+secure 让 <img>/<video> 等标签可以直接以 mxfile:// 作为源
protocol.registerSchemesAsPrivileged([
  { scheme: 'mxfile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
])

// ---------- 多窗口 ----------
// 全部存活窗口的集合。watch/clip/op 等 IPC 事件都按 event.sender 路由,
// 天然多窗口安全;这里只负责窗口生命周期与菜单/对话框的归属。
const wins = new Set()
let winSeq = 0

// ---------- 窗口大小位置记忆 ----------
// 第一个窗口沿用 window-state.json(兼容历史状态),后续窗口按创建序号独立存档。
function windowStateFile(seq) {
  return path.join(app.getPath('userData'), seq === 1 ? 'window-state.json' : `window-state-${seq}.json`)
}

function loadWindowState(seq) {
  try {
    return JSON.parse(fs.readFileSync(windowStateFile(seq), 'utf8'))
  } catch {
    return null
  }
}

function createWindow() {
  const seq = ++winSeq
  const saved = loadWindowState(seq)
  const w = new BrowserWindow({
    x: saved?.x,
    y: saved?.y,
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#17181b',
    autoHideMenuBar: true,
    title: 'MX 文件管理器',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 沙箱化渲染进程。preload 只 require('electron') 拿 contextBridge/ipcRenderer,
      // 不使用任何 Node 内置模块,因此沙箱下功能不受影响(见 preload.cjs 顶部注释)。
      sandbox: true,
    },
  })
  wins.add(w)
  if (saved?.maximized) w.maximize()
  if (app.isPackaged) {
    w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    // 开发模式:默认连 vite dev server(先运行 npm run electron:dev)
    w.loadURL('http://localhost:5188/').catch(() => {
      w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    })
  }
  // 关闭时保存窗口状态(最大化只记标记,不记坐标)
  w.on('close', () => {
    if (!wins.has(w)) return
    const state = w.isMaximized() || w.isFullScreen() ? { maximized: true } : { ...w.getBounds(), maximized: false }
    try {
      fs.writeFileSync(windowStateFile(seq), JSON.stringify(state))
    } catch {
      /* ignore */
    }
  })
  w.on('closed', () => {
    wins.delete(w)
    // 该窗口挂的目录监听一并停掉,不留死句柄(见 watch 模块,按 sender 记账)
    stopWatchersOfSender(w.webContents)
  })
  return w
}

// ---------- 应用菜单(中文;mac 依赖 editMenu 提供剪贴板快捷键) ----------
// 菜单动作只发给当前聚焦窗口:newFolder/refresh/closeTab 这类动作若广播,
// 会让所有窗口同时响应(每个窗口都弹新建框),语义就错了。
function sendAction(action) {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    try {
      focused.webContents.send('menu-action', action)
    } catch {
      /* 窗口正在关闭 */
    }
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit', label: '退出 MX 文件管理器' }] }]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新建文件夹', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendAction('newFolder') },
        { label: '新建文本文档', accelerator: 'CmdOrCtrl+N', click: () => sendAction('newFile') },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Alt+N', click: () => createWindow() },
        { type: 'separator' },
        { label: '刷新', accelerator: 'F5', click: () => sendAction('refresh') },
        { type: 'separator' },
        // 接管 Cmd/Ctrl+W:关标签页而非关窗口(菜单加速器优先于页面按键,最可靠)
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => sendAction('closeTab') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: '退出', role: 'quit' }]),
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '查看',
      submenu: [
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        {
          label: '下一个标签页',
          accelerator: isMac ? 'Cmd+Shift+]' : 'Ctrl+Tab',
          click: () => sendAction('nextTab'),
        },
        {
          label: '上一个标签页',
          accelerator: isMac ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab',
          click: () => sendAction('prevTab'),
        },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools', label: '开发者工具' }]),
      ],
    },
    // 不放 close 角色,把 Cmd/Ctrl+W 让给「关闭标签页」
    isMac
      ? { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom' }] }
      : { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- 系统信息 ----------
async function probeDrives() {
  const drives = []
  await Promise.all(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (L) => {
      try {
        await fsp.access(L + ':/')
        drives.push(L + ':')
      } catch {
        /* 盘符不存在 */
      }
    })
  )
  return drives.sort()
}

// 各平台的"根位置":Windows 是磁盘,mac 是系统盘,Linux 是文件系统根
async function probeRoots() {
  if (process.platform === 'win32') {
    const names = await probeDrives()
    return names.map((d) => ({ name: d, path: d + '/' }))
  }
  if (process.platform === 'darwin') {
    return [{ name: 'Macintosh HD', path: '/' }]
  }
  return [{ name: '系统', path: '/' }]
}

// 各平台的常用目录
function specialDirs() {
  const special = (name, key) => {
    try {
      return { name, path: app.getPath(key) }
    } catch {
      return null
    }
  }
  const dirs = [
    special('桌面', 'desktop'),
    special('下载', 'downloads'),
    special('文档', 'documents'),
    special('图片', 'pictures'),
    special('音乐', 'music'),
    special('视频', 'videos'),
  ].filter(Boolean)
  if (process.platform === 'darwin') {
    dirs.push({ name: '应用程序', path: '/Applications' })
  }
  return dirs.filter(Boolean)
}

ipcMain.handle('sys:boot', async () => ({
  platform: process.platform,
  version: app.getVersion(),
  roots: await probeRoots(),
  specials: specialDirs(),
}))

// ---------- 路径安全校验(集中一处,所有来自渲染进程的路径都必须先过这里) ----------
// 1) 拒绝 NUL 字节:底层 C API 以 NUL 截断字符串,是经典的路径注入/绕过手段。
// 2) 写入/删除类操作拒绝命中系统敏感位置,避免误删/误改把系统搞坏。
// 3) 读取类只告警不阻断:用户可能确实需要查看这些位置。
// 4) 所有路径统一 path.resolve 规范化,后续判断都在规范化后的绝对路径上进行。

/** Windows / macOS 文件系统大小写不敏感,Linux 敏感 —— 白名单比对要跟着区分 */
const CASE_SENSITIVE_FS = process.platform === 'linux'
const pathKey = (p) => (CASE_SENSITIVE_FS ? p : p.toLowerCase())

/** target 是否位于 root 之内(含等于 root) */
function isUnder(target, root) {
  const rel = path.relative(root, target)
  if (!rel) return true
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return true
}

let sensitiveCache = null
function sensitiveDirs() {
  if (sensitiveCache) return sensitiveCache
  const list = []
  const push = (p) => {
    if (p) list.push(path.resolve(p))
  }
  if (process.platform === 'win32') {
    const win = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    push(path.join(win, 'System32'))
    push(win)
    // 各盘回收站目录
    for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) push(L + ':\\$Recycle.Bin')
  } else {
    for (const d of ['/System', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/dev', '/proc', '/boot']) push(d)
    push('/etc/shadow')
  }
  sensitiveCache = list
  return list
}

function isSensitive(p) {
  const rp = path.resolve(p)
  const sshDir = path.join(os.homedir(), '.ssh')
  // ~/.ssh/id_* 私钥:被覆盖等于永久丢失身份凭证
  if (isUnder(rp, sshDir) && /^id_/.test(path.basename(rp))) return true
  return sensitiveDirs().some((d) => isUnder(rp, d))
}

/**
 * @param {unknown} p 渲染进程传入的原始路径
 * @param {boolean} write true=写/删除类(命中敏感目录直接抛错);false=读取类(仅告警)
 * @returns {string} 规范化后的绝对路径
 */
function checkPath(p, write) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('无效路径')
  if (p.includes('\0')) throw new Error('路径包含非法字符(NUL)')
  const rp = path.resolve(p)
  if (isSensitive(rp)) {
    if (write) throw new Error(`拒绝修改受保护的系统位置:${rp}`)
    console.warn('[mx-fm] 读取系统敏感路径(已放行):', rp)
  }
  return rp
}

// ---------- mxfile:// 访问白名单 ----------
// 渲染进程要播放某个本地文件前必须先 fs:grant 授权(见 src/fs/electron.ts 的 mediaUrl)。
// 协议侧只认这里登记过的规范化绝对路径,杜绝任意本地文件被网页侧读取。
const allowedPaths = new Set()

function grantPaths(paths) {
  const list = Array.isArray(paths) ? paths : [paths]
  let n = 0
  for (const p of list) {
    try {
      allowedPaths.add(pathKey(checkPath(p, false)))
      n++
    } catch {
      /* 非法路径直接忽略 */
    }
  }
  return n
}

function revokePaths(paths) {
  const list = Array.isArray(paths) ? paths : [paths]
  for (const p of list) {
    try {
      allowedPaths.delete(pathKey(checkPath(p, false)))
    } catch {
      /* ignore */
    }
  }
  return true
}

ipcMain.handle('fs:grant', (_e, paths) => grantPaths(paths))
ipcMain.handle('fs:revoke', (_e, paths) => revokePaths(paths))

// 同步版本:mediaUrl() 必须在「返回 URL」之前让授权生效 —— invoke 是异步的,
// 会与 <video>/<img> 的首次请求产生竞态导致偶发 403,所以额外开一个 sendSync 通道。
ipcMain.on('fs:grant:sync', (e, paths) => {
  e.returnValue = grantPaths(paths)
})

// ---------- 文件操作(全部接收本地绝对路径,正斜杠形式) ----------
async function listDir(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true })
  const out = new Array(dirents.length)
  const CH = 64
  for (let i = 0; i < dirents.length; i += CH) {
    await Promise.all(
      dirents.slice(i, i + CH).map(async (d, j) => {
        const fp = path.join(dir, d.name)
        let st = null
        try {
          st = await fsp.stat(fp)
        } catch {
          /* 并发删除等 */
        }
        // 追加的三个字段供「运行」能力使用:st 已经在手,零额外 syscall。
        // isBundle 需要一次 existsSync,只在 mac 且目录名以 .app 结尾时才付出。
        const isDir = d.isDirectory()
        const isBundle = isDir && isAppBundle(fp)
        out[i + j] = {
          name: d.name,
          kind: isDir ? 'directory' : 'file',
          size: st ? st.size : 0,
          modified: st ? st.mtimeMs : null,
          mode: st ? st.mode : 0,
          executable: !!st && (isBundle || (!isDir && isExecutableNow(extOf(fp), st))),
          isBundle,
        }
      })
    )
  }
  return out.filter(Boolean)
}

ipcMain.handle('fs:list', (_e, p) => listDir(checkPath(p, false)))

ipcMain.handle('fs:stat', async (_e, p) => {
  const st = await fsp.stat(checkPath(p, false))
  return { size: st.size, modified: st.mtimeMs, isDir: st.isDirectory() }
})

ipcMain.handle('fs:read', async (_e, p, start = 0, length) => {
  const fh = await fsp.open(checkPath(p, false), 'r')
  try {
    const total = (await fh.stat()).size
    const len = length == null ? Math.max(total - start, 0) : length
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, start)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
})

ipcMain.handle('fs:write', async (_e, p, data) => {
  await fsp.writeFile(checkPath(p, true), Buffer.from(data))
})

ipcMain.handle('fs:mkdir', (_e, p) => fsp.mkdir(checkPath(p, true), { recursive: true }))

ipcMain.handle('fs:createFile', async (_e, p) => {
  const fh = await fsp.open(checkPath(p, true), 'a')
  await fh.close()
})

// 删除进回收站。失败(网络盘/无回收站的挂载点)**绝不降级为彻底删除** ——
// 静默 rm -rf 是不可逆的数据丢失,宁可报错让 UI 提示「此位置不支持回收站」,
// 由用户显式选择「彻底删除」(fs:removePermanent)。
// 注意:trashItem 之前先记录元数据(见 trash 模块),mac 的「还原」依赖它。
ipcMain.handle('fs:remove', async (_e, p) => {
  const rp = checkPath(p, true)
  await recordTrashMeta(rp)
  await shell.trashItem(rp)
  return { trashed: true }
})

// 彻底删除(Shift+Delete):不经过回收站,用户已明确确认
ipcMain.handle('fs:removePermanent', async (_e, p) => {
  const rp = checkPath(p, true)
  await fsp.rm(rp, { recursive: true, force: true })
  return { trashed: false }
})

ipcMain.handle('fs:rename', async (_e, from, to) => {
  const src = checkPath(from, true)
  const dst = checkPath(to, true)
  await fsp.rename(src, dst) // 跨盘会抛 EXDEV,由渲染层走复制+删除兜底
  return 'moved'
})

ipcMain.handle('fs:exists', async (_e, p) => {
  try {
    await fsp.stat(checkPath(p, false))
    return true
  } catch {
    return false
  }
})

// ---------- 批量流式复制/移动作业 ----------
// 设计要点:
// 1) 内容一律走 createReadStream → pipe(createWriteStream),文件再大也不会进内存。
// 2) move 优先 fsp.rename(同盘是 O(1) 原子操作,零拷贝),只有 EXDEV/EPERM 等
//    真跨盘/无权限时才降级为「复制 + 删源」。这是修复「目录移动永远走递归复制」的关键。
// 3) 同一时刻只允许一个作业在跑:并发读写会互相抢磁头、进度也无法归因,
//    所以后来者直接收到 busy 错误,由渲染层串行提交(比排队更可预测,不会出现
//    「用户以为取消了其实还在队列里」的幽灵任务)。
const ops = new Map() // id → { aborted, current: { rs, ws, dst } | null }
let activeOpId = null
let opSeq = 0
const PROGRESS_STEP = 8 * 1024 * 1024 // 单文件每累计 8MB 上报一次,避免刷屏
// rename 失败但值得降级为复制+删源的错误码(其余错误视为真失败,不静默改写语义)
const RENAME_FALLBACK = new Set(['EXDEV', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EBUSY', 'EMLINK', 'ENOSPC', 'EROFS'])

class OpAborted extends Error {
  constructor() {
    super('cancelled')
    this.code = 'ABORTED'
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** mode==='keepboth' 时生成 name (2).ext / name (3).ext … */
async function uniquePath(dst) {
  const dir = path.dirname(dst)
  const ext = path.extname(dst)
  const base = path.basename(dst, ext)
  for (let i = 2; i < 100000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`)
    if (!(await pathExists(cand))) return cand
  }
  return null
}

/** 递归收集目录下的普通文件,保持相对结构。符号链接目录不跟随(dirent.isDirectory() 为 false) */
async function walkDir(srcDir, dstDir, out, srcRoot, dstRoot) {
  let entries
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const s = path.join(srcDir, e.name)
    const d = path.join(dstDir, e.name)
    // 基本 sanity check:展开结果不允许逃出源/目标根的父目录
    if (!isUnder(path.resolve(s), srcRoot) || !isUnder(path.resolve(d), dstRoot)) continue
    if (e.isDirectory()) await walkDir(s, d, out, srcRoot, dstRoot)
    else if (e.isFile()) out.push({ src: s, dst: d })
  }
}

/** 流式复制单个文件;op.current 供取消时 destroy 用 */
function streamCopy(op, src, dst, onBytes) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src)
    const ws = fs.createWriteStream(dst)
    let written = 0
    let lastReport = 0
    const cur = { rs, ws, dst }
    op.current = cur
    rs.on('data', (chunk) => {
      written += chunk.length
      if (written - lastReport >= PROGRESS_STEP) {
        lastReport = written
        onBytes(written)
      }
    })
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('close', () => {
      if (op.current === cur) op.current = null
      if (op.aborted) return reject(new OpAborted())
      resolve()
    })
    rs.pipe(ws)
  })
}

function sendProgress(sender, id, i, count, bytesDone, bytesTotal, currentName) {
  if (!sender || sender.isDestroyed()) return
  try {
    sender.send('fs:op:progress', { id, fileIndex: i, fileCount: count, bytesDone, bytesTotal, currentName })
  } catch {
    /* 窗口已关闭 */
  }
}

function sendDone(sender, id, ok, error, results) {
  if (!sender || sender.isDestroyed()) return
  try {
    sender.send('fs:op:done', { id, ok, error, results })
  } catch {
    /* 窗口已关闭 */
  }
}

async function runOp(sender, id, payload) {
  const op = ops.get(id)
  const kind = payload?.kind === 'move' ? 'move' : 'copy'
  const rawMode = payload?.mode
  const mode = rawMode === 'skip' || rawMode === 'keepboth' ? rawMode : 'overwrite'
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : []

  const files = [] // 展开后的扁平文件列表 { src, dst, size, job }
  const jobRecords = [] // 需要真正搬运的 job(已排除 skip / 已整体 rename 的)
  // results 与入参 jobs **下标一一对齐**,渲染层可直接按下标映射回自己的条目
  const results = new Array(jobs.length)

  // ---- 1) 展开 job:处理冲突策略,目录尝试整体 rename ----
  for (let ji = 0; ji < jobs.length; ji++) {
    const j = jobs[ji] || {}
    let src
    let dst
    try {
      src = checkPath(j.src, true)
      dst = checkPath(j.dst, true)
    } catch (e) {
      results[ji] = { src: String(j.src ?? ''), dst: String(j.dst ?? ''), status: 'failed', error: e.message }
      continue
    }
    const isDir = !!j.isDir
    let finalDst = dst

    // 冲突策略:skip 直接跳过;keepboth 自动改名 name (2).ext;overwrite 留到写之前 unlink
    if (mode === 'skip' && (await pathExists(dst))) {
      results[ji] = { src, dst, status: 'skipped' }
      continue
    }
    if (mode === 'keepboth' && (await pathExists(dst))) {
      finalDst = (await uniquePath(dst)) || dst
    }

    if (isDir) {
      // 同盘移动:整目录一次 rename 完成,零拷贝。
      // 目标已存在时不走这条路(rename 覆盖非空目录在多数平台会失败,语义不一致),
      // 留给下面的逐文件复制去合并/覆盖。
      if (kind === 'move' && !(await pathExists(finalDst))) {
        try {
          await fsp.rename(src, finalDst)
          results[ji] = { src, dst: finalDst, status: 'renamed' }
          continue
        } catch (e) {
          if (!RENAME_FALLBACK.has(e.code)) {
            results[ji] = { src, dst: finalDst, status: 'failed', error: e.message }
            continue
          }
          // 降级为递归复制 + 删源(跨盘 / 无权限 / 目标已存在)
        }
      }
      const rec = { index: ji, src, dst: finalDst, isDir: true, files: [] }
      jobRecords.push(rec)
      // 空目录也要建出来,否则移动空文件夹会丢
      await fsp.mkdir(finalDst, { recursive: true }).catch(() => {})
      const mark = files.length
      await walkDir(src, finalDst, files, path.resolve(src), path.resolve(finalDst))
      for (const f of files.slice(mark)) rec.files.push(f)
    } else {
      const rec = { index: ji, src, dst: finalDst, isDir: false, files: [] }
      jobRecords.push(rec)
      const f = { src, dst: finalDst, size: 0 }
      rec.files.push(f)
      files.push(f)
    }
  }

  // ---- 2) 预统计总字节(stat 失败的记 0,不影响流程) ----
  let bytesTotal = 0
  for (const f of files) {
    try {
      const st = await fsp.stat(f.src)
      f.size = st.size > 0 ? st.size : 0
    } catch {
      f.size = 0
    }
    bytesTotal += f.size
  }

  // ---- 3) 逐个文件流式处理 ----
  let bytesDone = 0
  const count = files.length
  sendProgress(sender, id, 0, count, 0, bytesTotal, files[0] ? path.basename(files[0].dst) : '')

  for (let i = 0; i < count; i++) {
    if (op.aborted) throw new OpAborted()
    const f = files[i]
    const name = path.basename(f.dst)
    sendProgress(sender, id, i, count, bytesDone, bytesTotal, name)
    try {
      // 目标父目录必须先建好,否则 rename / createWriteStream 都会 ENOENT
      await fsp.mkdir(path.dirname(f.dst), { recursive: true })
      // move:先试 rename,成功即零拷贝
      if (kind === 'move') {
        try {
          await fsp.rename(f.src, f.dst)
          f.status = 'renamed'
          bytesDone += f.size
          sendProgress(sender, id, i + 1, count, bytesDone, bytesTotal, name)
          continue
        } catch (e) {
          if (!RENAME_FALLBACK.has(e.code)) throw e
        }
      }
      if (mode === 'overwrite') await fsp.unlink(f.dst).catch(() => {})
      await streamCopy(op, f.src, f.dst, (written) => {
        sendProgress(sender, id, i, count, bytesDone + written, bytesTotal, name)
      })
      f.status = 'copied'
      if (kind === 'move') await fsp.unlink(f.src).catch(() => {})
      bytesDone += f.size
      sendProgress(sender, id, i + 1, count, bytesDone, bytesTotal, name)
    } catch (e) {
      if (op.aborted || e instanceof OpAborted) throw new OpAborted()
      f.status = 'failed'
      f.error = e.message
    }
  }

  if (op.aborted) throw new OpAborted()

  // ---- 4) 汇总每个 job 的结果;move 成功的删源目录 ----
  for (const rec of jobRecords) {
    const failed = rec.files.find((f) => f.status === 'failed')
    if (failed) {
      results[rec.index] = { src: rec.src, dst: rec.dst, status: 'failed', error: failed.error }
      continue
    }
    const allRenamed = rec.files.length > 0 && rec.files.every((f) => f.status === 'renamed')
    // move 且该目录所有文件都搬走了(rename 移走或复制后删源),源目录整体删除。
    // 任一文件失败时在上面就 continue 了,源目录保留 —— 绝不会出现「删了但没复制全」。
    if (kind === 'move' && rec.isDir) {
      await fsp.rm(rec.src, { recursive: true, force: true }).catch(() => {})
    }
    results[rec.index] = { src: rec.src, dst: rec.dst, status: allRenamed ? 'renamed' : 'copied' }
  }
  return results
}

/**
 * 启动一个批量复制/移动作业,立即返回 opId(渲染层拿它去匹配 progress/done 事件)。
 * payload = { kind: 'copy'|'move', mode: 'overwrite'|'skip'|'keepboth',
 *             jobs: Array<{ src: string, dst: string, isDir: boolean }> }
 */
ipcMain.handle('fs:op:start', async (event, payload) => {
  if (activeOpId) throw new Error('busy: 已有文件操作正在进行')
  const id = 'op-' + Date.now().toString(36) + '-' + (++opSeq).toString(36)
  const op = { aborted: false, current: null }
  ops.set(id, op)
  activeOpId = id
  const sender = event.sender
  // 不 await:先把 id 返回给渲染层挂监听,作业在后台跑
  runOp(sender, id, payload)
    .then((results) => {
      sendDone(sender, id, true, null, results)
    })
    .catch((e) => {
      const aborted = op.aborted || e instanceof OpAborted || e?.code === 'ABORTED'
      sendDone(sender, id, false, aborted ? 'cancelled' : String(e?.message || e), [])
    })
    .finally(() => {
      ops.delete(id)
      if (activeOpId === id) activeOpId = null
    })
  return id
})

/** 取消:置 aborted、destroy 当前流、删除半成品目标文件 */
ipcMain.on('fs:op:cancel', (_e, payload) => {
  const id = payload && payload.id
  const op = id ? ops.get(id) : null
  if (!op) return
  op.aborted = true
  const cur = op.current
  if (cur) {
    op.current = null
    try {
      cur.rs.destroy()
    } catch {
      /* ignore */
    }
    try {
      cur.ws.destroy()
    } catch {
      /* ignore */
    }
    // destroy 后 ws 会异步 close,此时再删半成品最稳妥
    try {
      cur.ws.once('close', () => {
        fsp.unlink(cur.dst).catch(() => {})
      })
    } catch {
      fsp.unlink(cur.dst).catch(() => {})
    }
  }
})

ipcMain.handle('dialog:pickFolder', async (event) => {
  // 对话框挂到发起请求的窗口(多窗口下不能再引用单例)
  const parent = BrowserWindow.fromWebContents(event.sender)
  const r = await dialog.showOpenDialog(parent, {
    properties: ['openDirectory'],
    title: '选择要添加的文件夹',
  })
  if (r.canceled || !r.filePaths.length) return null
  return r.filePaths[0].replace(/\\/g, '/')
})

ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(checkPath(p, false)))

// 收敛前的说明:shell.openPath 对 .exe 是"无确认直接执行"原语(CVE-2026-70611 相关),
// 双击即运行、绕过了任何用户确认。这里把带执行语义的文件全部挡掉,让渲染层引导走
// exec:run(分级确认 + 审计)。判定只按「本机是否真的能执行」来,所以 mac 上一个
// 没有 x 位的 .sh 仍然可以用 openPath 打开(用编辑器查看),不会变成死路。
ipcMain.handle('shell:open', async (_e, p) => {
  const rp = checkPath(p, false)
  if (await looksExecutable(rp)) throw new Error('可执行文件请通过「运行」启动')
  const r = await shell.openPath(rp)
  return r || null // 返回非空字符串表示错误信息
})

/**
 * 用指定的外部应用打开某个文件。
 * 安全:filePath 与 appPath 都经过校验;appPath 必须存在且不是普通文件夹(.app bundle 除外);
 *      执行一律 spawn 数组参数,不拼接命令行。
 */
ipcMain.handle('shell:openWith', async (_e, rawFile, rawApp) => {
  const rp = checkPath(rawFile, false)
  if (typeof rawApp !== 'string' || !rawApp.trim()) throw new Error('无效的应用程序路径')
  if (rawApp.includes('\0')) throw new Error('应用路径包含非法字符(NUL)')
  const appPath = path.resolve(rawApp)
  let st
  try {
    st = await fsp.stat(appPath)
  } catch {
    throw new Error('应用程序不存在或无法访问')
  }
  if (st.isDirectory() && !isAppBundle(appPath)) {
    throw new Error('所选目标不是可执行程序')
  }
  // macOS .app bundle 必须用 open -a,直接 spawn 会进 bundle 内部语义不对
  if (process.platform === 'darwin' && (appPath.endsWith('.app') || st.isDirectory())) {
    const r = await spawnExec('open', ['-a', appPath, rp], { detached: true })
    return r.ok ? { ok: true, pid: r.pid } : { ok: false, error: mapExecError(r.error) }
  }
  const r = await spawnExec(appPath, [rp], { detached: true, windowsHide: true })
  return r.ok ? { ok: true, pid: r.pid } : { ok: false, error: mapExecError(r.error) }
})

ipcMain.handle('dialog:pickOpenWithApp', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender)
  const filters = [{ name: '所有文件', extensions: ['*'] }]
  if (process.platform === 'win32') {
    filters.unshift({ name: '可执行程序', extensions: ['exe', 'com', 'cmd', 'bat', 'scr', 'pif'] })
  } else if (process.platform === 'darwin') {
    filters.unshift({ name: '应用程序', extensions: ['app'] })
  }
  const r = await dialog.showOpenDialog(parent, {
    properties: ['openFile'],
    title: '选择要使用的应用程序',
    filters,
  })
  if (r.canceled || !r.filePaths.length) return null
  return r.filePaths[0].replace(/\\/g, '/')
})

ipcMain.handle('sys:memory', () => {
  const m = process.memoryUsage()
  return { rss: m.rss, heapUsed: m.heapUsed }
})

// ---------- ffmpeg 转码服务(播放浏览器不支持的格式) ----------
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')

// 转码产物目录。mxfile:// 协议对这个目录内的文件免白名单(渲染层直接用它拼 URL)。
const TRANSCODE_DIR = path.join(os.tmpdir(), 'mx-fm-transcode')
const TRANSCODE_MAX_AGE = 7 * 24 * 60 * 60 * 1000
/** 正在写入/正在播放的转码产物,清理时跳过 */
const busyTranscodes = new Set()

/** 清理 7 天前(mtime)的历史转码产物;正在使用的跳过 */
async function cleanTranscodeCache() {
  let items
  try {
    items = await fsp.readdir(TRANSCODE_DIR, { withFileTypes: true })
  } catch {
    return // 目录还不存在
  }
  const now = Date.now()
  for (const it of items) {
    const fp = path.join(TRANSCODE_DIR, it.name)
    if (busyTranscodes.has(pathKey(fp))) continue
    try {
      const st = await fsp.stat(fp)
      if (now - st.mtimeMs < TRANSCODE_MAX_AGE) continue
      await fsp.rm(fp, { recursive: true, force: true })
    } catch {
      /* 被占用 / 权限不足 / 并发删除:跳过,下次启动再试 */
    }
  }
}

function ffmpegPath() {
  try {
    let p = require('ffmpeg-static')
    if (p && app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked')
    return p
  } catch {
    return null
  }
}

let transProc = null

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const ff = ffmpegPath()
    if (!ff) return resolve(-1)
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', ...args], {
      windowsHide: true,
    })
    transProc = p
    p.on('close', (code) => resolve(code == null ? -1 : code))
    p.on('error', () => resolve(-1))
  })
}

ipcMain.handle('transcode:start', async (_e, rawSrc, kind) => {
  if (!ffmpegPath()) return { ok: false, msg: '未找到内置转码组件' }
  const srcPath = checkPath(rawSrc, false)
  let st
  try {
    st = await fsp.stat(srcPath)
  } catch {
    return { ok: false, msg: '源文件不存在' }
  }
  const outExt = kind === 'audio' ? 'mp3' : 'mp4'
  try {
    fs.mkdirSync(TRANSCODE_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  // 缓存 key 必须包含 mtimeMs + size:否则源文件被改写后还会命中旧缓存,播放的是上一段内容
  const hash = crypto
    .createHash('md5')
    .update(`${srcPath}|${kind}|${Math.round(st.mtimeMs)}|${st.size}`)
    .digest('hex')
    .slice(0, 12)
  const outPath = path.join(TRANSCODE_DIR, hash + '.' + outExt)
  busyTranscodes.add(pathKey(outPath))
  try {
    // 快速路径:编码本身支持,只是容器不认识 → 直接重封装,秒级完成
    if (kind === 'video') {
      const code = await runFfmpeg(['-i', srcPath, '-c', 'copy', '-movflags', '+faststart', outPath])
      if (code === 0) return { ok: true, outPath }
    }
    // 慢速路径:真转码
    const args =
      kind === 'audio'
        ? ['-i', srcPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '3', outPath]
        : ['-i', srcPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath]
    const code = await runFfmpeg(args)
    if (code === 0) return { ok: true, outPath }
    return { ok: false, msg: '转码失败(可能是不支持的编码或文件已损坏)' }
  } finally {
    // 注意:产物还要给播放器继续读,这里只是不再「正在写入」,7 天过期策略照常生效
    busyTranscodes.delete(pathKey(outPath))
  }
})

ipcMain.handle('transcode:cancel', () => {
  try {
    transProc?.kill()
  } catch {
    /* ignore */
  }
  return true
})

// ---------- 目录实时监听 ----------
// 渲染层只关心「这个目录变了,请刷新」,所以事件只带 watchId + dir。
// depth:0 只监听当前目录一层(子目录内容由用户进入时再挂),ignoreInitial 避免打开就刷一次。
const watchers = new Map() // watchId → { id, dir, sender, timer, watcher }
const watchOrder = [] // watchId 按创建顺序排列,超出上限时淘汰最旧(LRU)
const WATCH_MAX = 32
const WATCH_DEBOUNCE = 300
let watchSeq = 0

function destroyWatch(id) {
  const w = watchers.get(id)
  if (!w) return
  watchers.delete(id)
  const idx = watchOrder.indexOf(id)
  if (idx >= 0) watchOrder.splice(idx, 1)
  if (w.timer) clearTimeout(w.timer)
  try {
    w.watcher.close()
  } catch {
    /* ignore */
  }
}

function stopAllWatchers() {
  for (const id of [...watchOrder]) destroyWatch(id)
}

/** 停掉某个渲染进程(sender)名下的全部监听 —— 窗口关闭时调用,防止句柄泄漏 */
function stopWatchersOfSender(sender) {
  for (const w of [...watchers.values()]) {
    if (w.sender === sender) destroyWatch(w.id)
  }
}

/** 300ms 防抖:同一目录内多次变更合并为一次推送,减少渲染层刷新风暴 */
function emitWatchChanged(w) {
  if (w.timer) return
  w.timer = setTimeout(() => {
    w.timer = null
    const sender = w.sender
    if (!sender || sender.isDestroyed()) return
    try {
      sender.send('fs:watch:event', { watchId: w.id, dir: w.dir })
    } catch {
      /* 窗口已关闭 */
    }
  }, WATCH_DEBOUNCE)
}

ipcMain.handle('fs:watch:start', (event, dir) => {
  const rp = checkPath(dir, false)
  // 超出上限先关最旧的,防止用户狂开标签页把文件句柄耗尽
  while (watchers.size >= WATCH_MAX) destroyWatch(watchOrder[0])
  const id = ++watchSeq
  const w = { id, dir: rp, sender: event.sender, timer: null, watcher: null }
  watchers.set(id, w)
  watchOrder.push(id)
  w.watcher = chokidar.watch(rp, { depth: 0, ignoreInitial: true, ignorePermissionErrors: true })
  // add/addDir/unlink/unlinkDir/change 任意事件都触发同一条防抖消息
  w.watcher.on('all', () => emitWatchChanged(w))
  // error 静默销毁:目录被拔盘/删除是正常场景,不发垃圾事件
  w.watcher.on('error', () => destroyWatch(id))
  return id
})

ipcMain.handle('fs:watch:stop', (_e, id) => {
  destroyWatch(Number(id))
})

ipcMain.handle('fs:watch:stopAll', () => {
  stopAllWatchers()
})

// ---------- 系统剪贴板文件读写(本应用 ⇄ Explorer/Finder 互拷) ----------
// Windows:FileNameW 是 CF_HDROP 的 Unicode 变体 —— 每个路径为 UTF-16LE 且以 U+0000 结尾,
//          整体再以双 \0 结尾;Preferred DropEffect 首字节 2=move / 5=copy,区分剪切与复制。
// mac/Linux:public.file-url,每行一个 file:// URL(encodeURI 编码非 ASCII 字符)。
// 妥协:mac 的 Finder 不支持「剪切文件」(Cmd+X 只对文本生效),写入后读回 cut 恒为 false;
//       Linux 各文件管理器对剪切标记支持不一,同样忽略。
function clipEncodeWindows(paths, cut) {
  const buf = Buffer.concat([...paths.map((p) => Buffer.from(p + '\0', 'utf16le')), Buffer.alloc(2)])
  clipboard.writeBuffer('FileNameW', buf)
  clipboard.writeBuffer('Preferred DropEffect', Buffer.from([cut ? 2 : 5, 0, 0, 0]))
}

function clipEncodePosix(paths) {
  const data = paths.map((p) => 'file://' + encodeURI(p) + '\n').join('')
  clipboard.writeBuffer('public.file-url', Buffer.from(data, 'utf8'))
}

function clipDecodeWindows() {
  let buf
  try {
    buf = clipboard.readBuffer('FileNameW')
  } catch {
    return null
  }
  if (!buf || buf.length < 4) return null
  // 双 \0 结尾的路径列表;空串过滤掉,同时容忍中间出现的空项
  const paths = buf
    .toString('utf16le')
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!paths.length) return null
  let cut = false
  try {
    const eff = clipboard.readBuffer('Preferred DropEffect')
    cut = !!eff && eff.length > 0 && eff[0] === 2 // 2=move
  } catch {
    /* 没有该格式,按复制处理 */
  }
  return { paths, cut }
}

function clipDecodePosix() {
  let buf
  try {
    buf = clipboard.readBuffer('public.file-url')
  } catch {
    return null
  }
  if (!buf) return null
  const paths = buf
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return decodeURI(line.replace(/^file:\/\//, ''))
      } catch {
        return ''
      }
    })
    .filter(Boolean)
  return paths.length ? { paths, cut: false } : null
}

ipcMain.handle('clip:write', (_e, payload) => {
  const raw = Array.isArray(payload?.paths) ? payload.paths : []
  const cut = !!payload?.cut
  const paths = []
  for (const p of raw) {
    try {
      paths.push(checkPath(p, false))
    } catch {
      /* 非法路径跳过 */
    }
  }
  if (!paths.length) throw new Error('剪贴板:没有有效的文件路径')
  if (process.platform === 'win32') clipEncodeWindows(paths, cut)
  else clipEncodePosix(paths)
  return { ok: true }
})

ipcMain.handle('clip:read', () => {
  const res = process.platform === 'win32' ? clipDecodeWindows() : clipDecodePosix()
  if (!res) return null
  // 读操作只 warn 不阻断(见 checkPath);无效路径丢弃
  const paths = []
  for (const p of res.paths) {
    try {
      paths.push(checkPath(p, false))
    } catch {
      console.warn('[mx-fm] 剪贴板路径无效,已跳过:', p)
    }
  }
  return paths.length ? { paths, cut: res.cut } : null
})

// ---------- 在终端打开 ----------
// 各家终端没有统一入口,按平台逐个尝试,失败自动兜底。
// detached + unref:终端是独立进程,主进程退出不该杀掉它,也不等它结束。
// spawn 的 ENOENT 是异步 error 事件而非同步异常,所以用 'spawn'/'error' 谁先到来判定成败。
function spawnDetached(cmd, args, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true })
    } catch {
      return resolve(false)
    }
    let settled = false
    const done = (ok) => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    child.on('spawn', () => done(true))
    child.on('error', () => done(false))
    child.unref()
  })
}

ipcMain.handle('shell:openTerminal', async (_e, dir) => {
  const rp = checkPath(dir, false)
  let ok = false
  if (process.platform === 'win32') {
    ok = await spawnDetached('wt.exe', ['-d', rp], rp)
    if (!ok) {
      // start 是 cmd 内建命令,必须经 cmd.exe 中转;cwd 会让新开的 cmd 落在目标目录
      ok = await spawnDetached('cmd.exe', ['/c', 'start', 'cmd', '/K'], rp)
    }
  } else if (process.platform === 'darwin') {
    ok = await spawnDetached('open', ['-a', 'Terminal', rp], rp)
    if (!ok) ok = await spawnDetached('open', ['-a', 'iTerm', rp], rp)
  } else {
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole']) {
      if (await spawnDetached(term, [], rp)) {
        ok = true
        break
      }
    }
  }
  if (!ok) throw new Error('未找到可用的终端程序')
  return { ok: true }
})

// ---------- 启动可执行程序(分级确认 + 原生对话框) ----------
// 安全红线 —— 改动本节前务必先读:
//   1) 绝不实现任何提权 IPC(runas / osascript admin / pkexec / sudo 一概不做)。
//      需要管理员的程序靠 shell.openPath 回落,由系统自己弹 UAC。XSS + 提权 IPC = 直接失守。
//   2) 一律 spawn(cmd, argsArray, { shell:false });永不 exec()、永不拼接命令行字符串。
//   3) 路径必须 realpath() 之后再判策略 —— 只 path.resolve 挡不住符号链接与目录穿越。
//   4) "记住的选择"只写主进程 userData/exec-policy.json:渲染层可写的地方(localStorage
//      / IndexedDB)XSS 就能篡改,不是安全边界。
//   5) 审计日志只记路径 + 参数个数,不记参数内容(参数里可能有 token / 密码)。
//   6) 不复用 mxfile:// 的 allowedPaths:渲染层可以自己 fs:grant 注入,同样不是安全边界。
//   7) 确认框必须主进程 dialog.showMessageBox:渲染层自绘弹窗可被 XSS 伪造或自动点击。
//
// 分级:0=无执行语义(直接 openPath) 1=程序(确认,可记住) 2=危险脚本(强制确认,禁记住)
//      3=代理执行(lnk/desktop/url:只解析并展示目标,目标也要重新过一遍策略)。

const EXEC_POLICY_MAX = 500 // 记住的策略条数上限(LRU,最旧的先淘汰)
const EXEC_LOG_MAX = 2000 // 审计日志滚动上限
const EXEC_LOG_SLACK = 200 // 超出上限多少条后才截断一次,避免每写一条都重写整个文件
const PROBE_CACHE_MAX = 2000 // exec:probe 结果缓存条数
const ICON_CACHE_MAX = 500 // 图标 dataURL 缓存条数(图标极少变)
const ICON_CONCURRENCY = 4 // app.getFileIcon 是同步系统 API,必须限并发
const EXEC_TRACK_MAX = 8 // 同时跟踪退出的子进程上限,超出改为发射后不管
const EXEC_DEDUP_MS = 600 // 同一 realpath 的重复触发窗口(防双击开两个实例)
const EXEC_ARGS_MAX = 64 // 自定义参数个数上限
const EXEC_BATCH_MAX = 512 // exec:probe 单次批量上限

// 惰性取:主进程模块求值早于 app ready,不要在顶层直接 getPath
let userDirCache = null
function userFile(name) {
  if (!userDirCache) userDirCache = app.getPath('userData')
  return path.join(userDirCache, name)
}

/** 扩展名(小写);无扩展名返回 '' */
const extOf = (p) => path.extname(p).toLowerCase()

// Windows:可执行文件靠扩展名识别(Node 在 Windows 上不置 mode 的 x 位)
const WIN_EXEC_EXT = new Set([
  '.exe', '.com', '.scr', '.pif', '.bat', '.cmd', '.msi', '.msix', '.appx',
  '.lnk', '.ps1', '.vbs', '.js', '.jse', '.hta', '.reg', '.jar',
])

// shell:open 需要挡掉的扩展名,按平台分开:只挡「本机真的能执行」的,
// 免得用户连"用编辑器打开一个没有 x 位的 .sh"都做不到。
const OPEN_BLOCK_EXT_WIN = new Set([
  '.exe', '.com', '.scr', '.pif', '.bat', '.cmd', '.msi', '.msix', '.appx',
  '.lnk', '.ps1', '.vbs', '.js', '.jse', '.hta', '.reg', '.url', '.jar',
  '.bin', '.run', '.command', '.elf',
])
const OPEN_BLOCK_EXT_MAC = new Set([
  '.sh', '.bash', '.run', '.bin', '.command', '.elf', '.out', '.appimage', '.desktop', '.jar', '.pkg',
])
const OPEN_BLOCK_EXT_LINUX = new Set([
  '.sh', '.bash', '.run', '.bin', '.command', '.elf', '.out', '.appimage', '.desktop', '.jar',
])
const OPEN_BLOCK_EXT =
  process.platform === 'win32' ? OPEN_BLOCK_EXT_WIN : process.platform === 'darwin' ? OPEN_BLOCK_EXT_MAC : OPEN_BLOCK_EXT_LINUX

/** 目录是否为 macOS .app bundle(以 .app 结尾且含 Contents/MacOS) */
function isAppBundle(p) {
  return process.platform === 'darwin' && extOf(p) === '.app' && fs.existsSync(path.join(p, 'Contents', 'MacOS'))
}

/** 该文件在当前平台是否具备执行语义 */
function isExecutableNow(ext, st) {
  if (process.platform === 'win32' && WIN_EXEC_EXT.has(ext)) return true
  return (st.mode & 0o111) !== 0
}

/**
 * shell:open 的收敛判定:这个文件是否该被挡下、改走 exec:run。
 * 目录只有 .app bundle 算可执行;文件按平台扩展名表 + Unix 可执行位判定。
 */
async function looksExecutable(rp) {
  let st
  try {
    st = await fsp.stat(rp)
  } catch {
    return false // 不存在:交给 openPath 自己去报错,这里不抢
  }
  if (st.isDirectory()) return isAppBundle(rp)
  const ext = extOf(rp)
  if (OPEN_BLOCK_EXT.has(ext)) return true
  // 无扩展名的 Unix 可执行(ELF / 带 shebang 的脚本):mode 的 x 位是唯一信号
  return (st.mode & 0o111) !== 0
}

// ---- 扩展名 → kind ----
// kind: 'exe'|'msi'|'script'|'lnk'|'url'|'desktop'|'app'|'installer'|'elf'|'dir'|'other'
function kindOfExt(ext, st) {
  switch (ext) {
    case '.exe':
    case '.com':
    case '.scr':
    case '.pif':
      return 'exe'
    case '.msi':
    case '.msix':
    case '.appx':
      return 'msi'
    case '.bat':
    case '.cmd':
    case '.ps1':
    case '.vbs':
    case '.js':
    case '.jse':
    case '.hta':
    case '.reg':
    case '.sh':
    case '.bash':
      return 'script'
    case '.lnk':
      return 'lnk'
    case '.url':
      return 'url'
    case '.desktop':
      return 'desktop'
    // .appimage 是"安装器形态的可执行文件",分级上按 L1 处理(见 levelOf)
    case '.pkg':
    case '.deb':
    case '.rpm':
    case '.dmg':
    case '.appimage':
      return 'installer'
    case '.elf':
    case '.run':
    case '.bin':
    case '.command':
    case '.out':
      return 'elf'
    default:
      // 无扩展名 + 可执行位 → Unix 可执行
      return !ext && st.mode & 0o111 ? 'elf' : 'other'
  }
}

/** 没进 kind 枚举但同样会执行代码的扩展名(.jar 靠 javaw 文件关联启动) */
const LEVEL1_EXT = new Set(['.jar'])

/**
 * 分级:0=无执行语义 1=程序(可记住) 2=危险脚本(强制确认,禁记住) 3=代理执行
 * script 没有可执行位时归 0 —— 本机双击它只会拿编辑器打开,不构成执行。
 */
function levelOf(kind, ext, executable) {
  if (kind === 'lnk' || kind === 'desktop' || kind === 'url') return 3
  if (kind === 'script') return executable ? 2 : 0
  if (kind === 'dir') return 0
  if (kind === 'other') return executable || LEVEL1_EXT.has(ext) ? 1 : 0
  if (kind === 'msi' || kind === 'installer') return 1
  return executable ? 1 : 0 // exe / app / elf
}

let riskyDirCache = null
/** 「来源可疑」的目录:临时目录、下载目录、废纸篓 —— 这些地方的东西不该随手就跑 */
function riskyDirs() {
  if (riskyDirCache) return riskyDirCache
  const list = [os.tmpdir(), path.join(os.homedir(), '.Trash'), path.join(os.homedir(), '.local', 'share', 'Trash')]
  try {
    list.push(app.getPath('downloads'))
  } catch {
    /* 没有下载目录就算了 */
  }
  riskyDirCache = list.map((p) => (p ? path.resolve(p) : '')).filter(Boolean)
  return riskyDirCache
}

function isInRiskyDir(rp) {
  return riskyDirs().some((d) => isUnder(rp, d))
}

/** 风险标签(人类可读,直接进确认框 detail) */
function buildRisky(rp, level, kind) {
  const out = []
  if (isSensitive(rp)) out.push('系统受保护目录')
  if (isInRiskyDir(rp)) out.push('来自下载或临时目录')
  if (kind === 'msi' || kind === 'installer') out.push('安装程序,会修改系统')
  if (level === 2) out.push('脚本文件')
  if (level === 3) out.push('快捷方式,将跳转到目标')
  return out
}

// ---- probe 缓存:key 含 mtimeMs,mtime 一变立即失效(免得改写过的文件还报旧结论) ----
const probeCache = new Map() // path → { mtimeMs, result }

function probeCacheGet(p, mtimeMs) {
  const hit = probeCache.get(p)
  if (!hit) return null
  if (hit.mtimeMs !== mtimeMs) {
    probeCache.delete(p)
    return null
  }
  probeCache.delete(p)
  probeCache.set(p, hit) // 命中即挪到末尾(LRU)
  return hit.result
}

function probeCacheSet(p, mtimeMs, result) {
  if (probeCache.has(p)) probeCache.delete(p)
  probeCache.set(p, { mtimeMs, result })
  while (probeCache.size > PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value)
}

function buildProbe(rp, st) {
  const isDir = st.isDirectory()
  const ext = extOf(rp)
  const isBundle = isDir && isAppBundle(rp)
  const kind = isBundle ? 'app' : isDir ? 'dir' : kindOfExt(ext, st)
  const executable = isBundle || (!isDir && isExecutableNow(ext, st))
  const level = levelOf(kind, ext, executable)
  return { path: rp, kind, executable, isBundle, level, risky: buildRisky(rp, level, kind) }
}

/** 单个路径的探测(带缓存);路径不存在时返回 level 0 + error,不抛 */
async function probeOne(rp) {
  let st
  try {
    st = await fsp.stat(rp)
  } catch {
    return { path: rp, kind: 'other', executable: false, isBundle: false, level: 0, risky: [], error: '文件不存在或无法访问' }
  }
  const cached = probeCacheGet(rp, st.mtimeMs)
  if (cached) return cached
  const result = buildProbe(rp, st)
  probeCacheSet(rp, st.mtimeMs, result)
  return result
}

// ---- 策略文件:userData/exec-policy.json ----
// [{ path: <realpath>, allow: boolean, at: epochMs }]
let execPolicy = null

async function loadExecPolicy() {
  if (execPolicy) return execPolicy
  try {
    const data = JSON.parse(await fsp.readFile(userFile('exec-policy.json'), 'utf8'))
    execPolicy = Array.isArray(data) ? data.filter((it) => it && typeof it.path === 'string') : []
  } catch {
    execPolicy = []
  }
  return execPolicy
}

async function saveExecPolicy() {
  if (!execPolicy) return
  try {
    await fsp.writeFile(userFile('exec-policy.json'), JSON.stringify(execPolicy.slice(-EXEC_POLICY_MAX)))
  } catch {
    /* userData 不可写时静默放弃:退化为每次都确认,不影响安全 */
  }
}

async function rememberExecPolicy(rp, allow) {
  const list = await loadExecPolicy()
  const idx = list.findIndex((it) => it.path === rp)
  if (idx >= 0) list.splice(idx, 1)
  list.push({ path: rp, allow, at: Date.now() })
  if (list.length > EXEC_POLICY_MAX) list.splice(0, list.length - EXEC_POLICY_MAX)
  await saveExecPolicy()
}

// ---- 审计日志:userData/exec-log.jsonl ----
// 一行一条 JSON。只记路径 + 参数个数,**不记参数内容**(参数里可能有 token / 密码)。
let execLogCount = -1

async function initExecLogCount() {
  if (execLogCount >= 0) return
  try {
    const raw = await fsp.readFile(userFile('exec-log.jsonl'), 'utf8')
    execLogCount = raw.split('\n').filter(Boolean).length
  } catch {
    execLogCount = 0
  }
}

async function trimExecLog() {
  try {
    const raw = await fsp.readFile(userFile('exec-log.jsonl'), 'utf8')
    const kept = raw.split('\n').filter(Boolean).slice(-EXEC_LOG_MAX)
    await fsp.writeFile(userFile('exec-log.jsonl'), kept.map((l) => l + '\n').join(''))
    execLogCount = kept.length
  } catch {
    /* 读不到就算了,下次启动再试 */
  }
}

async function appendExecLog(entry) {
  try {
    await initExecLogCount()
    await fsp.appendFile(userFile('exec-log.jsonl'), JSON.stringify(entry) + '\n')
    execLogCount++
    if (execLogCount > EXEC_LOG_MAX + EXEC_LOG_SLACK) await trimExecLog()
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

// ---- 子进程跟踪 ----
const execProcs = new Map() // pid → { pid, rp, level, argvCount, cwd }
const execLastRun = new Map() // realpath → 上次触发时间(600ms 去重)

function broadcastExecExit(payload) {
  for (const w of wins) {
    try {
      if (!w.isDestroyed()) w.webContents.send('exec:exit', payload)
    } catch {
      /* 窗口正在关闭 */
    }
  }
}

/** 退出前只清表,绝不 kill 子进程 —— 用户启动的程序与我们无关 */
function clearExecProcs() {
  execProcs.clear()
}

/** spawn 失败的错误码 → 人话 */
function mapExecError(e) {
  const code = e?.code
  if (code === 'ENOENT') return '找不到可执行文件(可能已移动,或缺少运行环境如 Java/Python)'
  if (code === 'EACCES' || code === 'EPERM' || e?.errno === -740) return '没有执行权限,或需要管理员权限'
  if (code === 'ENOEXEC') return '不是有效的可执行程序(格式不兼容本机)'
  if (code === 'EISDIR') return '这是文件夹'
  return '启动失败:' + String(e?.message || e)
}

/** 是否需要管理员(ERROR_ELEVATION_REQUIRED = -740) */
const needsElevation = (e) => e?.code === 'EACCES' || e?.code === 'EPERM' || e?.errno === -740

/**
 * 发射后不管:detached + unref,主进程退出不带走它。
 * 沿用 spawnDetached 的 spawn/error 竞态判定,额外回传 pid 与原始错误(供 UAC 回落判定)。
 * @returns {Promise<{ok:true,pid:number}|{ok:false,error:Error}>}
 */
function spawnExec(cmd, args, opts) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts })
    } catch (e) {
      return resolve({ ok: false, error: e })
    }
    let settled = false
    child.on('spawn', () => {
      if (settled) return
      settled = true
      resolve({ ok: true, pid: child.pid })
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: e })
    })
    child.unref()
  })
}

/**
 * 需要知道退出码的进程(msi 等安装类):ref 住并挂 exit,退出后清引用 + 广播 exec:exit。
 * 并发跟踪超上限时降级为发射后不管(不让跟踪表无限增长)。
 */
function spawnTracked(cmd, args, opts, meta) {
  if (execProcs.size >= EXEC_TRACK_MAX) return spawnExec(cmd, args, opts)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, ...opts })
    } catch (e) {
      return resolve({ ok: false, error: e })
    }
    let settled = false
    child.on('spawn', () => {
      if (settled) return
      settled = true
      execProcs.set(child.pid, { pid: child.pid, ...meta })
      resolve({ ok: true, pid: child.pid })
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: e })
    })
    child.on('exit', (code, signal) => {
      const rec = execProcs.get(child.pid) || meta
      execProcs.delete(child.pid)
      broadcastExecExit({ pid: child.pid, code: code == null ? null : code, signal: signal || null })
      appendExecLog({
        ts: Date.now(),
        path: rec.rp,
        realpath: rec.rp,
        argvCount: rec.argvCount || 0,
        cwd: rec.cwd || null,
        level: rec.level || 0,
        mode: 'exit',
        decision: 'exit',
        pid: child.pid,
        exitCode: code == null ? null : code,
      }).catch(() => {})
    })
  })
}

// ---- 确认框文本处理 ----
// 双向控制字符(U+202A–U+202E / U+2066–U+2069)能把 "cod.exe" 显示成 "exe.doc",
// 是经典的伪装手法;这里一律替换成可见的 <U+XXXX>。控制字符同理(还能伪造换行)。
function hasHiddenChars(s) {
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c <= 0x1f) return true
  }
  return false
}

function escapeHidden(s) {
  let out = ''
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c <= 0x1f) {
      out += `<U+${c.toString(16).toUpperCase().padStart(4, '0')}>`
    } else {
      out += ch
    }
  }
  return out
}

/**
 * 组装确认框参数。detail 里给出完整路径 + 风险标签,L3 额外展示解析出的目标。
 * 只有 L1 且无任何风险标签时才允许「始终允许」—— L2/L3 永不给 checkbox。
 */
function buildExecConfirm(rp, probe, targetLine, canRemember) {
  const name = escapeHidden(path.basename(rp))
  const lines = ['完整路径:', '  ' + escapeHidden(rp)]
  if (targetLine) lines.push('', '实际启动的目标:', '  ' + escapeHidden(targetLine))
  if (probe.risky.length) {
    lines.push('', '风险提示:')
    for (const r of probe.risky) lines.push('  · ' + r)
  }
  if (hasHiddenChars(path.basename(rp)) || hasHiddenChars(rp) || (targetLine && hasHiddenChars(targetLine))) {
    lines.push('', '⚠ 文件名含隐藏字符,已转义显示,请仔细核对。')
  }
  const opts = {
    type: 'warning',
    buttons: ['取消', '运行'],
    defaultId: 0, // 默认焦点落在「取消」
    cancelId: 0,
    noLink: true,
    message: `运行「${name}」?`,
    detail: lines.join('\n'),
  }
  if (canRemember) {
    opts.checkboxLabel = '始终允许此程序'
    opts.checkboxChecked = false
  }
  return opts
}

// ---- 参数校验 ----
/** 只接受字符串数组,逐项拒绝 NUL;数量封顶。绝不允许把参数拼进命令行字符串。 */
function normalizeExecArgs(raw) {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('参数必须是字符串数组')
  const out = []
  for (const a of raw.slice(0, EXEC_ARGS_MAX)) {
    if (typeof a !== 'string') continue
    if (a.includes('\0')) throw new Error('参数包含非法字符(NUL)')
    out.push(a)
  }
  return out
}

// ---- Windows ----
/** 按 CommandLineToArgvW 规则切分 Windows 命令行字符串(解析 .lnk 的 args 用) */
function winTokenize(s) {
  const out = []
  let cur = ''
  let has = false
  let q = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      let n = 0
      while (i < s.length && s[i] === '\\') {
        n++
        i++
      }
      if (s[i] === '"') {
        // 2n 个反斜杠 + 引号 → n 个反斜杠 + 引号作分隔符;2n+1 个 → n 个反斜杠 + 字面引号
        cur += '\\'.repeat(n >> 1)
        if (n % 2) cur += '"'
        else q = !q
        has = true
        i++ // 消费这个引号
      } else {
        cur += '\\'.repeat(n)
      }
      i-- // 抵消 for 的 i++
      continue
    }
    if (c === '"') {
      q = !q
      has = true
      continue
    }
    if (!q && (c === ' ' || c === '\t')) {
      if (cur || has) {
        out.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (cur || has) out.push(cur)
  return out
}

/** 交给系统自己打开(openPath 返回非空串即错误信息) */
async function openBySystem(p) {
  try {
    const err = await shell.openPath(p)
    return err ? { mode: 'denied', reason: err } : { mode: 'open' }
  } catch (e) {
    return { mode: 'denied', reason: String(e?.message || e) }
  }
}

/**
 * Windows 可执行:先自己 spawn,拿不到权限再回落 openPath 让系统弹 UAC。
 * 我们不做任何提权,只是把球踢回给系统。
 */
async function spawnWinProgram(rp, args, cwd) {
  const r = await spawnExec(rp, args, { cwd })
  if (r.ok) return { mode: 'spawn', pid: r.pid }
  if (needsElevation(r.error)) return openBySystem(rp)
  return { mode: 'denied', reason: mapExecError(r.error) }
}

/** Windows 批处理:必须经 cmd.exe 中转(start 是内建命令)。路径已单独引号包好,不拼接整条命令行 */
async function spawnWinBatch(rp, args, cwd) {
  const comspec = process.env.ComSpec || 'cmd.exe'
  const r = await spawnExec(comspec, ['/d', '/s', '/c', `"${rp}"`, ...args], { cwd, windowsVerbatimArguments: true })
  if (r.ok) return { mode: 'spawn', pid: r.pid }
  if (needsElevation(r.error)) return openBySystem(rp)
  return { mode: 'denied', reason: mapExecError(r.error) }
}

/** Windows .url 快捷方式:只认 http/https,其余协议(file:、自定义协议)一律拒绝 */
async function openUrlShortcut(rp) {
  let text
  try {
    text = await fsp.readFile(rp, 'utf8')
  } catch {
    return { mode: 'denied', reason: '无法读取快捷方式内容' }
  }
  const m = /^[ \t]*URL[ \t]*=[ \t]*(.+)$/im.exec(text)
  const url = m ? m[1].trim() : ''
  if (!/^https?:\/\//i.test(url)) return { mode: 'denied', reason: '快捷方式不是有效的 http/https 网址,已阻止' }
  try {
    await shell.openExternal(url)
    return { mode: 'open' }
  } catch (e) {
    return { mode: 'denied', reason: String(e?.message || e) }
  }
}

/** 解析 .lnk:UWP 商店应用交给系统,普通快捷方式解出 target+args 再按扩展名走执行分支 */
async function runShortcut(rp, args) {
  // 非 Windows 上根本没有这个 API,typeof 判空避免直接崩
  if (typeof shell.readShortcutLink !== 'function') return { mode: 'denied', reason: '当前系统不支持解析快捷方式' }
  let link
  try {
    link = shell.readShortcutLink(rp)
  } catch {
    return { mode: 'denied', reason: '快捷方式已损坏,无法解析' }
  }
  if (!link || !link.target) return { mode: 'denied', reason: '快捷方式没有指向任何目标' }
  if (link.appUserModelId) return openBySystem(rp) // UWP / 商店应用:只有系统能启动
  let target
  try {
    target = await fsp.realpath(path.resolve(link.target))
  } catch {
    return { mode: 'denied', reason: '快捷方式指向的目标已不存在' }
  }
  // 目标要重新过一遍策略:快捷方式可以指向任何地方
  if (isSensitive(target)) return { mode: 'denied', reason: '快捷方式指向受保护的系统位置,已阻止' }
  let st
  try {
    st = await fsp.stat(target)
  } catch {
    return { mode: 'denied', reason: '快捷方式指向的目标已不存在' }
  }
  if (st.isDirectory()) return openBySystem(target)
  const linkArgs = link.args ? winTokenize(link.args) : []
  const cwd = link.cwd && fs.existsSync(link.cwd) ? link.cwd : path.dirname(target)
  return runWinByExt(target, [...linkArgs, ...args], extOf(target), cwd)
}

function runWinByExt(rp, args, ext, cwd) {
  switch (ext) {
    case '.exe':
    case '.com':
    case '.scr':
    case '.pif':
      return spawnWinProgram(rp, args, cwd)
    case '.bat':
    case '.cmd':
      return spawnWinBatch(rp, args, cwd)
    case '.msi':
      return spawnResult(spawnTracked('msiexec.exe', ['/i', rp, ...args], { cwd }, { rp, level: 1, argvCount: args.length, cwd }))
    default:
      // ps1 / vbs / js / hta / reg / jar …:走文件关联(L2 已经在前面强制确认过)
      return openBySystem(rp)
  }
}

/** spawn 结果 → RunResult */
function spawnResult(promise) {
  return promise.then((r) => (r.ok ? { mode: 'spawn', pid: r.pid } : { mode: 'denied', reason: mapExecError(r.error) }))
}

// ---- Linux / freedesktop .desktop ----
/** 按 Desktop Entry 规范切分 Exec=:支持双引号与 \s \n \t \r \\ 转义 */
function desktopTokenize(s) {
  const out = []
  let cur = ''
  let has = false
  let q = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      const n = s[++i]
      if (n === undefined) break
      if (n === 's') cur += ' '
      else if (n === 'n') cur += '\n'
      else if (n === 't') cur += '\t'
      else if (n === 'r') cur += '\r'
      else if (n === '\\') cur += '\\'
      else cur += '\\' + n // 未知转义:按字面量保留,不猜
      has = true
      continue
    }
    if (c === '"') {
      q = !q
      has = true
      continue
    }
    if (!q && (c === ' ' || c === '\t')) {
      if (cur || has) {
        out.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (cur || has) out.push(cur)
  // 剥掉字段码 %f %F %u %U %i %c %k …;argv[0] 即使为空也保留
  return out.map((t) => t.replace(/%[fFuUickdDnNvm]/g, '')).filter((t, i) => i === 0 || t !== '')
}

async function parseDesktopFile(rp) {
  let text
  try {
    text = await fsp.readFile(rp, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  let inEntry = false
  const de = { exec: null, cwd: null, terminal: false, tryExec: null, name: null, genericName: null, comment: null, version: null, seen: false }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      inEntry = line === '[Desktop Entry]'
      if (inEntry) de.seen = true
      continue
    }
    if (!inEntry || !line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1)
      if (key === 'Exec') de.exec = val
    else if (key === 'Path') de.cwd = val
    else if (key === 'Terminal') de.terminal = /^true$/i.test(val.trim())
    else if (key === 'TryExec') de.tryExec = val
    // 下面四个是展示用的元数据(exec:meta 在 Linux 上靠它们出版本信息),
    // 顺手在同一遍扫描里取,省得再读一次文件
    else if (key === 'Name') de.name = val.trim()
    else if (key === 'GenericName') de.genericName = val.trim()
    else if (key === 'Comment') de.comment = val.trim()
    else if (key === 'Version') de.version = val.trim()
  }
  return de.seen ? de : null
}

/** 命令名 → 绝对路径;非 PATH 查找失败返回 null */
function resolveCommand(cmd) {
  if (!cmd) return null
  if (cmd.includes('/') || cmd.includes('\\')) return path.resolve(cmd)
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const cand = path.join(d, cmd)
    if (fs.existsSync(cand)) return cand
  }
  return null
}

/** 执行 .desktop:解出 Exec/Path/Terminal,参数全程数组化,绝不交 shell */
async function runDesktopFile(rp, args) {
  const de = await parseDesktopFile(rp)
  if (!de || !de.exec) return { mode: 'denied', reason: '不是有效的 .desktop 文件(缺少 Exec=)' }
  const argv = desktopTokenize(de.exec)
  if (!argv.length) return { mode: 'denied', reason: '.desktop 的 Exec= 为空' }
  if (de.tryExec && !resolveCommand(desktopTokenize(de.tryExec)[0] || de.tryExec)) {
    return { mode: 'denied', reason: '该程序未安装(.desktop 的 TryExec 指向的程序不存在)' }
  }
  const cmd = resolveCommand(argv[0])
  if (!cmd) return { mode: 'denied', reason: `找不到程序:${escapeHidden(String(argv[0]))}` }
  if (isSensitive(cmd)) return { mode: 'denied', reason: '快捷方式指向受保护的系统程序,已阻止' }
  const rest = [...argv.slice(1), ...args]
  const dir = path.dirname(rp)
  const cwd = de.cwd && path.isAbsolute(de.cwd) && fs.existsSync(de.cwd) ? de.cwd : dir
  if (de.terminal) {
    for (const t of ['x-terminal-emulator', 'gnome-terminal', 'konsole']) {
      const prefix = t === 'gnome-terminal' ? ['--'] : ['-e']
      const r = await spawnExec(t, [...prefix, cmd, ...rest], { cwd })
      if (r.ok) return { mode: 'spawn', pid: r.pid }
    }
    return { mode: 'denied', reason: '该程序需要终端,但本机没有可用的终端模拟器' }
  }
  const r = await spawnExec(cmd, rest, { cwd })
  return r.ok ? { mode: 'spawn', pid: r.pid } : { mode: 'denied', reason: mapExecError(r.error) }
}

// ---- 平台分发 ----
const WINDOWS_ONLY_EXT = new Set(['.exe', '.msi', '.msix', '.appx'])

function dispatchWin(rp, args, ext, cwd) {
  if (ext === '.lnk') return runShortcut(rp, args)
  if (ext === '.url') return openUrlShortcut(rp)
  if (ext === '.msix' || ext === '.appx') return openBySystem(rp) // 必须走 App Installer
  return runWinByExt(rp, args, ext, cwd)
}

function dispatchMac(rp, args, ext, executable, isBundle, cwd) {
  // .app / .pkg / .dmg 一律走 LaunchServices:直接 spawn 会绕过 Gatekeeper 与隔离属性(xattr)
  if (isBundle || ext === '.pkg' || ext === '.dmg') return openBySystem(rp)
  if (WINDOWS_ONLY_EXT.has(ext)) return { mode: 'denied', reason: '这是 Windows 程序,当前系统无法直接运行' }
  if (!executable) return { mode: 'denied', reason: '缺少可执行权限,请先 chmod +x' }
  const r = spawnExec(rp, args, { cwd })
  return spawnResult(r)
}

function dispatchLinux(rp, args, ext, executable, cwd) {
  if (ext === '.desktop') return runDesktopFile(rp, args)
  // 安装包交给系统的软件中心/包管理器,我们没有权限也不该自己去解
  if (ext === '.deb' || ext === '.rpm') return openBySystem(rp)
  if (WINDOWS_ONLY_EXT.has(ext) && !executable) return { mode: 'denied', reason: '这是 Windows 程序,当前系统无法直接运行' }
  if (!executable) return { mode: 'denied', reason: '缺少可执行权限,请先 chmod +x' }
  return spawnResult(spawnExec(rp, args, { cwd }))
}

/** L3 的代理目标预览:确认框里要让用户看到"真正会跑起来的是什么" */
async function describeProxyTarget(rp, kind) {
  try {
    if (kind === 'lnk') {
      if (typeof shell.readShortcutLink !== 'function') return null
      const link = shell.readShortcutLink(rp)
      if (!link?.target) return null
      const target = link.appUserModelId ? link.appUserModelId : link.target
      return link.args ? `${target} ${link.args}` : target
    }
    if (kind === 'desktop') {
      const de = await parseDesktopFile(rp)
      return de?.exec ? de.exec.trim() : null
    }
    if (kind === 'url') {
      const text = await fsp.readFile(rp, 'utf8')
      const m = /^[ \t]*URL[ \t]*=[ \t]*(.+)$/im.exec(text)
      return m ? m[1].trim() : null
    }
  } catch {
    /* 解析失败就不展示,不影响确认 */
  }
  return null
}

// ---- IPC ----
// 注:版本信息与数字签名(exec:meta)、已安装程序列表与卸载(exec:uninstallList / exec:uninstall)
// 实现在文件末尾的「程序元数据与已安装程序」一节 —— 它们要复用下方回收站模块里的
// psStr / runPowerShell 等 PowerShell 辅助函数,放那儿可以避免向前引用。
ipcMain.handle('exec:probe', async (_e, paths) => {
  const list = Array.isArray(paths) ? paths.slice(0, EXEC_BATCH_MAX) : []
  const out = new Array(list.length)
  // 批量并发:单次 IPC 拿到整屏结果,避免 N 次往返
  await Promise.all(
    list.map(async (p, i) => {
      let rp
      try {
        rp = checkPath(p, false)
      } catch (e) {
        // 单条非法不该让整批失败
        out[i] = { path: String(p ?? ''), kind: 'other', executable: false, isBundle: false, level: 0, risky: [], error: e.message }
        return
      }
      out[i] = await probeOne(rp)
    })
  )
  return out
})

ipcMain.handle('exec:isSensitive', (_e, p) => {
  try {
    return isSensitive(checkPath(p, false))
  } catch {
    return true // 路径非法:按敏感处理,UI 会禁用运行按钮
  }
})

ipcMain.handle('exec:policy:list', async () => {
  const list = await loadExecPolicy()
  return list.map((it) => ({ path: it.path, allow: !!it.allow, at: Number(it.at) || 0 }))
})

ipcMain.handle('exec:policy:reset', async (_e, p) => {
  const list = await loadExecPolicy()
  if (typeof p === 'string' && p.trim()) {
    const rp = path.resolve(p)
    const idx = list.findIndex((it) => it.path === rp)
    if (idx >= 0) list.splice(idx, 1)
  } else {
    list.length = 0
  }
  await saveExecPolicy()
})

ipcMain.handle('exec:run', async (event, opts) => {
  let rp0
  let args
  try {
    rp0 = checkPath(opts?.path, false)
    args = normalizeExecArgs(opts?.args)
  } catch (e) {
    return { mode: 'denied', reason: e.message }
  }
  const force = !!opts?.force // force=忽略已记住的"允许",重新弹确认;**不**能绕过 deny

  // realpath 必须在策略判定之前:path.resolve 挡不住符号链接与目录穿越
  let rp
  try {
    rp = await fsp.realpath(rp0)
  } catch {
    return { mode: 'denied', reason: '文件不存在或无法访问' }
  }
  if (isSensitive(rp)) return { mode: 'denied', reason: '系统受保护目录中的程序不允许运行' }

  const probe = await probeOne(rp)
  if (probe.error) return { mode: 'denied', reason: probe.error }

  // 600ms 去重:双击手抖开两个实例
  const now = Date.now()
  const key = pathKey(rp)
  const last = execLastRun.get(key)
  if (last && now - last < EXEC_DEDUP_MS) return { mode: 'denied', reason: '刚刚已经启动过了' }
  // 顺手清掉过期条目,免得这张表随用户点过的程序无限增长
  if (execLastRun.size > 64) {
    for (const [k, t] of execLastRun) if (now - t > EXEC_DEDUP_MS) execLastRun.delete(k)
  }

  const cwd = path.dirname(rp)
  const ext = extOf(rp)
  const logBase = { path: rp0, realpath: rp, argvCount: args.length, cwd, level: probe.level }

  // ---- 策略 ----
  const policy = await loadExecPolicy()
  const entry = policy.find((it) => it.path === rp)
  if (entry && !entry.allow) {
    // deny 是硬约束:force 也不能翻(force 只用来"重新确认一次")
    appendExecLog({ ts: now, ...logBase, mode: 'denied', decision: 'deny', pid: null }).catch(() => {})
    return { mode: 'denied', reason: '已被策略拒绝运行' }
  }
  const rememberable = probe.level === 1 && probe.risky.length === 0
  let allowed = !!entry?.allow && !force

  if (!allowed) {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const targetLine = probe.level === 3 ? await describeProxyTarget(rp, probe.kind) : null
    let res
    try {
      res = await dialog.showMessageBox(parent, buildExecConfirm(rp, probe, targetLine, rememberable))
    } catch {
      return { mode: 'denied', reason: '无法显示确认对话框' }
    }
    if (res.response !== 1) {
      execLastRun.set(key, now)
      appendExecLog({ ts: Date.now(), ...logBase, mode: 'denied', decision: 'cancel', pid: null }).catch(() => {})
      return { mode: 'denied', reason: '已取消' }
    }
    if (res.checkboxChecked && rememberable) await rememberExecPolicy(rp, true)
  }

  // ---- 执行 ----
  execLastRun.set(key, Date.now())
  let result
  if (probe.level === 0) {
    // 无执行语义:交给系统。但扩展名属于"被 shell:open 收敛掉"的那批时不能放行,
    // 否则等于绕过了收敛直接 openPath。
    result = OPEN_BLOCK_EXT.has(ext)
      ? { mode: 'denied', reason: process.platform === 'win32' ? '当前系统无法直接运行此文件' : '缺少可执行权限,请先 chmod +x' }
      : await openBySystem(rp)
  } else if (process.platform === 'win32') {
    result = await dispatchWin(rp, args, ext, cwd)
  } else if (process.platform === 'darwin') {
    result = await dispatchMac(rp, args, ext, probe.executable, probe.isBundle, cwd)
  } else {
    result = await dispatchLinux(rp, args, ext, probe.executable, cwd)
  }

  appendExecLog({
    ts: Date.now(),
    ...logBase,
    mode: result.mode,
    decision: result.mode === 'denied' ? 'deny' : 'allow',
    pid: result.pid ?? null,
  }).catch(() => {})
  return result
})

// ---- 图标 ----
const iconCache = new Map() // 'path:size' → dataURL
let iconActive = 0
const iconWaiters = []

function acquireIconSlot() {
  if (iconActive < ICON_CONCURRENCY) {
    iconActive++
    return Promise.resolve()
  }
  return new Promise((r) => iconWaiters.push(r))
}

function releaseIconSlot() {
  const next = iconWaiters.shift()
  if (next) next() // 槽位直接交接,不增减计数
  else iconActive--
}

ipcMain.handle('exec:icon', async (_e, opts) => {
  const size = opts?.size === 'small' || opts?.size === 'large' ? opts.size : 'normal'
  let rp
  try {
    rp = checkPath(opts?.path, false)
  } catch {
    return null
  }
  const cacheKey = rp + ':' + size
  const hit = iconCache.get(cacheKey)
  if (hit) {
    iconCache.delete(cacheKey)
    iconCache.set(cacheKey, hit)
    return hit
  }
  await acquireIconSlot()
  try {
    // 不同版本返回值可能是 Promise 也可能是 NativeImage,两种都接
    const r = app.getFileIcon(rp, { size })
    const img = r && typeof r.then === 'function' ? await r : r
    const url = img && typeof img.toDataURL === 'function' && !img.isEmpty() ? img.toDataURL() : null
    if (url) {
      iconCache.set(cacheKey, url)
      while (iconCache.size > ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value)
    }
    return url
  } catch {
    return null
  } finally {
    releaseIconSlot()
  }
})

// ---------- 回收站 ----------
// 契约:
//   trash:list    → Promise<TrashItem[]>
//   trash:restore → Promise<{ restored, failed }>
//   trash:empty   → Promise<{ cleaned }>(渲染层负责二次确认,主进程直接执行)
// TrashItem = { id, name, originalPath|null, size, deletedAt|null, restorable }
// 平台策略:
//   win32  —— PowerShell + Shell.Application COM:枚举取 Name/Size/
//             System.Recycle.DateDeleted / System.Recycle.DeletedFrom(原路径);
//             还原 = 对匹配 item 调 InvokeVerb('Restore');清空 = Clear-RecycleBin。
//   darwin —— ~/.Trash 直接 readdir/stat;拿不到原路径,靠 trash-meta.json
//             (trashItem 前记录)按「basename 相同 + 删除时间就近 ±5s」匹配;
//             还原 = mkdir -p + rename 回原路径;清空 = 逐项 fsp.rm。
//   linux  —— 未实现,返回空结果(freedesktop Trash 规范留待后续)。
// id 设计:`encodeURIComponent(name)|deletedAt|index` —— name 里的 | / % 等
// 字符都被转义,split('|') 恒得 3 段,restore 时解出 name+deletedAt 用于匹配。

const TRASH_PS_TIMEOUT = 10000
const TRASH_META_MAX = 500
const TRASH_MATCH_TOLERANCE = 5000 // 元数据时间匹配容差(ms)

let trashMeta = null // 惰性加载的 mac 还原元数据 [{ originalPath, deletedAt }]

function trashMetaFile() {
  return path.join(app.getPath('userData'), 'trash-meta.json')
}

async function loadTrashMeta() {
  if (trashMeta) return trashMeta
  try {
    const data = JSON.parse(await fsp.readFile(trashMetaFile(), 'utf8'))
    trashMeta = Array.isArray(data) ? data : []
  } catch {
    trashMeta = []
  }
  return trashMeta
}

async function saveTrashMeta() {
  if (!trashMeta) return
  try {
    await fsp.writeFile(trashMetaFile(), JSON.stringify(trashMeta.slice(-TRASH_META_MAX)))
  } catch {
    /* userData 不可写时放弃,还原功能退化为 restorable=false */
  }
}

/** shell.trashItem 之前记录原路径 —— 拿不到 trash 内最终文件名,采用
 *  「basename(originalPath) 相同 + 时间就近」的简化匹配(见 trashListMac)。 */
async function recordTrashMeta(absPath) {
  if (process.platform !== 'darwin') return
  const meta = await loadTrashMeta()
  meta.push({ originalPath: absPath, deletedAt: Date.now() })
  if (meta.length > TRASH_META_MAX) trashMeta = meta.slice(meta.length - TRASH_META_MAX)
  await saveTrashMeta()
}

/** PowerShell 单引号字符串转义(单引号双写);用于把 JSON 安全嵌进 -Command */
const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'"

/** 带超时的 powershell 调用;超时 kill,输出按 UTF-8 解码(脚本内已设置 OutputEncoding) */
function runPowerShell(script, timeoutMs = TRASH_PS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
      reject(new Error('PowerShell 执行超时'))
    }, timeoutMs)
    p.stdout.on('data', (d) => {
      out += d
    })
    p.stderr.on('data', (d) => {
      err += d
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error((err || '').trim() || `PowerShell 退出码 ${code}`))
    })
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/** ConvertTo-Json 的 DateTime 输出兼容:"\/Date(ms)\/" 或 ISO 字符串 */
function parsePSDate(v) {
  if (v == null) return null
  if (typeof v === 'number') return Math.round(v)
  if (typeof v !== 'string') return null
  const m = v.match(/^\/Date\((\d+)\)\/$/)
  if (m) return Number(m[1])
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : Math.round(t)
}

// ---- Windows 实现 ----

async function trashListWin() {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sh = New-Object -ComObject Shell.Application
$items = @($sh.NameSpace(0xA).Items())
$out = @()
foreach ($it in $items) {
  $out += [PSCustomObject]@{
    Name = $it.Name
    Size = [long]$it.Size
    DateDeleted = $it.ExtendedProperty('System.Recycle.DateDeleted')
    DeletedFrom = $it.ExtendedProperty('System.Recycle.DeletedFrom')
    Path = $it.Path
  }
}
if ($out.Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress }`
  const raw = await runPowerShell(script)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  // ConvertTo-Json 对单元素输出对象而非数组,统一包成数组
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr.map((it, i) => {
    const deletedAt = parsePSDate(it?.DateDeleted)
    const name = String(it?.Name ?? '')
    // 原路径:优先 DeletedFrom 扩展属性;Path 在部分系统才返回原路径,
    // $Recycle.Bin 内部路径不是原路径,必须过滤掉
    const from = typeof it?.DeletedFrom === 'string' && it.DeletedFrom ? it.DeletedFrom : null
    const pth = typeof it?.Path === 'string' && it.Path && !/[\\/]?\$Recycle\.Bin[\\/]/i.test(it.Path) ? it.Path : null
    return {
      id: `${encodeURIComponent(name)}|${deletedAt ?? 0}|${i}`,
      name,
      originalPath: from || pth,
      size: Number(it?.Size) || 0,
      deletedAt,
      restorable: true,
    }
  })
}

async function trashRestoreWin(ids) {
  const targets = []
  for (const id of ids) {
    const parts = String(id).split('|')
    if (parts.length !== 3) continue
    try {
      targets.push({ name: decodeURIComponent(parts[0]), deletedAt: Number(parts[1]) || null })
    } catch {
      /* 非法 encodeURIComponent,跳过 */
    }
  }
  if (!targets.length) return { restored: 0, failed: ids.length }
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sh = New-Object -ComObject Shell.Application
$items = @($sh.NameSpace(0xA).Items())
$targets = ${psStr(JSON.stringify(targets))} | ConvertFrom-Json
$ok = 0; $fail = 0
foreach ($t in $targets) {
  $best = $null; $bestDiff = [double]::MaxValue
  foreach ($it in $items) {
    if ($null -eq $it -or $it.Name -ne $t.name) { continue }
    $dt = $it.ExtendedProperty('System.Recycle.DateDeleted')
    $ms = $null
    if ($dt) { try { $ms = ([DateTimeOffset]$dt).ToUnixTimeMilliseconds() } catch { $ms = $null } }
    if ($null -ne $t.deletedAt -and $null -ne $ms) {
      $diff = [Math]::Abs([double]$ms - [double]$t.deletedAt)
      if ($diff -gt ${TRASH_MATCH_TOLERANCE}) { continue }
      if ($diff -lt $bestDiff) { $bestDiff = $diff; $best = $it }
    } elseif ($null -eq $best) {
      $best = $it
    }
  }
  if ($best) {
    try { $best.InvokeVerb('Restore'); $ok++ } catch { $fail++ }
  } else { $fail++ }
}
@{ restored = $ok; failed = $fail } | ConvertTo-Json -Compress`
  try {
    const r = JSON.parse(await runPowerShell(script))
    return { restored: Number(r?.restored) || 0, failed: Number(r?.failed) || 0 }
  } catch {
    return { restored: 0, failed: targets.length }
  }
}

async function trashEmptyWin() {
  // Clear-RecycleBin 需要 PowerShell 5+;失败直接抛错(rd /s /q C:\$Recycle.Bin
  // 这类兜底太危险,不做)。空回收站的 COM 计数在前,方便渲染层展示「清理了 N 项」。
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sh = New-Object -ComObject Shell.Application
$n = @($sh.NameSpace(0xA).Items()).Count
try {
  Clear-RecycleBin -Force -ErrorAction Stop
  @{ cleaned = $n } | ConvertTo-Json -Compress
} catch {
  Write-Error $_
  exit 1
}`
  const r = JSON.parse(await runPowerShell(script))
  return { cleaned: Number(r?.cleaned) || 0 }
}

// ---- macOS 实现 ----

async function trashListMac() {
  const trashDir = path.join(os.homedir(), '.Trash')
  const meta = await loadTrashMeta()
  let dirents
  try {
    dirents = await fsp.readdir(trashDir, { withFileTypes: true })
  } catch {
    return []
  }
  const items = []
  for (let i = 0; i < dirents.length; i++) {
    const d = dirents[i]
    const fp = path.join(trashDir, d.name)
    let size = 0
    let deletedAt = null
    try {
      const st = await fsp.stat(fp)
      size = st.size
      deletedAt = Math.round(st.mtimeMs) // Finder 移入 .Trash 时会把 mtime 设为删除时刻
    } catch {
      /* 拿不到就算了 */
    }
    // 元数据匹配:basename 相同 + 删除时间就近(±5s),多个候选取差值最小
    let originalPath = null
    let bestDiff = Infinity
    for (const m of meta) {
      if (path.basename(m.originalPath) !== d.name) continue
      const diff = deletedAt == null ? 0 : Math.abs(m.deletedAt - deletedAt)
      if (diff <= TRASH_MATCH_TOLERANCE && diff < bestDiff) {
        bestDiff = diff
        originalPath = m.originalPath
      }
    }
    items.push({
      id: `${encodeURIComponent(d.name)}|${deletedAt ?? 0}|${i}`,
      name: d.name,
      originalPath,
      size,
      deletedAt,
      restorable: !!originalPath,
    })
  }
  return items
}

async function trashRestoreMac(ids) {
  const trashDir = path.join(os.homedir(), '.Trash')
  const meta = await loadTrashMeta()
  let restored = 0
  let failed = 0
  for (const id of ids) {
    const parts = String(id).split('|')
    if (parts.length !== 3) {
      failed++
      continue
    }
    let name
    try {
      name = decodeURIComponent(parts[0])
    } catch {
      failed++
      continue
    }
    const deletedAt = Number(parts[1]) || null
    // 与 list 相同的就近匹配,锁一条元数据
    let bestIdx = -1
    let bestDiff = Infinity
    for (let i = 0; i < meta.length; i++) {
      if (path.basename(meta[i].originalPath) !== name) continue
      const diff = deletedAt == null ? 0 : Math.abs(meta[i].deletedAt - deletedAt)
      if (diff <= TRASH_MATCH_TOLERANCE && diff < bestDiff) {
        bestDiff = diff
        bestIdx = i
      }
    }
    if (bestIdx < 0) {
      failed++
      continue
    }
    const originalPath = meta[bestIdx].originalPath
    try {
      // 目标已存在:宁可失败也不覆盖(可能是用户新建的同名文件)
      if (await pathExists(originalPath)) {
        failed++
        continue
      }
      await fsp.mkdir(path.dirname(originalPath), { recursive: true })
      await fsp.rename(path.join(trashDir, name), originalPath)
      meta.splice(bestIdx, 1)
      restored++
    } catch {
      failed++
    }
  }
  await saveTrashMeta()
  return { restored, failed }
}

async function trashEmptyMac() {
  const trashDir = path.join(os.homedir(), '.Trash')
  let dirents
  try {
    dirents = await fsp.readdir(trashDir, { withFileTypes: true })
  } catch {
    return { cleaned: 0 }
  }
  let cleaned = 0
  for (const d of dirents) {
    try {
      await fsp.rm(path.join(trashDir, d.name), { recursive: true, force: true })
      cleaned++
    } catch {
      /* 权限不足/被占用:跳过 */
    }
  }
  trashMeta = []
  await saveTrashMeta()
  return { cleaned }
}

// ---- IPC 注册(Linux 暂返回空结果) ----

ipcMain.handle('trash:list', () => {
  if (process.platform === 'win32') return trashListWin()
  if (process.platform === 'darwin') return trashListMac()
  return []
})

ipcMain.handle('trash:restore', (_e, ids) => {
  const list = Array.isArray(ids) ? ids.map(String) : []
  if (process.platform === 'win32') return trashRestoreWin(list)
  if (process.platform === 'darwin') return trashRestoreMac(list)
  return { restored: 0, failed: list.length }
})

ipcMain.handle('trash:empty', () => {
  if (process.platform === 'win32') return trashEmptyWin()
  if (process.platform === 'darwin') return trashEmptyMac()
  return { cleaned: 0 }
})

// ---------- 递归搜索 ----------
// 契约:
//   search:start { dir, pattern, maxResults=2000 } → searchId(立即返回,后台跑)
//   进度:event.sender.send('search:progress', { id, results: [...], done:false })
//         每 50 条或 200ms 一批;结束再发一条 { id, results:[], done:true, total, truncated }
//   search:cancel { id } → 置 abort 标志,走完当前队列即发 done
// 实现要点:自写异步 BFS walk(无额外依赖,并发 8 worker);大小写不敏感子串,
// pattern 含 * / ? 时按通配符;熔断 = maxResults / 15s / 20000 目录 / 深度 12;
// 符号链接目录不跟随(withFileTypes 的 dirent 走 lstat 语义,天然满足);
// 隐藏目录默认跳过,pattern 以 . 开头时不跳过;多个搜索可并存(Map by id)。

const searches = new Map() // id → { aborted }
let searchSeq = 0
const SEARCH_LIMITS = {
  timeMs: 15000,
  maxDirs: 20000,
  maxDepth: 12,
  concurrency: 8,
  batchSize: 50,
  flushMs: 200,
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** pattern 含 * / ? → 通配符正则;否则大小写不敏感子串 */
function buildMatcher(pattern) {
  if (/[*?]/.test(pattern)) {
    const re = new RegExp(
      '^' +
        pattern
          .split(/(\*|\?)/)
          .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : escapeRegex(part)))
          .join('') +
        '$',
      'i'
    )
    return (name) => re.test(name)
  }
  const lower = pattern.toLowerCase()
  return (name) => name.toLowerCase().includes(lower)
}

function sendSearchProgress(sender, payload) {
  if (!sender || sender.isDestroyed()) return false
  try {
    sender.send('search:progress', payload)
  } catch {
    return false
  }
  return true
}

async function runSearch(sender, id, root, pattern, maxResults) {
  const s = { aborted: false }
  searches.set(id, s)
  const match = buildMatcher(pattern)
  const includeHidden = pattern.startsWith('.')
  const deadline = Date.now() + SEARCH_LIMITS.timeMs
  const queue = [{ dir: root, depth: 0 }]
  let dirs = 0
  let total = 0
  let truncated = false
  let stop = false
  let batch = []
  let lastFlush = Date.now()

  const flush = (force) => {
    if (!batch.length) return
    if (!force && batch.length < SEARCH_LIMITS.batchSize && Date.now() - lastFlush < SEARCH_LIMITS.flushMs) return
    if (sendSearchProgress(sender, { id, results: batch, done: false })) {
      lastFlush = Date.now()
    } else {
      stop = true // 窗口没了,继续搜也没有意义
    }
    batch = []
  }

  const shouldStop = () => {
    if (stop || s.aborted) return true
    if (Date.now() > deadline || dirs >= SEARCH_LIMITS.maxDirs || total >= maxResults) {
      truncated = true
      return true
    }
    return false
  }

  async function worker() {
    while (queue.length) {
      if (shouldStop()) return
      const item = queue.shift()
      dirs++
      let entries
      try {
        entries = await fsp.readdir(item.dir, { withFileTypes: true })
      } catch {
        continue // 无权限 / 已删除:跳过该子树
      }
      for (const e of entries) {
        if (s.aborted) return
        if (e.isDirectory()) {
          // 符号链接目录的 dirent.isDirectory() 为 false,不会被入队(不跟随)
          if (!includeHidden && e.name.startsWith('.')) continue
          if (item.depth + 1 <= SEARCH_LIMITS.maxDepth) {
            queue.push({ dir: path.join(item.dir, e.name), depth: item.depth + 1 })
          }
        }
      }
      // 本目录内的匹配项:并发 stat 后入批
      const matched = entries.filter((e) => match(e.name))
      if (matched.length) {
        await Promise.all(
          matched.map(async (e) => {
            const fp = path.join(item.dir, e.name)
            let size = 0
            try {
              size = (await fsp.stat(fp)).size
            } catch {
              /* 竞态删除 */
            }
            batch.push({ name: e.name, path: fp, size, isDir: e.isDirectory() })
          })
        )
        total += matched.length
        if (total >= maxResults) truncated = true
      }
      flush(false) // 满 50 立即发,否则 200ms 时间片到点发
    }
  }

  await Promise.all(Array.from({ length: SEARCH_LIMITS.concurrency }, () => worker()))
  flush(true)
  sendSearchProgress(sender, { id, results: [], done: true, total, truncated })
  searches.delete(id)
}

/**
 * 启动递归搜索。dir 过 checkPath;path 字段返回本机绝对路径
 * (Windows 上含反斜杠,渲染层自行 toVirtualPath)。
 */
ipcMain.handle('search:start', (event, opts) => {
  const dir = checkPath(opts?.dir, false)
  const pattern = typeof opts?.pattern === 'string' ? opts.pattern : ''
  if (!pattern.trim()) throw new Error('缺少搜索关键字')
  const maxResults = Math.max(1, Math.min(Number(opts?.maxResults) || 2000, 100000))
  const id = 's-' + Date.now().toString(36) + '-' + (++searchSeq).toString(36)
  runSearch(event.sender, id, dir, pattern, maxResults).catch(() => {
    // 兜底:runSearch 内部不应抛,万一抛了也要让渲染层收到 done 不至于干等
    sendSearchProgress(event.sender, { id, results: [], done: true, total: 0, truncated: false })
    searches.delete(id)
  })
  return id
})

ipcMain.on('search:cancel', (_e, payload) => {
  const s = payload && searches.get(payload.id)
  if (s) s.aborted = true
})

// ---------- 程序元数据(版本信息 / 数字签名 / 来源标记)与已安装程序 ----------
// 契约:
//   exec:meta(path)         → Promise<ExecMeta>          永不抛错,失败降级成 error 字段
//   exec:uninstallList()    → Promise<{ items: InstalledApp[], unsupported?: boolean }>
//   exec:uninstall({ app }) → Promise<{ ok, error? }>     二次确认框由本 handler 内部弹
//
// ExecMeta = { path, name?, version?, publisher?, description?, productName?,
//              signed: boolean|null, signer?: string|null, motw: boolean, error?: string }
//   signed:null = 平台不支持或未检测出结论;true/false = 已验证结果
//   motw       = 「来自互联网」标记(Win Zone.Identifier / mac com.apple.quarantine)
// InstalledApp = { id, name, version?, publisher?, installDate?, installLocation?,
//                  estimatedSize?, uninstallString, quietUninstallString?,
//                  iconPath?, isSystemComponent? }
//
// 安全与性能要点:
//   1) 一律 spawn(cmd, argsArray, { shell:false }):UninstallString 是字符串,
//      先 winTokenize 分词再数组化,绝不整串交给 shell。
//   2) 卸载确认框走主进程 dialog.showMessageBox(渲染层自绘弹窗可被伪造/自动点击),
//      默认焦点在「取消」,不给「记住选择」—— 卸载是不可撤销操作。
//   3) 路径过 checkPath;审计日志复用 appendExecLog,只记程序 id 与参数个数,不记命令内容。
//   4) 子进程一律带超时 + windowsHide + 输出限长;超时即 kill。
//   5) PowerShell 冷启动 200~400ms:meta 按 `path:mtimeMs` 缓存(上限 1000 条,
//      并发同路径共享一次子进程),已安装程序整表缓存 5 分钟。
//   6) 不提权:卸载程序自己弹 UAC,我们只是把命令原样启动起来。

const META_TIMEOUT = 10000 // 单次元数据探测超时(PS 冷启动 + 签名校验)
const META_OUT_MAX = 256 * 1024 // 单次探测的输出上限(异常文件可能吐出巨量文本)
const META_CACHE_MAX = 1000 // meta 结果缓存条数(LRU)
const META_STR_MAX = 300 // 单个字符串字段长度上限(防异常超长值把 UI 撑爆)
const UNINSTALL_PS_TIMEOUT = 15000 // 注册表枚举:3 个 hive 数百项,慢机器上 10s 不够
const UNINSTALL_CACHE_MS = 5 * 60 * 1000 // 已安装程序列表缓存时长
// 位于系统受保护目录、但仍允许作为卸载程序启动的白名单(MsiExec/rundll32 在 System32)
const UNINSTALL_EXE_ALLOW = new Set(['msiexec.exe', 'rundll32.exe'])

/**
 * 捕获子进程输出:超时 kill 并 reject;非 0 退出码**不** reject ——
 * codesign / xattr 这类工具就是靠退出码说话(未签名、无隔离属性都是正常结果)。
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCapture(cmd, args, timeoutMs = META_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (e) {
      return reject(e)
    }
    const out = []
    const err = []
    let outLen = 0
    let errLen = 0
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error('命令执行超时'))
    }, timeoutMs)
    const done = (code) => {
      clearTimeout(timer)
      resolve({
        code: code == null ? -1 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    }
    child.stdout.on('data', (d) => {
      if (outLen < META_OUT_MAX) {
        out.push(d)
        outLen += d.length
      }
    })
    child.stderr.on('data', (d) => {
      if (errLen < META_OUT_MAX) {
        err.push(d)
        errLen += d.length
      }
    })
    child.on('close', done)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/** 规范化元数据字符串:去控制字符、限长;空值返回 undefined(不进结果,渲染层直接判空) */
function metaStr(v, max = META_STR_MAX) {
  let s
  if (typeof v === 'string') s = v
  else if (typeof v === 'number' && Number.isFinite(v)) s = String(v)
  else return undefined
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!s) return undefined
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 从 X.509 Subject 里抽 CN=(兼容 CN="Foo, Inc." 的带引号写法) */
function cnFromSubject(s) {
  const str = typeof s === 'string' ? s : ''
  const m = /(?:^|,)\s*CN\s*=\s*("(?:[^"]|"")*"|[^,]*)/i.exec(str)
  if (!m) return null
  let v = m[1].trim()
  // 引号包裹时内部 "" 是转义后的字面引号
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1).replace(/""/g, '"')
  return metaStr(v) || null
}

/**
 * Get-AuthenticodeSignature 状态 → signed。
 * 枚举(数值):Valid=0 / UnknownError=1 / NotSigned=2 / HashMismatch=3 / NotTrusted=4 / NotSupported=5
 * 映射:NotSigned → false;Valid → true;其余(校验失败、不受信任、不支持)一律 null
 * —— 拿不到确定结论时不替用户下判断。名称优先,数值兜底,跨 PowerShell 版本都稳。
 */
function mapSignStatus(name, num) {
  const n = String(name ?? '').trim()
  if (/^Valid$/i.test(n) || num === 0) return true
  if (/^NotSigned$/i.test(n) || num === 2) return false
  return null
}

// ---- Windows:一次 PowerShell 同时取版本资源 + 数字签名 + Zone.Identifier ----
function metaScriptWin(rp) {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = ${psStr(rp)}
$o = [ordered]@{}
if (Test-Path -LiteralPath $p -PathType Leaf) {
  try {
    $vi = (Get-Item -LiteralPath $p).VersionInfo
    $o['ProductName'] = $vi.ProductName
    $o['FileDescription'] = $vi.FileDescription
    $o['CompanyName'] = $vi.CompanyName
    $o['FileVersion'] = $vi.FileVersion
    $o['ProductVersion'] = $vi.ProductVersion
  } catch { }
  try {
    $s = Get-AuthenticodeSignature -LiteralPath $p
    $o['SignStatus'] = [int]$s.Status
    $o['SignName'] = [string]$s.Status
    $cert = $s.SignerCertificate
    if ($cert) { $o['Signer'] = $cert.Subject } else { $o['Signer'] = $null }
  } catch { }
}
# Zone.Identifier lives in an NTFS alternate data stream; -Stream is unsupported on
# non-NTFS volumes, hence -ErrorAction SilentlyContinue (PS 脚本内注释一律用 ASCII,
# 避免 -Command 命令行解码差异把注释里的多字节字符搅乱)
try {
  $o['Motw'] = [bool](Get-Item -LiteralPath $p -Stream Zone.Identifier -ErrorAction SilentlyContinue)
} catch {
  $o['Motw'] = $false
}
$o | ConvertTo-Json -Compress`
}

async function metaWin(rp) {
  const raw = await runPowerShell(metaScriptWin(rp), META_TIMEOUT)
  let o = {}
  try {
    o = JSON.parse(raw) || {}
  } catch {
    o = {}
  }
  const signed = mapSignStatus(o.SignName, o.SignStatus)
  return {
    name: metaStr(o.ProductName) || metaStr(o.FileDescription) || path.basename(rp),
    version: metaStr(o.FileVersion) || metaStr(o.ProductVersion),
    publisher: metaStr(o.CompanyName),
    description: metaStr(o.FileDescription),
    productName: metaStr(o.ProductName),
    signed,
    // 只有验证通过的签名才报签名者:未通过验证时证书链不可信,报名字反而误导
    signer: signed === true ? cnFromSubject(o.Signer) : null,
    motw: !!o.Motw,
  }
}

// ---- macOS:Info.plist(plutil 转 JSON,兼容二进制 plist)+ codesign + xattr ----
async function metaDarwin(rp) {
  const isBundle = isAppBundle(rp)
  const out = { signed: null, signer: null, motw: false }
  if (isBundle) {
    // plutil -convert json -o - 直接打到 stdout,省掉临时文件;二进制 plist 也能读
    const r = await runCapture('plutil', ['-convert', 'json', '-o', '-', path.join(rp, 'Contents', 'Info.plist')], META_TIMEOUT)
    if (r.code === 0) {
      let o = null
      try {
        o = JSON.parse(r.stdout)
      } catch {
        o = null
      }
      if (o) {
        out.name = metaStr(o.CFBundleDisplayName) || metaStr(o.CFBundleName)
        out.version = metaStr(o.CFBundleShortVersionString) || metaStr(o.CFBundleVersion)
        out.productName = metaStr(o.CFBundleName)
        out.description = metaStr(o.CFBundleGetInfoString) || metaStr(o.NSHumanReadableCopyright)
      }
    }
  }
  if (!out.name) out.name = path.basename(rp, isBundle ? '.app' : '')
  // codesign 的诊断输出全部走 stderr,stdout 基本是空的,两路一起看
  const cs = await runCapture('codesign', ['-dv', '--verbose=2', rp], META_TIMEOUT)
  const text = (cs.stdout || '') + '\n' + (cs.stderr || '')
  if (/code object is not signed/i.test(text)) {
    out.signed = false
  } else if (cs.code === 0) {
    out.signed = true
    // --verbose=2 会逐层打印证书链,第一条 Authority 是叶子证书即签名者
    const m = /Authority=(.+)/.exec(text)
    out.signer = metaStr(m ? m[1] : null) || null
  }
  const x = await runCapture('xattr', ['-p', 'com.apple.quarantine', rp], META_TIMEOUT)
  out.motw = x.code === 0
  return out
}

// ---- Linux:.desktop 解析键值;ELF 没有内嵌版本资源,只给文件名 ----
async function metaLinux(rp) {
  if (extOf(rp) === '.desktop') {
    const de = await parseDesktopFile(rp)
    if (de) {
      return {
        name: metaStr(de.name) || metaStr(de.genericName) || path.basename(rp, '.desktop'),
        version: metaStr(de.version),
        description: metaStr(de.comment) || metaStr(de.genericName),
        productName: metaStr(de.name),
        signed: null,
        signer: null,
        motw: false,
      }
    }
  }
  // ELF / 脚本 / 其它:strings 抽版本号不可靠(会抽到一堆无关字符串),不做
  return { name: path.basename(rp), signed: null, signer: null, motw: false }
}

function buildExecMeta(rp) {
  if (process.platform === 'win32') return metaWin(rp)
  if (process.platform === 'darwin') return metaDarwin(rp)
  return metaLinux(rp)
}

// ---- meta 缓存(LRU)与并发去重 ----
const metaCache = new Map() // 'path:mtimeMs' → ExecMeta
const metaInflight = new Map() // key → Promise:同一路径并发请求只跑一次子进程

function metaCacheGet(key) {
  const hit = metaCache.get(key)
  if (!hit) return null
  metaCache.delete(key)
  metaCache.set(key, hit) // 命中即挪到末尾(LRU)
  return hit
}

function metaCacheSet(key, val) {
  metaCache.delete(key)
  metaCache.set(key, val)
  while (metaCache.size > META_CACHE_MAX) metaCache.delete(metaCache.keys().next().value)
}

ipcMain.handle('exec:meta', async (_e, p) => {
  let rp
  try {
    rp = checkPath(p, false)
  } catch (e) {
    return { path: String(p ?? ''), signed: null, signer: null, motw: false, error: e.message }
  }
  let st
  try {
    st = await fsp.stat(rp)
  } catch {
    return { path: rp, signed: null, signer: null, motw: false, error: '文件不存在或无法访问' }
  }
  // key 含 mtime:文件一改(version 资源随之变)缓存立即失效
  const key = rp + ':' + Math.round(st.mtimeMs)
  const hit = metaCacheGet(key)
  if (hit) return hit
  const pending = metaInflight.get(key)
  if (pending) return pending
  const task = (async () => {
    let meta
    try {
      meta = await buildExecMeta(rp)
    } catch (e) {
      // 永不抛错:探测失败一律降级,渲染层只显示拿不到的字段为空
      return { path: rp, signed: null, signer: null, motw: false, error: String(e?.message || e) }
    }
    const out = {
      path: rp,
      name: meta.name,
      version: meta.version,
      publisher: meta.publisher,
      description: meta.description,
      productName: meta.productName,
      signed: meta.signed === true || meta.signed === false ? meta.signed : null,
      signer: meta.signer ?? null,
      motw: !!meta.motw,
    }
    metaCacheSet(key, out)
    return out
  })().finally(() => metaInflight.delete(key))
  metaInflight.set(key, task)
  return task
})

// ---------- 已安装程序列表(Windows 注册表) ----------
// 只读注册表,不需要管理员权限。三个位置:
//   HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*           (64 位)
//   HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\* (32 位)
//   HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*            (当前用户)
function uninstallScriptWin() {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$out = foreach ($p in $paths) {
  foreach ($it in @(Get-ItemProperty -Path $p -ErrorAction SilentlyContinue)) {
    # skip unnamed / system component / child entries
    if (-not $it.DisplayName) { continue }
    if ($it.SystemComponent -eq 1) { continue }
    if ($it.ParentDisplayName) { continue }
    # entries without an uninstall command (patches) cannot be removed, drop them
    if (-not $it.UninstallString) { continue }
    [pscustomobject]@{
      Id = $it.PSChildName
      DisplayName = $it.DisplayName
      DisplayVersion = $it.DisplayVersion
      Publisher = $it.Publisher
      InstallDate = $it.InstallDate
      InstallLocation = $it.InstallLocation
      EstimatedSize = $it.EstimatedSize
      UninstallString = $it.UninstallString
      QuietUninstallString = $it.QuietUninstallString
      DisplayIcon = $it.DisplayIcon
      SystemComponent = $it.SystemComponent
    }
  }
}
$out = @($out)
if ($out.Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress }`
}

/** DisplayIcon 常带图标索引后缀("...,0" / "...,-1"),剥掉后交给渲染层 getFileIcon */
function stripIconIndex(v) {
  let s = metaStr(v, 1000)
  if (!s) return undefined
  // 惰性匹配取最后一个「,整数」;引号内的逗号不参与切分
  const m = /^(.*?)(?:\s*,\s*[-+]?\d+)$/.exec(s)
  if (m && m[1].trim()) s = m[1].trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim()
  return s || undefined
}

function parseInstalledApps(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  // ConvertTo-Json 对单元素集合输出对象而非数组,统一包一层
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const seen = new Set()
  const items = []
  for (const it of arr) {
    const name = metaStr(it?.DisplayName, 200)
    const uninstallString = metaStr(it?.UninstallString, 4000)
    if (!name || !uninstallString) continue
    // id 用注册表项名;32/64 位视图偶有重名,加后缀保证唯一
    let id = metaStr(it?.Id, 200) || name + '@' + items.length
    if (seen.has(id)) {
      let n = 2
      while (seen.has(id + '#' + n)) n++
      id = id + '#' + n
    }
    seen.add(id)
    const size = Number(it?.EstimatedSize)
    items.push({
      id,
      name,
      version: metaStr(it?.DisplayVersion, 100),
      publisher: metaStr(it?.Publisher, 200),
      installDate: metaStr(it?.InstallDate, 32), // YYYYMMDD,注册表里也可能是数字
      installLocation: metaStr(it?.InstallLocation, 1000),
      estimatedSize: Number.isFinite(size) && size > 0 ? Math.round(size) : undefined, // KB
      uninstallString,
      quietUninstallString: metaStr(it?.QuietUninstallString, 4000),
      iconPath: stripIconIndex(it?.DisplayIcon),
      isSystemComponent: Number(it?.SystemComponent) === 1 ? true : undefined,
    })
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return items
}

let uninstallCache = null // { at: epochMs, items: InstalledApp[] }
let uninstallInflight = null // 并发调用共享同一次 PowerShell,避免冷启动 N 遍

ipcMain.handle('exec:uninstallList', async () => {
  // 只有 Windows 有统一的卸载注册表;其余平台不支持
  if (process.platform !== 'win32') return { items: [], unsupported: true }
  if (uninstallCache && Date.now() - uninstallCache.at < UNINSTALL_CACHE_MS) return { items: uninstallCache.items }
  if (uninstallInflight) return uninstallInflight
  uninstallInflight = (async () => {
    try {
      const items = parseInstalledApps(await runPowerShell(uninstallScriptWin(), UNINSTALL_PS_TIMEOUT))
      uninstallCache = { at: Date.now(), items }
      return { items }
    } catch (e) {
      // 失败不缓存:下次还能重试;error 是契约外的补充字段,渲染层可忽略
      return { items: [], error: String(e?.message || e) }
    } finally {
      uninstallInflight = null
    }
  })()
  return uninstallInflight
})

// ---------- 执行卸载 ----------
/** 卸载命令里可能出现 %ProgramFiles% 之类;只展开已知环境变量,未命中的原样保留 */
function expandEnvVars(s) {
  return String(s).replace(/%([A-Za-z_][A-Za-z0-9_]*(?:\(x86\))?)%/g, (m, name) => process.env[name] ?? m)
}

ipcMain.handle('exec:uninstall', async (event, opts) => {
  if (process.platform !== 'win32') return { ok: false, error: '当前平台不支持卸载已安装程序' }
  const app = opts?.app
  if (!app || typeof app !== 'object') return { ok: false, error: '参数无效' }
  const name = metaStr(app.name, 200) || '未知程序'
  const cmdline = metaStr(app.uninstallString, 4000)
  if (!cmdline) return { ok: false, error: '该程序没有提供卸载命令' }

  // ---- 二次确认:原生框,渲染层自绘弹窗可被伪造/自动点击,不能交给它 ----
  const lines = ['此操作将调用程序自带的卸载程序,无法撤销。']
  const publisher = metaStr(app.publisher, 200)
  const version = metaStr(app.version, 100)
  if (publisher) lines.push('', '发布者:' + escapeHidden(publisher))
  if (version) lines.push('版本:' + escapeHidden(version))
  lines.push('', '卸载命令:', '  ' + escapeHidden(cmdline))
  if (hasHiddenChars(name) || hasHiddenChars(cmdline) || (publisher && hasHiddenChars(publisher))) {
    lines.push('', '⚠ 文本含隐藏字符,已转义显示,请仔细核对。')
  }
  let res
  try {
    res = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      buttons: ['取消', '卸载'],
      defaultId: 0, // 默认焦点落在「取消」
      cancelId: 0,
      noLink: true,
      // 不给「记住选择」:卸载不可撤销,每次都要用户亲自确认
      message: `卸载「${escapeHidden(name)}」?`,
      detail: lines.join('\n'),
    })
  } catch {
    return { ok: false, error: '无法显示确认对话框' }
  }
  const logId = metaStr(app.id, 200) || name
  if (res.response !== 1) {
    appendExecLog({ ts: Date.now(), path: logId, realpath: logId, argvCount: 0, cwd: null, level: 1, mode: 'denied', decision: 'cancel', pid: null }).catch(() => {})
    return { ok: false, error: '已取消' }
  }

  // ---- 分词:UninstallString 是字符串,按 CommandLineToArgvW 规则切开再数组化 ----
  // 顺序很关键:**先分词再展开环境变量**。反过来的话,%ProgramFiles% 展开出的
  // "C:\Program Files\..." 会被随后的分词按空格切成两段,路径就断了 —— 而数组化传递时
  // 一个 argv 元素即使含空格也是完整的一条参数,正是卸载程序期望的形态。
  const argv = winTokenize(cmdline).map(expandEnvVars).filter((t) => t !== '')
  if (!argv.length) return { ok: false, error: '卸载命令无法解析' }
  const exe = resolveCommand(argv[0])
  if (!exe) return { ok: false, error: `找不到卸载程序:${escapeHidden(argv[0])}` }
  // 系统目录下的卸载程序只允许白名单(MsiExec/rundll32),挡掉 cmd.exe /c 这类伪造条目
  if (isSensitive(exe) && !UNINSTALL_EXE_ALLOW.has(path.basename(exe).toLowerCase())) {
    return { ok: false, error: '卸载程序位于受保护的系统位置,已阻止' }
  }
  const loc = metaStr(app.installLocation, 1000)
  const cwd = loc && fs.existsSync(loc) ? loc : path.dirname(exe)
  uninstallCache = null // 卸载已触发,列表缓存立即失效

  // 发射后不管:卸载程序通常自己弹 UAC,我们不提权也不等它结束
  const r = await spawnExec(exe, argv.slice(1), { cwd })
  if (!r.ok) return { ok: false, error: mapExecError(r.error) }
  // 审计只记程序 id 与参数个数,不记命令内容
  appendExecLog({
    ts: Date.now(),
    path: logId,
    realpath: logId,
    argvCount: argv.length - 1,
    cwd,
    level: 1,
    mode: 'spawn',
    decision: 'uninstall',
    pid: r.pid ?? null,
  }).catch(() => {})
  return { ok: true }
})

// ---------- 本地文件流协议 ----------
// 安全模型:网页侧只能通过渲染进程显式 fs:grant 授权过的绝对路径取文件;
// 转码产物目录(temp/mx-fm-transcode)内的文件免授权,因为 URL 是主进程自己生成的。
// 其余一切(包括 ../ 逃逸、NUL 注入、任意本地文件读取)一律 403。
function registerMxfileProtocol() {
  protocol.handle('mxfile', (request) => {
    let p
    try {
      p = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // Windows 的 '/C:/x' 需剥掉开头斜杠;mac/Linux 的绝对路径必须保留,否则会被当成相对路径解析
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    if (p.includes('\0')) return new Response('bad request', { status: 400 })
    let rp
    try {
      rp = checkPath(p, false)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const inTranscodeDir = isUnder(rp, TRANSCODE_DIR)
    if (!allowedPaths.has(pathKey(rp)) && !inTranscodeDir) {
      console.warn('[mx-fm] mxfile:// 拒绝未授权路径:', rp)
      return new Response('forbidden', { status: 403 })
    }
    // net.fetch 原生支持 Range 请求 → <video> 拖动进度条可用
    return net.fetch(pathToFileURL(rp).href)
  })
}

// ---------- 单实例锁 ----------
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
} else {
  // 再次启动(点击 dock/开始菜单图标、双击 exe):开新窗口,与主流文件管理器一致
  app.on('second-instance', () => {
    createWindow()
  })

  app.whenReady().then(() => {
    buildMenu()
    if (process.platform === 'darwin') {
      app.setAboutPanelOptions({ applicationName: 'MX 文件管理器', applicationVersion: app.getVersion(), credits: '点击文件直接预览、编辑、播放' })
    }
    // 清理过期转码产物(异步,不阻塞窗口创建)
    cleanTranscodeCache().catch(() => {})
    registerMxfileProtocol()
    createWindow()
    app.on('activate', () => {
      // mac dock 点击:窗口全关后复活
      if (wins.size === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // mac 惯例:全关后进程驻留(dock 可再 activate);其余平台直接退出
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前关掉全部目录监听,不留给 chokidar 的底层句柄
  app.on('will-quit', () => {
    stopAllWatchers()
    // 只清跟踪表,不 kill 子进程:用户启动的程序与我们无关,不该被我们带走
    clearExecProcs()
  })
}
