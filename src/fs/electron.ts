import type { FSProvider, FileEntry, RootInfo } from './types'
import { abortError, type BulkJob, type BulkOptions, type BulkResult, type BulkStatus } from './ops'
import { joinPath, parentOf, baseName, segments, altName } from '../utils/path'
import { extOf, mimeOf } from '../utils/format'
import { MemoryProvider } from './memory'

/** 主进程回传的逐项结果(src/dst 是本地绝对路径) */
interface RawBulkResult {
  src: string
  dst: string
  status: BulkStatus
  error?: string
}

interface RawProgress {
  id: string
  fileIndex: number
  fileCount: number
  bytesDone: number
  bytesTotal: number
  currentName: string
}

interface RawDone {
  id: string
  ok: boolean
  error?: string
  results: RawBulkResult[]
}

interface Api {
  boot(): Promise<{ platform: string; version: string; roots: { name: string; path: string }[]; specials: { name: string; path: string }[] }>
  list(p: string): Promise<{ name: string; kind: 'file' | 'directory'; size: number; modified: number | null }[]>
  read(p: string, start?: number, length?: number): Promise<Uint8Array>
  write(p: string, data: Uint8Array): Promise<void>
  mkdir(p: string): Promise<void>
  createFile(p: string): Promise<void>
  /** 失败会 throw(如该位置不支持回收站),绝不静默降级为永久删除 */
  remove(p: string): Promise<{ trashed: boolean }>
  removePermanent(p: string): Promise<{ trashed: boolean }>
  rename(from: string, to: string): Promise<void>
  exists(p: string): Promise<boolean>
  pickFolder(): Promise<string | null>
  reveal(p: string): Promise<void>
  openInSystem(p: string): Promise<string | null>
  memory(): Promise<{ rss: number; heapUsed: number }>
  /** 批量流式作业(可选:旧版 preload 没有,此时退回逐文件复制) */
  opStart?(payload: {
    kind: 'copy' | 'move'
    mode: 'overwrite' | 'skip' | 'keepboth'
    jobs: { src: string; dst: string; isDir: boolean }[]
  }): Promise<string>
  opCancel?(id: string): void
  onOpProgress?(cb: (p: RawProgress) => void): () => void
  onOpDone?(cb: (r: RawDone) => void): () => void
}

/** rename 失败但主进程批量通道可以兜底的 errno(与 main.cjs 的 RENAME_FALLBACK 对齐) */
const RENAME_FALLBACK = /EXDEV|EPERM|EACCES|ENOTEMPTY|EEXIST|EISDIR|ENOTDIR|EBUSY|EMLINK|ENOSPC|EROFS/

function mxApi(): { grant?(paths: string[]): void } | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { mxAPI?: { grant?(paths: string[]): void } }).mxAPI
}

/**
 * 编码成 mxfile:// 的 pathname,与主进程
 * `decodeURIComponent(new URL(request.url).pathname)` 严格对称。
 * encodeURI 保留盘符冒号(Windows 的 'C:')和路径分隔符,URL 可读;
 * 它漏掉的 # 与 ? 会截断 URL(分别被当成分片和查询串),这里补编码;
 * % 由 encodeURI 自己处理,不能再预处理,否则会二次编码成 %25 → %2525。
 */
