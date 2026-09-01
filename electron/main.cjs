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
        let size = 0
        let modified = null
        try {
          const st = await fsp.stat(path.join(dir, d.name))
          size = st.size
          modified = st.mtimeMs
        } catch {
          /* 并发删除等 */
        }
        out[i + j] = {
          name: d.name,
          kind: d.isDirectory() ? 'directory' : 'file',
          size,
          modified,
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

ipcMain.handle('shell:open', async (_e, p) => {
  const r = await shell.openPath(checkPath(p, false))
  return r || null // 返回非空字符串表示错误信息
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
  })
}
