import type { Category } from '../utils/categories'

/** 文件/目录条目(纯数据,不含句柄,可安全放入剪贴板/撤销栈) */
export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number
  modified: number | null
  ext: string
}

export interface RootInfo {
  name: string
  kind: 'fsa' | 'memory' | 'native'
  needsAuth: boolean
}

export interface CopyResult {
  created: string[]
  overwritten: number
  skipped: number
}

export type ConflictMode = 'overwrite' | 'skip' | 'keepBoth'

/** 所有 UI 只依赖这个接口 —— 换壳(浏览器→Tauri)时只需新增一个实现 */
export interface FSProvider {
  kind: 'fsa' | 'memory' | 'native'
  addRoot(handle: unknown): void
  removeRoot(name: string): void
  hasRoot(name: string): boolean
  list(path: string): Promise<FileEntry[]>
  getFile(path: string): Promise<File>
  readBytes(path: string, start?: number, length?: number): Promise<Uint8Array>
  writeText(path: string, content: string): Promise<void>
  writeBytes(path: string, data: Uint8Array): Promise<void>
  writeBlob(path: string, blob: Blob): Promise<void>
  mkdir(path: string): Promise<void>
  createFile(path: string): Promise<void>
  remove(path: string, kind: 'file' | 'directory'): Promise<void>
  rename(path: string, kind: 'file' | 'directory', newName: string): Promise<string>
  exists(path: string): Promise<boolean>
  uniqueName(dir: string, name: string): Promise<string>
  /** 桌面版:本地文件的流式播放地址(视频/音频);返回 undefined 则走 blob URL */
  mediaUrl?(path: string): string | undefined
  /** 桌面版:虚拟路径 → 本地绝对路径 */
  toNativePath?(path: string): string
  /** 桌面版:用系统默认程序打开(外部应用,如 Word) */
  openInSystem?(path: string): Promise<void>
}