export function encodeMediaPath(p: string): string {
  return encodeURI(p).replace(/[?#]/g, (c) => (c === '#' ? '%23' : '%3F'))
}

/** 拼 mxfile:// URL。路径自带前导 / 时不能再补一个,否则主进程会解出 '//...' */
export function mediaFileUrl(nativePath: string): string {
  const enc = encodeMediaPath(nativePath)
  return enc.startsWith('/') ? 'mxfile://localhost' + enc : 'mxfile://localhost/' + enc
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

  /** 本地绝对路径 → 虚拟路径。根之间可能互相嵌套(如 C: 与 C:/Users/mx/桌面),取最长匹配 */
  private toVirtual(nativePath: string): string {
    const n = nativePath.replace(/\\/g, '/').replace(/\/+$/, '')
    let bestName: string | null = null
    let bestRest = ''
    for (const [name, rawBase] of this.bases) {
      const base = rawBase.replace(/\\/g, '/').replace(/\/+$/, '')
      let rest: string | null = null
      if (n === base) rest = ''
      else if (n.startsWith(base + '/')) rest = n.slice(base.length + 1)
      if (rest === null) continue
      if (bestName === null || rest.length < bestRest.length) {
        bestName = name
        bestRest = rest
      }
    }
    if (bestName === null) throw new Error(`路径不在任何已挂载的根目录内:「${nativePath}」`)
    return bestRest ? `/${bestName}/${bestRest}` : `/${bestName}`
  }

  toNativePath(path: string): string {
    return this.toNative(path)
  }

  /** 本地绝对路径 → 虚拟路径(公开包装,供 stores 层处理 watch/系统剪贴板回调) */
  toVirtualPath(nativePath: string): string {
    return this.toVirtual(nativePath)
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
    await this.removeWithResult(path, kind, false)
  }

  /** 彻底删除(Shift+Delete):不经过回收站/废纸篓 */
  async removePermanent(path: string, kind: 'file' | 'directory'): Promise<void> {
    await this.removeWithResult(path, kind, true)
  }

  /**
   * 删除并回传是否进了回收站/废纸篓。
   * 主进程失败(网络盘、无回收站的挂载点)会直接 throw —— 这里绝不降级为永久删除,
   * 宁可让 UI 提示「此位置不支持回收站」。
   */
  async removeWithResult(path: string, kind: 'file' | 'directory', permanent = false): Promise<{ trashed: boolean }> {
    if (this.isMem(path)) {
      await this.mem.remove(path, kind)
      return { trashed: false }
    }
    if (permanent) {
      await this.api.removePermanent(this.toNative(path))
      return { trashed: false }
    }
    const r = await this.api.remove(this.toNative(path))
    return { trashed: r?.trashed === true }
  }

  async rename(path: string, kind: 'file' | 'directory', newName: string): Promise<string> {
    if (this.isMem(path)) return this.mem.rename(path, kind, newName)
    const parent = parentOf(path)
    const target = joinPath(parent, newName)
    // 仅大小写不同时不算冲突:Windows 上 exists 命中的就是自己
    if (target !== path && (await this.exists(target))) throw new Error('目标位置已存在同名项目')
    try {
      await this.api.rename(this.toNative(path), this.toNative(target))
      return target
    } catch (e) {
      // 跨盘/目标非空等:整棵子树交给主进程流式搬运(先 rename,失败再流式复制+删源)
      if (e instanceof Error && RENAME_FALLBACK.test(e.message)) {
        const out = await this.moveMany([{ src: path, dst: target, isDir: kind === 'directory' }], { mode: 'overwrite' })
        const r = out[0]
        if (r && r.status !== 'failed') return r.dst
        throw new Error(r?.error || e.message)
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
    let native = this.toNative(path)
    // 协议侧按 '/' 解析盘符,Windows 混进来的 '\' 先统一掉
    if (this.platform === 'win32') native = native.replace(/\\/g, '/')
    // 主进程已对 mxfile:// 做白名单校验:返回 URL 之前必须先授权,否则一律 403。
    // grant 走 sendSync 同步通道,保证授权一定早于 <video>/<img> 的首次请求。
    mxApi()?.grant?.([native])
    return mediaFileUrl(native)
  }

  /* ---------------- 批量流式复制/移动 ---------------- */

  supportsBulk(paths: string[]): boolean {
    if (typeof this.api.opStart !== 'function') return false
    return paths.every((p) => !this.isMem(p))
  }

  copyMany(jobs: BulkJob[], opts: BulkOptions): Promise<BulkResult[]> {
    return this.runBulk('copy', jobs, opts)
  }

  moveMany(jobs: BulkJob[], opts: BulkOptions): Promise<BulkResult[]> {
    return this.runBulk('move', jobs, opts)
  }

  /**
   * 整批作业交给主进程:opStart 拿 opId → 转发 progress → done 时 resolve/throw。
   * 订阅在 start 之前挂上(作业一启动就会发事件),按 id 过滤自己那一路。
   */
  private runBulk(kind: 'copy' | 'move', jobs: BulkJob[], opts: BulkOptions): Promise<BulkResult[]> {
    const api = this.api
    if (typeof api.opStart !== 'function') {
      return Promise.reject(new Error('当前主进程不支持批量流式作业'))
    }
    const payload = {
      kind,
      mode: opts.mode,
      jobs: jobs.map((j) => ({ src: this.toNative(j.src), dst: this.toNative(j.dst), isDir: j.isDir })),
    }
    return new Promise<BulkResult[]>((resolve, reject) => {
      let id = ''
      let settled = false
      let offProgress: (() => void) | null = null
      let offDone: (() => void) | null = null
      let onAbort: (() => void) | null = null

      const cleanup = () => {
        offProgress?.()
        offDone?.()
        offProgress = null
        offDone = null
        if (onAbort) {
          opts.signal?.removeEventListener('abort', onAbort)
          onAbort = null
        }
      }
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }

      offProgress = api.onOpProgress?.((p) => {
        if (p.id !== id) return
        opts.onProgress?.({
          fileIndex: p.fileIndex,
          fileCount: p.fileCount,
          bytesDone: p.bytesDone,
          bytesTotal: p.bytesTotal,
          currentName: p.currentName,
        })
      }) ?? null
      offDone = api.onOpDone?.((r) => {
        if (r.id !== id) return
        if (r.ok) finish(() => resolve(this.toVirtualResults(jobs, r.results ?? [])))
        else if (r.error === 'cancelled') finish(() => reject(abortError()))
        else finish(() => reject(new Error(r.error || '文件操作失败')))
      }) ?? null

      api.opStart!(payload).then(
        (opId) => {
          id = opId
          if (settled) return
          if (opts.signal?.aborted) {
            api.opCancel?.(opId)
            finish(() => reject(abortError()))
            return
          }
          if (!opts.signal) return
          onAbort = () => {
            api.opCancel?.(id)
            finish(() => reject(abortError()))
          }
          opts.signal.addEventListener('abort', onAbort, { once: true })
        },
        (e: unknown) => {
          finish(() => reject(e instanceof Error ? e : new Error(String(e))))
        }
      )
    })
  }

  /** 主进程回传的本地绝对路径换回虚拟路径,results 与入参 jobs 下标对齐 */
  private toVirtualResults(jobs: BulkJob[], raw: RawBulkResult[]): BulkResult[] {
    return jobs.map((job, i) => {
      const r = raw[i]
      const status: BulkStatus = r?.status ?? 'failed'
      let dst = job.dst
      if (r?.dst) dst = this.toVirtualSafe(r.dst, job.dst)
      return {
        src: job.src,
        dst,
        status,
        error: r?.error || (status === 'failed' ? '未知错误' : undefined),
      }
    })
  }

  private toVirtualSafe(nativePath: string, fallback: string): string {
    try {
      return this.toVirtual(nativePath)
    } catch {
      return fallback
    }
  }
}

/* ---------------- 回收站 + 递归搜索(本轮主进程新增能力) ---------------- */

/** 回收站条目(主进程 trashList 的返回结构,一字不差) */
export interface TrashItem {
  id: string
  name: string
  originalPath: string | null
  size: number
  deletedAt: number | null
  restorable: boolean
}

/** 递归搜索进度事件(results[].path 为本机绝对路径,Windows 含反斜杠) */
export interface SearchProgress {
  id: string
  results: { name: string; path: string; size: number; isDir: boolean }[]
  done: boolean
  total?: number
  truncated?: boolean
}

/**
 * 本轮新增的 preload 能力,与 stores/fs.ts 的 NativeExtras(watch/clip/终端)互相独立。
 * stores 层沿 fs.ts 调用 nativeExtras() 的同一模式直接使用本对象,
 * 虚拟/本机路径转换仍走 ElectronProvider 的 toVirtualPath/toNativePath。
 */
export interface NativeExtras2 {
  trashList(): Promise<TrashItem[]>
  trashRestore(ids: string[]): Promise<{ restored: number; failed: number }>
  trashEmpty(): Promise<{ cleaned: number }>
  searchStart(opts: { dir: string; pattern: string; maxResults?: number }): Promise<string>
  searchCancel(id: string): void
  onSearchProgress(cb: (p: SearchProgress) => void): () => void
}

/**
 * 能力探测(独立探测,不并入 fs.ts 的 nativeExtras):
 * 旧版 preload 缺这批方法时返回 null,回收站/递归搜索整体关闭,
 * 但不影响 watch/clip/openInTerminal 等旧能力(反之亦然)。
 */
export function nativeExtras2(): NativeExtras2 | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { mxAPI?: Partial<NativeExtras2> }).mxAPI
  if (!api) return null
  const need = ['trashList', 'trashRestore', 'trashEmpty', 'searchStart', 'searchCancel', 'onSearchProgress'] as const
  for (const k of need) {
    if (typeof api[k] !== 'function') return null
  }
  return api as NativeExtras2
}

// ---------- 可执行程序启动(exec:*) ----------

/** 单条探测结果(主进程 exec:probe 返回,批量中单条失败不拖垮整批) */
export interface ExecProbeResult {
  path: string
  kind: 'exe' | 'msi' | 'script' | 'lnk' | 'url' | 'desktop' | 'app' | 'installer' | 'elf' | 'dir' | 'other'
  executable: boolean
  isBundle: boolean
  /** 0=无执行语义 1=程序(确认可记住) 2=危险脚本(强制确认禁记住) 3=代理执行(只显示目标) */
  level: 0 | 1 | 2 | 3
  /** 人类可读风险标签:系统受保护目录 / 来自下载或临时目录 / 脚本文件 / 快捷方式等 */
  risky: string[]
  error?: string
}

export interface ExecRunResult {
  mode: 'spawn' | 'open' | 'denied'
  pid?: number
  reason?: string
}

export interface ExecPolicyItem {
  path: string
  allow: boolean
  at: number
}

/**
 * 可执行程序启动能力(独立探测):旧 preload 缺任一方法即整体降级,
 * 不影响 watch/clip/trash/search 等其它能力。确认框由主进程原生弹出,渲染层不画。
 */
export interface NativeLaunch {
  execProbe(paths: string[]): Promise<ExecProbeResult[]>
  execRun(opts: { path: string; args?: string[]; force?: boolean }): Promise<ExecRunResult>
  execIcon(opts: { path: string; size?: 'small' | 'normal' | 'large' }): Promise<string | null>
  execIsSensitive(path: string): Promise<boolean>
  execPolicyList(): Promise<ExecPolicyItem[]>
  execPolicyReset(path?: string): Promise<void>
  onExecExit(cb: (d: { pid: number; code: number | null; signal: string | null }) => void): () => void
}

export function nativeLaunch(): NativeLaunch | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { mxAPI?: Partial<NativeLaunch> }).mxAPI
  if (!api) return null
  const need = [
    'execProbe',
    'execRun',
    'execIcon',
    'execIsSensitive',
    'execPolicyList',
    'execPolicyReset',
    'onExecExit',
  ] as const
  for (const k of need) {
    if (typeof api[k] !== 'function') return null
  }
  return api as NativeLaunch
}

