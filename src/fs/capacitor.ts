import type { FSProvider, FileEntry, RootInfo } from './types'
import { joinPath, parentOf, baseName, segments, altName } from '../utils/path'
import { extOf, mimeOf } from '../utils/format'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { MemoryProvider } from './memory'

/**
 * Android(移动版)Provider —— 基于 Capacitor Filesystem 插件。
 * 根目录:内部存储(共享存储根,需"所有文件访问"权限)+ 应用私有目录。
 * 注意:大视频/音频暂以 base64 读入内存(移动版 v1 限制)。
 */

// Directory.ExternalStorage 在 TS 枚举里叫 ExternalStorage;老版本可能没有,兜底取值
const EXT_STORAGE = (Directory as Record<string, string>).ExternalStorage ?? 'EXTERNAL_STORAGE'

interface ReaddirFile {
  name: string
  size?: number
  mtime?: number
  type: 'file' | 'directory'
}

export function isCapacitorNative(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform()
}

export class CapacitorProvider implements FSProvider {
  kind = 'native' as const
  platform = 'android'
  private bases = new Map<string, { dir: Directory; base: string }>()
  private mem = new MemoryProvider()

  async boot(): Promise<void> {
    this.bases.set('内部存储', { dir: EXT_STORAGE as Directory, base: '' })
    this.bases.set('应用文件', { dir: Directory.Data, base: '' })
    this.bases.set('文档', { dir: EXT_STORAGE as Directory, base: 'Documents' })
    this.bases.set('下载', { dir: EXT_STORAGE as Directory, base: 'Download' })
    this.bases.set('图片', { dir: EXT_STORAGE as Directory, base: 'DCIM' })
  }

  rootInfos(): RootInfo[] {
    const out: RootInfo[] = [...this.bases.keys()].map((name) => ({ name, kind: 'native' as const, needsAuth: false }))
    for (const name of this.mem.listRootNames()) out.push({ name, kind: 'memory', needsAuth: false })
    return out
  }

  private isMem(path: string): boolean {
    return this.mem.hasRoot(segments(path)[0])
  }

  addRoot(handle: unknown): void {
    this.mem.addRoot(handle)
  }

  removeRoot(name: string): void {
    this.bases.delete(name)
    this.mem.removeRoot(name)
  }

  hasRoot(name: string): boolean {
    return this.bases.has(name) || this.mem.hasRoot(name)
  }

  private route(path: string): { dir: Directory; rel: string } {
    const segs = segments(path)
    const base = this.bases.get(segs[0])
    if (!base) throw new Error(`未找到根目录「${segs[0]}」`)
    return { dir: base.dir, rel: [base.base, ...segs.slice(1)].filter(Boolean).join('/') }
  }

  async list(path: string): Promise<FileEntry[]> {
    if (this.isMem(path)) return this.mem.list(path)
    const { dir, rel } = this.route(path)
    const r = await Filesystem.readdir({ path: rel || '/', directory: dir })
    return r.files
      .map((f) => ({
        name: f.name,
        path: joinPath(path, f.name),
        kind: f.type === 'directory' ? 'directory' : 'file',
        size: f.size ?? 0,
        modified: f.mtime ?? null,
        ext: f.type === 'directory' ? '' : extOf(f.name),
      }))
  }

  async getFile(path: string): Promise<File> {
    if (this.isMem(path)) return this.mem.getFile(path)
    const { dir, rel } = this.route(path)
    const r = await Filesystem.readFile({ path: rel, directory: dir, encoding: Encoding.ASCII })
    const bytes =
      typeof r.data === 'string'
        ? Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))
        : new Uint8Array(await (r.data as unknown as Blob).arrayBuffer())
    const name = baseName(path)
    return new File([bytes.buffer as ArrayBuffer], name, { type: mimeOf(extOf(name)) })
  }

  async readBytes(path: string, start = 0, length?: number): Promise<Uint8Array> {
    if (this.isMem(path)) return this.mem.readBytes(path, start, length)
    const f = await this.getFile(path)
    const all = new Uint8Array(await f.arrayBuffer())
    return all.slice(start, length != null ? start + length : undefined)
  }

  async writeText(path: string, content: string): Promise<void> {
    if (this.isMem(path)) return this.mem.writeText(path, content)
    const { dir, rel } = this.route(path)
    await Filesystem.writeFile({ path: rel, directory: dir, data: content, encoding: Encoding.UTF8, recursive: true })
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    if (this.isMem(path)) return this.mem.writeBytes(path, data)
    const { dir, rel } = this.route(path)
    let bin = ''
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i])
    await Filesystem.writeFile({ path: rel, directory: dir, data: btoa(bin), recursive: true })
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    if (this.isMem(path)) return this.mem.writeBlob(path, blob)
    await this.writeBytes(path, new Uint8Array(await blob.arrayBuffer()))
  }

  async mkdir(path: string): Promise<void> {
    if (this.isMem(path)) return this.mem.mkdir(path)
    const { dir, rel } = this.route(path)
    try {
      await Filesystem.mkdir({ path: rel, directory: dir, recursive: true })
    } catch (e) {
      if (!String(e).includes('exists')) throw e
    }
  }

  async createFile(path: string): Promise<void> {
    if (this.isMem(path)) return this.mem.createFile(path)
    const { dir, rel } = this.route(path)
    try {
      await Filesystem.writeFile({ path: rel, directory: dir, data: '', recursive: true })
    } catch (e) {
      if (!String(e).includes('exists')) throw e
    }
  }

  async remove(path: string, kind: 'file' | 'directory'): Promise<void> {
    if (this.isMem(path)) return this.mem.remove(path, kind)
    const { dir, rel } = this.route(path)
    if (kind === 'directory') await Filesystem.rmdir({ path: rel, directory: dir, recursive: true })
    else await Filesystem.deleteFile({ path: rel, directory: dir })
  }

  async rename(path: string, kind: 'file' | 'directory', newName: string): Promise<string> {
    if (this.isMem(path)) return this.mem.rename(path, kind, newName)
    const parent = parentOf(path)
    const target = joinPath(parent, newName)
    if (await this.exists(target)) throw new Error('目标位置已存在同名项目')
    const from = this.route(path)
    const to = this.route(target)
    await Filesystem.rename({ from: from.rel, to: to.rel, directory: from.dir, toDirectory: to.dir })
    return target
  }

  async exists(path: string): Promise<boolean> {
    if (this.isMem(path)) return this.mem.exists(path)
    try {
      const { dir, rel } = this.route(path)
      if (rel === '') return true
      await Filesystem.stat({ path: rel, directory: dir })
      return true
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
