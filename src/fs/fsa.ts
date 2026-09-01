import type { FSProvider, FileEntry } from './types'
import { joinPath, parentOf, baseName, segments, altName } from '../utils/path'
import { extOf } from '../utils/format'
import { moveEntry } from './ops'
import { MemoryProvider } from './memory'

type DirHandle = FileSystemDirectoryHandle
type FileHandle = FileSystemFileHandle

/**
 * 基于 File System Access API 的 Provider(Edge/Chrome)。
 * 没有真正的 rename/move,统一用"读 → 写新位置 → 删旧位置"实现。
 * 内嵌 MemoryProvider:演示模式与本地授权根共存。
 */
export class FsaProvider implements FSProvider {
  kind = 'fsa' as const
  private roots = new Map<string, DirHandle>()
  private mem = new MemoryProvider()
  private dirCache = new Map<string, DirHandle>()

  addRoot(handle: unknown): void {
    const h = handle as { children?: unknown }
    if (h && h.children instanceof Map) {
      this.mem.addRoot(handle)
      return
    }
    const dh = handle as DirHandle
    this.roots.set(dh.name, dh)
  }

  removeRoot(name: string): void {
    if (this.roots.delete(name)) {
      for (const key of [...this.dirCache.keys()]) {
        if (key === `/${name}` || key.startsWith(`/${name}/`)) this.dirCache.delete(key)
      }
      return
    }
    this.mem.removeRoot(name)
  }

  hasRoot(name: string): boolean {
    return this.roots.has(name) || this.mem.hasRoot(name)
  }

  private isMem(path: string): boolean {
    return this.mem.hasRoot(segments(path)[0])
  }

  private async resolveDir(path: string): Promise<DirHandle> {
    const cached = this.dirCache.get(path)
    if (cached) return cached
    const segs = segments(path)
    if (segs.length === 0) throw new Error('无效路径')
    const root = this.roots.get(segs[0])
    if (!root) throw new Error(`未找到根目录「${segs[0]}」,可能已被移除`)
    let h: DirHandle = root
    for (let i = 1; i < segs.length; i++) h = await h.getDirectoryHandle(segs[i])
    this.dirCache.set(path, h)
    return h
  }

  private resolveParent(path: string): Promise<DirHandle> {
    return this.resolveDir(parentOf(path))
  }

  async list(path: string): Promise<FileEntry[]> {
    if (this.isMem(path)) return this.mem.list(path)
    const dir = await this.resolveDir(path)
    const handles: [string, FileSystemHandle][] = []
    for await (const ent of dir.entries()) handles.push(ent)

    const entries: FileEntry[] = new Array(handles.length)
    const CH = 64
    for (let i = 0; i < handles.length; i += CH) {
      await Promise.all(
        handles.slice(i, i + CH).map(async ([name, h], j) => {
          const p = joinPath(path, name)
          if (h.kind === 'file') {
            let size = 0
            let modified: number | null = null
            try {
              const f = await (h as FileHandle).getFile()
              size = f.size
              modified = f.lastModified
            } catch {
              /* 文件被并发删除等情况 */
            }
            entries[i + j] = { name, path: p, kind: 'file', size, modified, ext: extOf(name) }
          } else {
            entries[i + j] = { name, path: p, kind: 'directory', size: 0, modified: null, ext: '' }
          }
        })
      )
    }
    return entries.filter(Boolean)
  }

  async getFile(path: string): Promise<File> {
    if (this.isMem(path)) return this.mem.getFile(path)
    const dir = await this.resolveParent(path)
    const fh = await dir.getFileHandle(baseName(path))
    return fh.getFile()
  }

  async readBytes(path: string, start = 0, length?: number): Promise<Uint8Array> {
    if (this.isMem(path)) return this.mem.readBytes(path, start, length)
    const f = await this.getFile(path)
    const end = length != null ? start + length : undefined
    const buf = await f.slice(start, end).arrayBuffer()
    return new Uint8Array(buf)
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(content))
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await this.writeBlob(path, new Blob([data as BlobPart]))
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    if (this.isMem(path)) return this.mem.writeBlob(path, blob)
    const dir = await this.resolveParent(path)
    const fh = await dir.getFileHandle(baseName(path), { create: true })
    const w = await fh.createWritable()
    await w.write(blob)
    await w.close()
  }

  async mkdir(path: string): Promise<void> {
    if (this.isMem(path)) return this.mem.mkdir(path)
    const dir = await this.resolveParent(path)
    const h = await dir.getDirectoryHandle(baseName(path), { create: true })
    this.dirCache.set(path, h)
  }

  async createFile(path: string): Promise<void> {
    if (this.isMem(path)) return this.mem.createFile(path)
    const dir = await this.resolveParent(path)
    await dir.getFileHandle(baseName(path), { create: true })
  }

  async remove(path: string, kind: 'file' | 'directory'): Promise<void> {
    if (this.isMem(path)) return this.mem.remove(path, kind)
    const dir = await this.resolveParent(path)
    await dir.removeEntry(baseName(path), kind === 'directory' ? { recursive: true } : {})
    for (const key of [...this.dirCache.keys()]) {
      if (key === path || key.startsWith(path + '/')) this.dirCache.delete(key)
    }
  }

  async rename(path: string, kind: 'file' | 'directory', newName: string): Promise<string> {
    if (this.isMem(path)) return this.mem.rename(path, kind, newName)
    const parent = parentOf(path)
    const target = joinPath(parent, newName)
    // 仅大小写不同时不算冲突(部分后端是大小写不敏感的,exists 命中的就是自己)
    if (target !== path && (await this.exists(target))) throw new Error('目标位置已存在同名项目')
    const entry: FileEntry = { name: baseName(path), path, kind, size: 0, modified: null, ext: extOf(baseName(path)) }
    await moveEntry(this, entry, target)
    for (const key of [...this.dirCache.keys()]) {
      if (key === path || key.startsWith(path + '/')) this.dirCache.delete(key)
    }
    return target
  }

  async exists(path: string): Promise<boolean> {
    if (this.isMem(path)) return this.mem.exists(path)
    try {
      const dir = await this.resolveParent(path)
      const name = baseName(path)
      try {
        await dir.getFileHandle(name)
        return true
      } catch {
        try {
          await dir.getDirectoryHandle(name)
          return true
        } catch {
          return false
        }
      }
    } catch {
      return false
    }
  }

  async uniqueName(dir: string, name: string): Promise<string> {
    for (let i = 2; ; i++) {
      const cand = altName(name, i)
      if (!(await this.exists(joinPath(dir, cand)))) return cand
    }
  }
}
