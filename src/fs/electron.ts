import type { FSProvider, FileEntry, RootInfo } from './types'
import { moveEntry } from './ops'
import { joinPath, parentOf, baseName, segments, altName } from '../utils/path'
import { extOf, mimeOf } from '../utils/format'
import { MemoryProvider } from './memory'

interface Api {
  boot(): Promise<{ platform: string; version: string; roots: { name: string; path: string }[]; specials: { name: string; path: string }[] }>
  list(p: string): Promise<{ name: string; kind: 'file' | 'directory'; size: number; modified: number | null }[]>
  read(p: string, start?: number, length?: number): Promise<Uint8Array>
  write(p: string, data: Uint8Array): Promise<void>
  mkdir(p: string): Promise<void>
  createFile(p: string): Promise<void>
  remove(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  exists(p: string): Promise<boolean>
  pickFolder(): Promise<string | null>
  reveal(p: string): Promise<void>
  openInSystem(p: string): Promise<string | null>
  memory(): Promise<{ rss: number; heapUsed: number }>
}

/**
 * 桌面版(Electron)Provider:
 * - 内部虚拟路径统一为 '/C:/Users/...' 形式(与浏览器版 '/根名/...' 同构,UI 零改动)
 * - 特殊目录(桌面/下载等)与用户手动添加的文件夹作为命名根
 * - 演示模式通过内嵌 MemoryProvider 支持
 */
export class ElectronProvider implements FSProvider {
  kind = 'native' as const
  platform = 'win32'
  private api: Api
  private bases = new Map<string, string>() // 虚拟根名 → 本地路径(以 / 结尾)
  private mem = new MemoryProvider()

  constructor(api: unknown) {
    this.api = api as Api
  }

  async boot(): Promise<void> {
    const info = await this.api.boot()
    this.platform = info.platform
    for (const r of info.roots) this.bases.set(r.name, r.path.replace(/\/+$/, '') + '/')
    for (const s of info.specials) this.bases.set(s.name, s.path.replace(/\/+$/, '') + '/')
  }

  rootInfos(): RootInfo[] {
    const out: RootInfo[] = []
    for (const name of this.bases.keys()) out.push({ name, kind: 'native', needsAuth: false })
    for (const name of this.mem.listRootNames()) out.push({ name, kind: 'memory', needsAuth: false })
    return out
  }

  /** 添加用户选择的文件夹,返回虚拟根名 */
  addUserRoot(nativePath: string): string {
    const clean = nativePath.replace(/\\/g, '/').replace(/\/+$/, '')
    const base = segments(clean).pop() || clean
    let name = base
    let i = 2
    while (this.bases.has(name) || this.mem.hasRoot(name)) name = altName(base, i++)
    this.bases.set(name, clean + '/')
    return name
  }

  pickFolder(): Promise<string | null> {
    return this.api.pickFolder()
  }

  reveal(path: string): Promise<void> {
    return this.api.reveal(this.toNative(path))
  }

  /** 用系统默认程序打开文件(Word/WPS 等外部应用) */
  async openInSystem(path: string): Promise<void> {
    if (this.isMem(path)) throw new Error('演示数据只存在于内存中,无法用系统程序打开')
    const err = await this.api.openInSystem(this.toNative(path))
    if (err) throw new Error(err)
  }

  /** 主进程内存(RSS) */
  mainMemory(): Promise<{ rss: number; heapUsed: number }> {
    return this.api.memory()
  }

  private isMem(path: string): boolean {
    return this.mem.hasRoot(segments(path)[0])
  }

  private toNative(path: string): string {
    const segs = segments(path)
    const base = this.bases.get(segs[0])
    if (!base) throw new Error(`未找到根目录「${segs[0]}」`)
    return base + segs.slice(1).join('/')
  }

  addRoot(handle: unknown): void {
    this.mem.addRoot(handle)
  }

  removeRoot(name: string): void {
    if (this.bases.delete(name)) return
    this.mem.removeRoot(name)
  }

  hasRoot(name: string): boolean {
    return this.bases.has(name) || this.mem.hasRoot(name)
  }

  async list(path: string): Promise<FileEntry[]> {
    if (this.isMem(path)) return this.mem.list(path)
    const raw = await this.api.list(this.toNative(path))
    return raw.map((r) => ({
      name: r.name,
      path: joinPath(path, r.name),
      kind: r.kind,
      size: r.size,
      modified: r.modified,
      ext: r.kind === 'file' ? extOf(r.name) : '',
    }))
  }

  async getFile(path: string): Promise<File> {
    if (this.isMem(path)) return this.mem.getFile(path)
    const buf = await this.api.read(this.toNative(path))
    const name = baseName(path)
    return new File([buf as BlobPart], name, { type: mimeOf(extOf(name)) })
  }

  async readBytes(path: string, start = 0, length?: number): Promise<Uint8Array> {
    if (this.isMem(path)) return this.mem.readBytes(path, start, length)
    return this.api.read(this.toNative(path), start, length)
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(content))
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    if (this.isMem(path)) return this.mem.writeBytes(path, data)
    await this.api.write(this.toNative(path), data)
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    if (this.isMem(path)) return this.mem.writeBlob(path, blob)
    await this.writeBytes(path, new Uint8Array(await blob.arrayBuffer()))
  }

  async mkdir(path: string): Promise<void> {
    if (this.isMem(path)) return this.mem.mkdir(path)
    await this.api.mkdir(this.toNative(path))
  }

  async createFile(path: string): Promise<void> {
    if (this.isMem(path)) return this.mem.createFile(path)
    await this.api.createFile(this.toNative(path))
  }

  async remove(path: string, kind: 'file' | 'directory'): Promise<void> {
    if (this.isMem(path)) return this.mem.remove(path, kind)
    await this.api.remove(this.toNative(path))
  }

  async rename(path: string, kind: 'file' | 'directory', newName: string): Promise<string> {
    if (this.isMem(path)) return this.mem.rename(path, kind, newName)
    const parent = parentOf(path)
    const target = joinPath(parent, newName)
    if (await this.exists(target)) throw new Error('目标位置已存在同名项目')
    try {
      await this.api.rename(this.toNative(path), this.toNative(target))
      return target
    } catch (e) {
      // 跨盘等场景退回通用复制+删除
      if (e instanceof Error && e.message.includes('EXDEV')) {
        const entry: FileEntry = { name: baseName(path), path, kind, size: 0, modified: null, ext: extOf(baseName(path)) }
        await moveEntry(this, entry, this.toNative(target))
        return target
      }
      throw e
    }
  }

  async exists(path: string): Promise<boolean> {
    if (this.isMem(path)) return this.mem.exists(path)
    return this.api.exists(this.toNative(path))
  }

  async uniqueName(dir: string, name: string): Promise<string> {
    for (let i = 2; ; i++) {
      const cand = altName(name, i)
      if (!(await this.exists(joinPath(dir, cand)))) return cand
    }
  }

  /** 视频/音频用自定义协议流式播放,不占用内存;演示根回退到 blob URL */
  mediaUrl(path: string): string | undefined {
    if (this.isMem(path)) return undefined
    return 'mxfile://localhost/' + encodeURIComponent(this.toNative(path))
  }
}
