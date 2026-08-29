const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { pathToFileURL } = require('node:url')

// 允许渲染进程通过自定义协议流式访问本地文件(视频拖动进度条需要 Range 支持)
// standard+secure 让 <img>/<video> 等标签可以直接以 mxfile:// 作为源
protocol.registerSchemesAsPrivileged([
  { scheme: 'mxfile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
])

let win = null

// ---------- 窗口大小位置记忆 ----------
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window-state.json'), 'utf8'))
  } catch {
    return null
  }
}

function createWindow() {
  const saved = loadWindowState()
  win = new BrowserWindow({
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
      sandbox: false,
    },
  })
  if (saved?.maximized) win.maximize()
  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    // 开发模式:默认连 vite dev server(先运行 npm run electron:dev)
    win.loadURL('http://localhost:5188/').catch(() => {
      win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    })
  }
  // 关闭时保存窗口状态(最大化只记标记,不记坐标)
  win.on('close', () => {
    if (!win) return
    const state = win.isMaximized() || win.isFullScreen() ? { maximized: true } : { ...win.getBounds(), maximized: false }
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'window-state.json'), JSON.stringify(state))
    } catch {
      /* ignore */
    }
  })
  win.on('closed', () => {
    win = null
  })
}

// ---------- 应用菜单(中文;mac 依赖 editMenu 提供剪贴板快捷键) ----------
function sendAction(action) {
  if (win) win.webContents.send('menu-action', action)
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
        { type: 'separator' },
        { label: '刷新', accelerator: 'F5', click: () => sendAction('refresh') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: '退出', role: 'quit' }]),
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '查看',
      submenu: [
        { role: 'togglefullscreen', label: '全屏' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '开发者工具' }]),
      ],
    },
    isMac
      ? { role: 'windowMenu', label: '窗口' }
      : { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] },
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

ipcMain.handle('fs:list', (_e, p) => listDir(p))

ipcMain.handle('fs:stat', async (_e, p) => {
  const st = await fsp.stat(p)
  return { size: st.size, modified: st.mtimeMs, isDir: st.isDirectory() }
})

ipcMain.handle('fs:read', async (_e, p, start = 0, length) => {
  const fh = await fsp.open(p, 'r')
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
  await fsp.writeFile(p, Buffer.from(data))
})

ipcMain.handle('fs:mkdir', (_e, p) => fsp.mkdir(p, { recursive: true }))

ipcMain.handle('fs:createFile', async (_e, p) => {
  const fh = await fsp.open(p, 'a')
  await fh.close()
})

// 删除进回收站,失败(网络盘等)再彻底删除
ipcMain.handle('fs:remove', async (_e, p) => {
  try {
    await shell.trashItem(p)
    return 'trash'
  } catch {
    await fsp.rm(p, { recursive: true, force: true })
    return 'deleted'
  }
})

ipcMain.handle('fs:rename', async (_e, from, to) => {
  try {
    await fsp.rename(from, to)
    return 'moved'
  } catch (e) {
    if (e.code === 'EXDEV') throw e // 跨盘由渲染层走复制+删除兜底
    throw e
  }
})

ipcMain.handle('fs:exists', async (_e, p) => {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择要添加的文件夹',
  })
  if (r.canceled || !r.filePaths.length) return null
  return r.filePaths[0].replace(/\\/g, '/')
})

ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p))

ipcMain.handle('shell:open', async (_e, p) => {
  const r = await shell.openPath(p)
  return r || null // 返回非空字符串表示错误信息
})

ipcMain.handle('sys:memory', () => {
  const m = process.memoryUsage()
  return { rss: m.rss, heapUsed: m.heapUsed }
})

// ---------- 本地文件流协议 ----------
app.whenReady().then(() => {
  buildMenu()
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: 'MX 文件管理器', applicationVersion: app.getVersion(), credits: '点击文件直接预览、编辑、播放' })
  }
  protocol.handle('mxfile', (request) => {
    try {
      const u = new URL(request.url)
      const p = decodeURIComponent(u.pathname).replace(/^\/+/, '')
      return net.fetch(pathToFileURL(p))
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })
  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
