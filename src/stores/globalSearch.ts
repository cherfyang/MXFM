import { create } from 'zustand'
import { useFs } from './fs'
import type { ElectronProvider } from '../fs/electron'
import type { FileEntry } from '../fs/types'
import { extOf } from '../utils/format'

export interface GlobalSearchRaw {
  name: string
  path: string // 本机绝对路径
  isDir: boolean
  size: number
  modified: number | null
}

export interface GlobalSearchItem extends GlobalSearchRaw {
  /** 虚拟路径;不在已挂载根内时为 null,UI 置灰不可打开 */
  vpath: string | null
}

export interface IndexStatus {
  building: boolean
  count: number
  lastBuildAt: number | null
  roots: string[]
}

interface GlobalSearchState {
  query: string
  results: GlobalSearchItem[]
  total: number
  truncated: boolean
  searching: boolean
  error: string | null
  index: IndexStatus
  /** 输入即搜(内部 250ms 防抖);空串清空结果 */
  setQuery(q: string): void
  /** 手动重建索引 */
  rebuild(): void
  /** 立刻读取一次索引状态 */
  refreshIndex(): void
}

interface IndexSearchResponse extends IndexStatus {
  results: GlobalSearchRaw[]
  total: number
  truncated: boolean
  error?: string
}

/** 供 store 与对话框共同使用的 mxAPI 子集(仅桌面版存在) */
export function indexApi():
  | {
      indexStatus(): Promise<IndexStatus>
      indexRebuild(): Promise<boolean>
      indexSearch(opts: { pattern: string; limit?: number }): Promise<IndexSearchResponse>
      indexQuery(opts: {
        group: string
        sort: 'mtime' | 'size' | 'name'
        asc: boolean
        offset: number
        limit: number
      }): Promise<IndexSearchResponse>
      onIndexProgress(cb: (p: IndexStatus) => void): () => void
    }
  | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { mxAPI?: object }).mxAPI as never
}

const SEARCH_LIMIT = 1000

function toVpath(nativePath: string): string | null {
  const provider = useFs.getState().provider
  if (provider?.kind !== 'native') return null
  try {
    return (provider as ElectronProvider).toVirtualPath(nativePath)
  } catch {
    return null
  }
}

function convert(raw: GlobalSearchRaw[]): GlobalSearchItem[] {
  return raw.map((r) => ({ ...r, vpath: toVpath(r.path) }))
}

/** 索引条目 → 可打开的 FileEntry;不在已挂载根内(转不了虚拟路径)返回 null */
export function itemToFileEntry(r: GlobalSearchItem): FileEntry | null {
  if (!r.vpath) return null
  return {
    name: r.name,
    path: r.vpath,
    kind: r.isDir ? 'directory' : 'file',
    size: r.size,
    modified: r.modified,
    ext: r.isDir ? '' : extOf(r.name),
  }
}

export type IndexSort = 'mtime' | 'size' | 'name'

export interface CategoryPage {
  items: GlobalSearchItem[]
  /** 该分类的完整总数(按索引全量统计,与单页条数无关) */
  total: number
  building: boolean
}

/** 主页分类列表的分页查询:主进程在全量排序结果上过滤分类后切片 */
export async function queryCategoryPage(opts: {
  group: 'image' | 'video' | 'audio' | 'document' | 'zip' | 'ebook' | 'all'
  sort: IndexSort
  asc: boolean
  offset: number
  limit: number
}): Promise<CategoryPage | null> {
  const api = indexApi()
  if (!api) return null
  const res = await api.indexQuery(opts)
  return { items: convert(res.results ?? []), total: res.total ?? 0, building: !!res.building }
}

let searchSeq = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null

async function runSearch(q: string) {
  const api = indexApi()
  if (!api) return
  const id = ++searchSeq
  try {
    const res = await api.indexSearch({ pattern: q, limit: SEARCH_LIMIT })
    if (id !== searchSeq) return // 已被更新的输入取代
    useGlobalSearch.setState({
      results: convert(res.results ?? []),
      total: res.total ?? 0,
      truncated: !!res.truncated,
      searching: false,
      error: res.error ?? null,
      index: { building: res.building, count: res.count, lastBuildAt: res.lastBuildAt, roots: res.roots },
    })
  } catch (e) {
    if (id !== searchSeq) return
    useGlobalSearch.setState({ searching: false, error: String((e as Error).message || e) })
  }
}

export const useGlobalSearch = create<GlobalSearchState>()((set) => ({
  query: '',
  results: [],
  total: 0,
  truncated: false,
  searching: false,
  error: null,
  index: { building: false, count: 0, lastBuildAt: null, roots: [] },

  setQuery(q) {
    // 输入期间持续把最新索引状态带回来,构建中的提示自动刷新
    set({ query: q })
    if (debounceTimer) clearTimeout(debounceTimer)
    const trimmed = q.trim()
    if (!trimmed) {
      searchSeq++
      set({ results: [], total: 0, truncated: false, searching: false, error: null })
      return
    }
    set({ searching: true })
    debounceTimer = setTimeout(() => void runSearch(trimmed), 250)
  },

  rebuild() {
    const api = indexApi()
    if (!api || useGlobalSearch.getState().index.building) return
    void api.indexRebuild()
    set({ index: { ...useGlobalSearch.getState().index, building: true } })
  },

  refreshIndex() {
    const api = indexApi()
    if (!api) return
    void api
      .indexStatus()
      .then((st) => useGlobalSearch.setState({ index: st }))
      .catch(() => {})
  },
}))

// 模块级订阅一次:索引构建进度实时反映到对话框状态行
if (typeof window !== 'undefined') {
  const api = indexApi()
  if (api) {
    api.onIndexProgress((p) => useGlobalSearch.setState({ index: p }))
  }
}
