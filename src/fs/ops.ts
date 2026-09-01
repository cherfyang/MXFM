import type { FSProvider, FileEntry, ConflictMode } from './types'

export interface CopyItem {
  path: string
  kind: 'file' | 'directory'
}

export interface CopyOutcome {
  /** 与 entries 一一对齐,null 表示该项被跳过或失败 */
  results: (CopyItem | null)[]
  created: CopyItem[]
  overwritten: number
  skipped: number
  /** 失败项的错误信息:批量流式路径下单项失败不再中断整批 */
  failed: string[]
}

/* ------------------------------------------------------------------ *
 * 批量流式复制/移动
 *
 * 走主进程(fs:op:start)时:文件用 createReadStream().pipe() 搬运,
 * 渲染层不持有任何文件内容 —— 这是修复「复制大文件 OOM」的关键路径。
 * 路径沿用 Provider 的虚拟路径(/根名/...),由实现内部做虚实转换。
 * ------------------------------------------------------------------ */

export interface BulkJob {
  src: string
  dst: string
  isDir: boolean
}

export type BulkStatus = 'renamed' | 'copied' | 'skipped' | 'failed'

export interface BulkResult {
  src: string
  dst: string
  status: BulkStatus
  error?: string
}

export interface BulkProgress {
  fileIndex: number
  fileCount: number
  bytesDone: number
  bytesTotal: number
  currentName: string
}

export interface BulkOptions {
  mode: 'overwrite' | 'skip' | 'keepboth'
  onProgress?: (p: BulkProgress) => void
  signal?: AbortSignal
}

/**
 * Provider 可选能力:把整批作业交给主进程流式执行 + 支持中途取消。
 * 刻意不写进 types.ts —— 浏览器/内存实现提供不了,用可选方法 + 断言读取即可。
 */
export interface BulkCapable {
  copyMany?(jobs: BulkJob[], opts: BulkOptions): Promise<BulkResult[]>
  moveMany?(jobs: BulkJob[], opts: BulkOptions): Promise<BulkResult[]>
  /** 这些虚拟路径是否都能走主进程通道(演示内存根、旧版 preload 都不行) */
  supportsBulk?(paths: string[]): boolean
}

/** 桌面版:删除并回传「是否进了回收站」 */
export interface RemoveCapable {
  removeWithResult?(path: string, kind: 'file' | 'directory', permanent: boolean): Promise<{ trashed: boolean }>
}

export function abortError(): DOMException {
  return new DOMException('操作已取消', 'AbortError')
}

/** 用户取消与真实失败必须能区分开(取消不弹红色错误) */
export function isAbortError(e: unknown): boolean {
  return !!e && e instanceof Error && e.name === 'AbortError'
}

function toBulkMode(mode: ConflictMode): BulkOptions['mode'] {
  return mode === 'keepBoth' ? 'keepboth' : mode
}

/** 通用"复制/移动到目标目录",优先走批量流式通道,否则逐文件回退 */
export async function copyEntries(
  p: FSProvider,
  entries: FileEntry[],
  destDir: string,
  opts: {
    mode: ConflictMode
    move?: boolean
    /** 同目录复制(粘贴副本):强制生成新名字,绝不允许覆盖源自身 */
    sameDirCopy?: boolean
    /** 跳过全部冲突检查(rename 内部使用:目标已预检,且 destDir 就是源目录) */
    force?: boolean
    onProgress?: (done: number, total: number) => void
    /** 批量流式作业的实时进度(字节级),只有主进程通道会产生 */
    onBulkProgress?: (p: BulkProgress) => void
    signal?: AbortSignal
  }
): Promise<CopyOutcome> {
  const move = !!opts.move
  const bulk = opts.force ? null : bulkRunner(p, entries, destDir, move)
  if (bulk) return bulk(opts)

  const results: (CopyItem | null)[] = []
  const created: CopyItem[] = []
  const failed: string[] = []
  let overwritten = 0
  let skipped = 0
  const total = entries.length
  let done = 0

  async function copyOne(entry: FileEntry, destDir: string): Promise<CopyItem | null> {
    let destName = entry.name
    const targetPath = join(destDir, entry.name)
    if (!opts.force) {
      if (opts.sameDirCopy) {
        destName = await p.uniqueName(destDir, entry.name)
      } else if (await p.exists(targetPath)) {
        if (opts.mode === 'skip') {
          skipped++
          return null
        }
        if (opts.mode === 'keepBoth') {
          destName = await p.uniqueName(destDir, entry.name)
        } else {
          overwritten++
          await p.remove(targetPath, entry.kind)
        }
      }
    }
    const destPath = join(destDir, destName)
    if (entry.kind === 'file') {
      const f = await p.getFile(entry.path)
      await p.writeBlob(destPath, f)
    } else {
      await p.mkdir(destPath)
      for (const child of await p.list(entry.path)) {
        if (opts.signal?.aborted) throw abortError()
        await copyOne(child, destPath)
      }
    }
    const item = { path: destPath, kind: entry.kind }
    created.push(item)
    return item
  }

  for (const entry of entries) {
    if (opts.signal?.aborted) throw abortError()
    try {
      results.push(await copyOne(entry, destDir))
    } catch (e) {
      if (isAbortError(e)) throw e
      if (opts.mode === 'skip') {
        skipped++
        failed.push(e instanceof Error ? e.message : String(e))
        results.push(null)
      } else throw e
    }
    done++
    opts.onProgress?.(done, total)
  }

  if (move) {
    // 只有真正复制成功的条目才删除源(被 skip 的源必须保留)
    for (let i = 0; i < entries.length; i++) {
      if (results[i]) {
        try {
          await p.remove(entries[i].path, entries[i].kind)
        } catch {
          /* 源删除失败不致命 */
        }
      }
    }
  }
  return { results, created, overwritten, skipped, failed }
}

