// 轻量 IndexedDB 封装:
// - roots store:持久化目录授权句柄(结构化克隆支持 FileSystemHandle)
// - kv store:通用键值(如主页扫描缓存,替代 localStorage 的大 JSON)
const DB_NAME = 'mx-filemanager'
const STORE = 'roots'
const KV = 'kv'

// 连接单例:每次操作新开连接会持续累积活跃 IDBDatabase,
// 且版本升级被旧连接阻塞时 onblocked 会让 promise 永不 settle
let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' })
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV)
    }
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用,请关闭后重试'))
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(req.error)
  })
  return dbPromise
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

/** kv store 通用读取 */
export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = db.transaction(KV, 'readonly').objectStore(KV).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

/** kv store 通用写入(值需可结构化克隆) */
export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, 'readwrite')
    tx.objectStore(KV).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
