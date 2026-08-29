const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net } = require('electron')
const path = require('node:path')
const fsp = require('node:fs/promises')
const { pathToFileURL } = require('node:url')

// 允许渲染进程通过自定义协议流式访问本地文件(视频拖动进度条需要 Range 支持)
// standard+secure 让 <img>/<video> 等标签可以直接以 mxfile:// 作为源
protocol.registerSchemesAsPrivileged([
  { scheme: 'mxfile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
])

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#17181b',
    autoHideMenuBar: true,
    title: 'MX 文件管理器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    // 开发模式:默认连 vite dev server(先运行 npm run electron:dev)
    win.loadURL('http://localhost:5188/').catch(() => {
      win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    })
  }
  win.on('closed', () => {
    win = null
  })
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
