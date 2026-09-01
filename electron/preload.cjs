// 沙箱化 preload:只依赖 'electron' 提供的 contextBridge / ipcRenderer,
// 不使用 path / fs / os 等任何 Node 内置模块,因此 main.cjs 的 sandbox:true 是安全的。
// 若将来需要 Node 能力,必须由主进程通过 IPC 提供,不能在这里直接 require。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mxAPI', {
  boot: () => ipcRenderer.invoke('sys:boot'),
  list: (p) => ipcRenderer.invoke('fs:list', p),
  read: (p, start, length) => ipcRenderer.invoke('fs:read', p, start, length),
  write: (p, data) => ipcRenderer.invoke('fs:write', p, data),
  mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
  createFile: (p) => ipcRenderer.invoke('fs:createFile', p),
  remove: (p) => ipcRenderer.invoke('fs:remove', p),
  removePermanent: (p) => ipcRenderer.invoke('fs:removePermanent', p),
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openInSystem: (p) => ipcRenderer.invoke('shell:open', p),
  memory: () => ipcRenderer.invoke('sys:memory'),
  transcode: (p, kind) => ipcRenderer.invoke('transcode:start', p, kind),
  transcodeCancel: () => ipcRenderer.invoke('transcode:cancel'),
  onMenuAction: (cb) => ipcRenderer.on('menu-action', (_e, action) => cb(action)),

  // ---- 批量流式复制/移动作业 ----
  // 用法:onOpProgress/onOpDone 挂监听(返回取消订阅函数)
  //      → opStart(payload) 拿到 id → 需要时 opCancel(id)
  opStart: (payload) => ipcRenderer.invoke('fs:op:start', payload),
  opCancel: (id) => ipcRenderer.send('fs:op:cancel', { id }),
  onOpProgress: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('fs:op:progress', h)
    return () => ipcRenderer.removeListener('fs:op:progress', h)
  },
  onOpDone: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('fs:op:done', h)
    return () => ipcRenderer.removeListener('fs:op:done', h)
  },

  // mxfile:// 白名单授权:返回 URL 之前必须先 grant,否则协议侧 403。
  // 默认走 sendSync 同步通道,保证「授权先于 URL 被使用」;grantAsync 是等价的异步版本。
  grant: (paths) => ipcRenderer.sendSync('fs:grant:sync', paths),
  grantAsync: (paths) => ipcRenderer.invoke('fs:grant', paths),
  revoke: (paths) => ipcRenderer.invoke('fs:revoke', paths),

  // ---- 目录实时监听 ----
  // 用法:watchStart(dir) 拿到 watchId → onFsChanged(cb) 收到 { watchId, dir } 后刷新该目录
  //      → watchStop(id) 关单个;watchStopAll 关全部(窗口关闭时主进程也会兜底)
  watchStart: (dir) => ipcRenderer.invoke('fs:watch:start', dir),
  watchStop: (id) => ipcRenderer.invoke('fs:watch:stop', id),
  watchStopAll: () => ipcRenderer.invoke('fs:watch:stopAll'),
  onFsChanged: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('fs:watch:event', h)
    return () => ipcRenderer.removeListener('fs:watch:event', h)
  },

  // ---- 系统剪贴板文件读写(与 Explorer/Finder 互拷) ----
  // clipWrite:paths 为本地绝对路径数组,cut=true 表示剪切;clipRead 读不到文件时返回 null
  // (mac Finder 不支持剪切文件,读回的 cut 恒为 false)
  clipWrite: (paths, cut) => ipcRenderer.invoke('clip:write', { paths, cut }),
  clipRead: () => ipcRenderer.invoke('clip:read'),

  // ---- 在终端打开 ----
  openInTerminal: (dir) => ipcRenderer.invoke('shell:openTerminal', dir),

  // ---- 回收站 ----
  // TrashItem = { id, name, originalPath|null, size, deletedAt|null, restorable }
  // trashEmpty 由渲染层负责二次确认,主进程直接执行清空
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: (ids) => ipcRenderer.invoke('trash:restore', ids),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),

  // ---- 递归搜索 ----
  // 用法:searchStart({ dir, pattern, maxResults }) 拿到 searchId
  //      → onSearchProgress(cb) 批量收结果({ id, results, done })
  //        最后一条 done:true 带 { total, truncated }
  //      → 中途可 searchCancel(id);结果 path 为本机绝对路径(渲染层自行 toVirtualPath)
  searchStart: (opts) => ipcRenderer.invoke('search:start', opts),
  searchCancel: (id) => ipcRenderer.send('search:cancel', { id }),
  onSearchProgress: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('search:progress', h)
    return () => ipcRenderer.removeListener('search:progress', h)
  },
})
