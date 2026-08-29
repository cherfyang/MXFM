const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mxAPI', {
  boot: () => ipcRenderer.invoke('sys:boot'),
  list: (p) => ipcRenderer.invoke('fs:list', p),
  read: (p, start, length) => ipcRenderer.invoke('fs:read', p, start, length),
  write: (p, data) => ipcRenderer.invoke('fs:write', p, data),
  mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
  createFile: (p) => ipcRenderer.invoke('fs:createFile', p),
  remove: (p) => ipcRenderer.invoke('fs:remove', p),
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openInSystem: (p) => ipcRenderer.invoke('shell:open', p),
  memory: () => ipcRenderer.invoke('sys:memory'),
})
