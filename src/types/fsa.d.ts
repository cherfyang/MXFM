// File System Access API 中 TS lib.dom 未覆盖的部分
declare interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  values(): AsyncIterableIterator<FileSystemHandle>
}
declare interface FileSystemHandle {
  queryPermission?(desc?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(desc?: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}
