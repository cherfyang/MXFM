import type { FSProvider, FileEntry, ConflictMode } from './types'

export interface CopyItem {
  path: string
  kind: 'file' | 'directory'
}

export interface CopyOutcome {
  /** 与 entries 一一对齐,null 表示该项被跳过 */
  results: (CopyItem | null)[]
  created: CopyItem[]
  overwritten: number
  skipped: number
}

/** 通用"复制/移动到目标目录",FSA 与内存 Provider 共用 */
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
  }
): Promise<CopyOutcome> {
  const results: (CopyItem | null)[] = []
  const created: CopyItem[] = []
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
        if (opts.mode === 'skip') return null
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
      for (const child of await p.list(entry.path)) await copyOne(child, destPath)
    }
    const item = { path: destPath, kind: entry.kind }
    created.push(item)
    return item
  }

  for (const entry of entries) {
    try {
      results.push(await copyOne(entry, destDir))
    } catch (e) {
      if (opts.mode === 'skip') results.push(null)
      else throw e
    }
    done++
    opts.onProgress?.(done, total)
  }

  if (opts.move) {
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
  return { results, created, overwritten, skipped }
}

function join(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
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