/** 选出可用的批量通道;不支持则返回 null(调用方走逐文件回退) */
function bulkRunner(
  p: FSProvider,
  entries: FileEntry[],
  destDir: string,
  move: boolean
): ((opts: { mode: ConflictMode; sameDirCopy?: boolean; onProgress?: (done: number, total: number) => void; onBulkProgress?: (p: BulkProgress) => void; signal?: AbortSignal }) => Promise<CopyOutcome>) | null {
  const cap = p as FSProvider & BulkCapable
  const run = move ? cap.moveMany : cap.copyMany
  if (typeof run !== 'function') return null
  if (cap.supportsBulk && !cap.supportsBulk([...entries.map((e) => e.path), destDir])) return null

  return async (opts) => {
    const jobs: BulkJob[] = entries.map((e) => ({
      src: e.path,
      dst: join(destDir, e.name),
      isDir: e.kind === 'directory',
    }))
    // 同目录复制必须生成新名字:主进程 keepboth 会自动改名成「name (2).ext」
    const mode = opts.sameDirCopy ? 'keepboth' : toBulkMode(opts.mode)
    // 覆盖数只用于「是否允许撤销」的判定与提示文案,预检一次即可(TOCTOU 与旧实现同级)
    let overwritten = 0
    if (mode === 'overwrite') {
      const ex = await Promise.all(jobs.map((j) => p.exists(j.dst).catch(() => false)))
      overwritten = ex.filter(Boolean).length
    }
    const raw = await run.call(p, jobs, {
      mode,
      signal: opts.signal,
      onProgress: (pr) => {
        opts.onBulkProgress?.(pr)
        opts.onProgress?.(pr.fileIndex, pr.fileCount)
      },
    })
    return bulkOutcome(entries, jobs, raw, mode, overwritten)
  }
}

function bulkOutcome(
  entries: FileEntry[],
  jobs: BulkJob[],
  raw: BulkResult[],
  mode: BulkOptions['mode'],
  overwritten: number
): CopyOutcome {
  const created: CopyItem[] = []
  const failed: string[] = []
  let skipped = 0
  const results: (CopyItem | null)[] = entries.map((entry, i) => {
    const r = raw[i]
    const status: BulkStatus = r?.status ?? 'failed'
    if (status === 'skipped') {
      skipped++
      return null
    }
    if (status === 'failed') {
      failed.push(r?.error || `${entry.name}:未知错误`)
      return null
    }
    // 目标名可能被主进程改写(keepboth 自动改名),一律以回传的 dst 为准
    const item: CopyItem = { path: r.dst || jobs[i].dst, kind: entry.kind }
    created.push(item)
    return item
  })
  return { results, created, overwritten, skipped, failed }
}

function join(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

/** 删除单项并回传是否进了回收站;非桌面实现一律视为彻底删除 */
export async function removeWithResult(
  p: FSProvider,
  path: string,
  kind: 'file' | 'directory',
  permanent: boolean
): Promise<{ trashed: boolean }> {
  const cap = p as FSProvider & RemoveCapable
  if (cap.removeWithResult) return cap.removeWithResult(path, kind, permanent)
  if (permanent && p.removePermanent) await p.removePermanent(path, kind)
  else await p.remove(path, kind)
  return { trashed: false }
}

/**
 * 重命名/移动单个条目到确切的新路径(目标必须已预检不存在)。
 * rename 不能走 copyEntries:那会把内容写回「源目录/源名字」,等于原地覆盖自己。
 */
export async function moveEntry(p: FSProvider, entry: FileEntry, targetPath: string): Promise<void> {
  if (entry.kind === 'file') {
    const f = await p.getFile(entry.path)
    await p.writeBlob(targetPath, f)
    await p.remove(entry.path, 'file')
  } else {
    await p.mkdir(targetPath)
    for (const child of await p.list(entry.path)) {
      await moveEntry(p, child, join(targetPath, child.name))
    }
    await p.remove(entry.path, 'directory')
  }
}