// ---------- 程序元数据 / 已安装程序(主页「应用程序」分类) ----------

/** 可执行文件元数据(主进程 exec:meta 的返回,永不抛错,失败降级为 error 字段) */
export interface ExecMeta {
  path: string
  name?: string
  version?: string
  publisher?: string
  description?: string
  productName?: string
  /** null = 平台不支持或未检测到;true/false = 已验证结果 */
  signed: boolean | null
  signer?: string | null
  /** 是否带「来自互联网」标记(Win Zone.Identifier / mac quarantine) */
  motw: boolean
  error?: string
}

/** 已安装程序条目(主进程 exec:uninstallList 的返回;目前只有 Windows 有数据) */
export interface InstalledApp {
  id: string
  name: string
  version?: string
  publisher?: string
  /** YYYYMMDD */
  installDate?: string
  installLocation?: string
  /** KB */
  estimatedSize?: number
  uninstallString: string
  quietUninstallString?: string
  /** 已剥离 ",0" 索引后缀,可直接喂 execIcon */
  iconPath?: string
  isSystemComponent?: boolean
}

/** 程序元数据 + 已安装程序列表/卸载(主页「应用程序」分类的数据源) */
export interface NativeAppMeta {
  execMeta(path: string): Promise<ExecMeta>
  execUninstallList(): Promise<{ items: InstalledApp[]; unsupported?: boolean; error?: string }>
  execUninstall(opts: { app: InstalledApp }): Promise<{ ok: boolean; error?: string }>
  /** 与 nativeLaunch 复用同一个 preload 方法(取图标),这里只要求它存在 */
  execIcon(opts: { path: string; size?: 'small' | 'normal' | 'large' }): Promise<string | null>
}

/**
 * 独立探测:必须另起一个函数,不能并入 nativeLaunch()。
 * nativeLaunch 的 need 是「全量判定」—— 只要缺一个就整体返回 null。
 * 把本轮新增的 execMeta / execUninstall* 塞进它的 need,会让只装了 P0 能力的旧 preload
 * 连已经能用的「运行程序」一起降级;反过来若旧 preload 没有这些方法,扩展后的
 * nativeLaunch 也会整体失效。这里单独判定,缺能力只关掉「应用程序」分类。
 * execIcon 两处共用同一个 preload 方法,探测时只校验存在性,不另发明一套。
 */
export function nativeAppMeta(): NativeAppMeta | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { mxAPI?: Partial<NativeAppMeta> }).mxAPI
  if (!api) return null
  const need = ['execMeta', 'execUninstallList', 'execUninstall', 'execIcon'] as const
  for (const k of need) {
    if (typeof api[k] !== 'function') return null
  }
  return api as NativeAppMeta
}
