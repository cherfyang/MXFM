import { create } from 'zustand'
import { nativeExtras2, type ElectronProvider, type NativeExtras2, type SearchProgress } from '../fs/electron'
import { useFs } from './fs'
import { parentOf } from '../utils/path'

export interface SearchResultItem {
  name: string
  /** 虚拟路径;不在任何已挂载根内时为本机绝对路径并标 external */
  path: string
  /** 父目录虚拟路径;external 项为本机风格路径,仅展示用 */
  dir: string
  size: number
  isDir: boolean
  /** 不在已挂载根内,无法跳转/打开,UI 可置灰 */
  external?: boolean
}

interface SearchState {
  running: boolean
  query: string
  results: SearchResultItem[]
  total: number
  truncated: boolean
  error: string | null
  start(dir: string, pattern: string): void
  cancel(): void
  clear(): void
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 本机绝对路径的父目录(Windows 反斜杠统一为 / 后切分) */
function nativeParent(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}

/** 当前生效的搜索 id;progress 事件按它过滤,旧搜索(含已取消后补发的 done)全部丢弃 */
let activeSearchId: string | null = null
/** 代际号:每次 start/cancel/clear 递增,让在途的 searchStart 回调能发现自己已过期 */
let searchGen = 0

/** 使当前搜索失效:取消主进程侧作业,并作废所有在途回调 */
function invalidate(extras: NativeExtras2) {
  searchGen++
  if (activeSearchId !== null) {
    try {
      extras.searchCancel(activeSearchId)
    } catch {
      /* ignore */
    }
  }
  activeSearchId = null
}

export const useSearch = create<SearchState>()((set, get) => ({
  running: false,
  query: '',
  results: [],
  total: 0,
  truncated: false,
  error: null,

  /** 发起递归搜索;dir 为虚拟路径,内部转本机绝对路径 */
  start(dir, pattern) {
    const p = pattern.trim()
    if (p.length < 1) return
    const provider = useFs.getState().provider
    if (provider?.kind !== 'native') {
      set({ running: false, query: '', results: [], total: 0, truncated: false, error: '递归搜索仅桌面版支持' })
      return
    }
    const extras = nativeExtras2()
    if (!extras) {
      set({ running: false, error: '当前版本主进程不支持递归搜索' })
      return
    }
    // 先作废上一个搜索,避免两路事件互相覆盖结果
    invalidate(extras)
    let nativeDir: string
    try {
      nativeDir = (provider as ElectronProvider).toNativePath(dir)
    } catch (e) {
      set({ running: false, error: errText(e) })
      return
    }
    const gen = searchGen
    set({ running: true, query: p, results: [], total: 0, truncated: false, error: null })
    extras
      .searchStart({ dir: nativeDir, pattern: p })
      .then((id) => {
        if (gen !== searchGen) {
          // id 回来前已被 cancel/clear/新 start 取代:立即停掉这一路
          try {
            extras.searchCancel(id)
          } catch {
            /* ignore */
          }
          return
        }
        activeSearchId = id
      })
      .catch((e: unknown) => {
        if (gen !== searchGen) return
        set({ running: false, error: errText(e) })
      })
  },

  /** 停止当前搜索,保留已累积的结果 */
  cancel() {
    const extras = nativeExtras2()
    if (extras) invalidate(extras)
    set({ running: false })
  },

  /** 清空结果与状态(搜索框清空/关闭时调用);若有搜索在跑会先取消 */
  clear() {
    const extras = nativeExtras2()
    if (extras) invalidate(extras)
    set({ running: false, query: '', results: [], total: 0, truncated: false, error: null })
  },
}))

// 模块级只订阅一次:按 activeSearchId 过滤自己那一路(preload 先于渲染模块注入,这里能探测到)
if (typeof window !== 'undefined') {
  const extras = nativeExtras2()
  if (extras) {
    extras.onSearchProgress((p: SearchProgress) => {
      if (p.id !== activeSearchId) return
      const provider = useFs.getState().provider
      if (provider?.kind !== 'native') return
      const ep = provider as ElectronProvider
      const s = useSearch.getState()
      const seen = new Set(s.results.map((r) => r.path))
      const added: SearchResultItem[] = []
      for (const r of p.results) {
        let vp: string
        let external = false
        try {
          vp = ep.toVirtualPath(r.path)
        } catch {
          // 不在任何已挂载根内:保留本机路径并标记,UI 可置灰
          vp = r.path
          external = true
        }
        if (seen.has(vp)) continue
        seen.add(vp)
        added.push({
          name: r.name,
          path: vp,
          dir: external ? nativeParent(vp) : parentOf(vp),
          size: r.size,
          isDir: r.isDir,
          ...(external ? { external: true } : {}),
        })
      }
      if (p.done) activeSearchId = null
      useSearch.setState({
        results: added.length ? [...s.results, ...added] : s.results,
        // 进度期用本地去重累计数,done 时以服务端 total 为准
        total: p.total ?? (p.done ? s.total : s.total + added.length),
        truncated: p.truncated ?? s.truncated,
        running: p.done ? false : s.running,
      })
    })
  }
}
