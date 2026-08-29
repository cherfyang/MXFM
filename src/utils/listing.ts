import type { FileEntry } from '../fs/types'
import type { SortKey } from '../stores/settings'

export interface ListOptions {
  showHidden: boolean
  filter: string
  sortKey: SortKey
  sortAsc: boolean
  foldersFirst: boolean
}

/** 统一的过滤 + 排序(FileList 与全局快捷键共用,保证全选/复制语义一致) */
export function processEntries(entries: FileEntry[], o: ListOptions): FileEntry[] {
  let arr = entries
  if (!o.showHidden) arr = arr.filter((e) => !e.name.startsWith('.'))
  const f = o.filter.trim().toLowerCase()
  if (f) arr = arr.filter((e) => e.name.toLowerCase().includes(f))
  const dir = o.sortAsc ? 1 : -1
  const cmp = (a: FileEntry, b: FileEntry): number => {
    switch (o.sortKey) {
      case 'name':
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * dir
      case 'size':
        return (a.size - b.size) * dir || a.name.localeCompare(b.name)
      case 'modified':
        return ((a.modified ?? 0) - (b.modified ?? 0)) * dir || a.name.localeCompare(b.name)
      case 'type':
        return (a.ext || '').localeCompare(b.ext || '') * dir || a.name.localeCompare(b.name)
    }
  }
  arr = [...arr].sort(cmp)
  if (o.foldersFirst) {
    arr.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1))
  }
  return arr
}
