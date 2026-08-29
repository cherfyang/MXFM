// 轻量 IndexedDB 封装:只用来持久化目录授权句柄(结构化克隆支持 FileSystemHandle)
const DB_NAME = 'mx-filemanager'
const STORE = 'roots'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'name' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export interface StoredRoot {
  name: string
  handle: FileSystemDirectoryHandle
}

export async function idbAllRoots(): Promise<StoredRoot[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result as StoredRoot[])
    req.onerror = () => reject(req.error)
  })
}

export async function idbPutRoot(name: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put({ name, handle })
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function idbDeleteRoot(name: string): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}
