import type { FileEntry } from '../fs/types'
import type { SortKey } from '../stores/settings'

export interface ListOptions {
  showHidden: boolean
  filter: string
  sortKey: SortKey
  sortAsc: boolean
  foldersFirst: boolean
}

// 缓存的 Intl.Collator 实例:localeCompare 每次比较都走 ICU 初始化,10 万条排序差距 5-10 倍
const collatorNatural = new Intl.Collator('zh-Hans-CN', { numeric: true })
const collatorPlain = new Intl.Collator('zh-Hans-CN')

/** 统一的过滤 + 排序(FileList 与全局快捷键共用,保证全选/复制语义一致) */
export function processEntries(entries: FileEntry[], o: ListOptions): FileEntry[] {
  let arr = entries
  if (!o.showHidden) arr = arr.filter((e) => !e.name.startsWith('.'))
  const f = o.filter.trim().toLowerCase()
  if (f) arr = arr.filter((e) => e.name.toLowerCase().includes(f))
  const dir = o.sortAsc ? 1 : -1
  const byName = (a: FileEntry, b: FileEntry) => collatorNatural.compare(a.name, b.name) * dir
  const cmp = (a: FileEntry, b: FileEntry): number => {
    switch (o.sortKey) {
      case 'name':
        return byName(a, b)
      case 'size':
        return (a.size - b.size) * dir || collatorPlain.compare(a.name, b.name)
      case 'modified':
        return ((a.modified ?? 0) - (b.modified ?? 0)) * dir || collatorPlain.compare(a.name, b.name)
      case 'type':
        return ((a.ext || '').localeCompare(b.ext || '')) * dir || collatorPlain.compare(a.name, b.name)
    }
  }
  arr = [...arr].sort(cmp)
  if (o.foldersFirst) {
    arr.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1))
  }
  return arr
}
