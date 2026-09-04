import { create } from 'zustand'
import type { FSProvider, FileEntry, RootInfo, ConflictMode } from '../fs/types'
import { FsaProvider } from '../fs/fsa'
import { ElectronProvider } from '../fs/electron'
import { CapacitorProvider, isCapacitorNative } from '../fs/capacitor'
import { HOME_PATH, useScan } from './scan'
import { MemoryProvider, buildDemoRoot } from '../fs/memory'
import {
  copyEntries,
  removeWithResult,
  isAbortError,
  type BulkProgress,
  type CopyItem,
} from '../fs/ops'
import { idbAllRoots, idbPutRoot, idbDeleteRoot } from '../fs/idb'
import { joinPath, parentOf, baseName, isValidName } from '../utils/path'
import { categoryOf, LAUNCHABLE_CATEGORIES, isScriptEntry, type Category } from '../utils/categories'
import { extOf } from '../utils/format'
import { nativeLaunch } from '../fs/electron'
import { useUi, type MenuItem } from './ui'
import { useSettings } from './settings'

export interface ViewedFile {
  entry: FileEntry
  category: Category
  dirty: boolean
}

/** 本轮主进程新增的能力(preload 已暴露),与 ElectronProvider 共用同一个 window.mxAPI 对象 */
interface NativeExtras {
  watchStart(dir: string): Promise<number>
  watchStop(id: number): Promise<void>
  watchStopAll(): Promise<void>
  onFsChanged(cb: (p: { watchId: number; dir: string }) => void): () => void
  clipWrite(paths: string[], cut: boolean): Promise<{ ok: true }>
  clipRead(): Promise<{ paths: string[]; cut: boolean } | null>
  openInTerminal(dir: string): Promise<{ ok: true }>
}

/** 能力探测:旧版 preload 没有这些方法时整体返回 null,所有新特性静默关闭 */
function nativeExtras(): NativeExtras | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { mxAPI?: Partial<NativeExtras> }).mxAPI
  if (!api) return null
  const need = ['watchStart', 'watchStop', 'watchStopAll', 'onFsChanged', 'clipWrite', 'clipRead', 'openInTerminal'] as const
  for (const k of need) {
    if (typeof api[k] !== 'function') return null
  }
  return api as NativeExtras
}

export interface Tab {
  id: string
  history: string[]
  idx: number
  view: ViewedFile | null
  filter: string
}

interface Listing {
  entries: FileEntry[]
  loading: boolean
}

/**
 * 进行中的文件操作状态(状态栏展示)。
 * done/total 在批量流式作业下是「已处理文件数/总文件数」;
 * bytesDone/bytesTotal 同时给出字节级进度,UI 可以显示「第 3/120 个文件 · 45%」。
 */
export interface OpState {
  label: string
  done: number
  total: number
  /** 已搬运字节数(仅批量流式作业有) */
  bytesDone?: number
  /** 待搬运总字节数;0 表示主进程尚未统计出来 */
  bytesTotal?: number
  /** 当前正在处理的文件名 */
  currentName?: string
  /** 是否可取消(批量流式作业进行中才有意义) */
  canCancel?: boolean
}

/** 最近删除记录(写 localStorage,重启后仍可查看) */
export interface DeletedRecord {
  path: string
  name: string
  kind: 'file' | 'directory'
  at: number
  trashed: boolean
}

type UndoOp =
  | { kind: 'create'; target: CopyItem }
  | { kind: 'rename'; from: string; to: string; entryKind: 'file' | 'directory' }
  | { kind: 'paste'; created: CopyItem[]; sources: CopyItem[] }
  | { kind: 'move'; pairs: { created: CopyItem; source: CopyItem }[] }
  /** 删除进了回收站:撤销只能提示用户去回收站还原 */
  | { kind: 'trash'; items: CopyItem[]; at: number }

interface FsState {
  ready: boolean
  provider: FSProvider | null
  roots: RootInfo[]
  tabs: Tab[]
  activeId: string
  listings: Record<string, Listing>
  selection: Record<string, string[]>
  anchor: Record<string, string | undefined>
  renamingPath: string | null
  clipboard: { mode: 'copy' | 'cut'; entries: FileEntry[] } | null
  op: OpState | null
  /** 最近从回收站可还原的删除记录(持久化到 localStorage) */
  recentDeleted: DeletedRecord[]
  undoStack: UndoOp[]
  /** 撤销时压入的重做动作(闭包,不入会话持久化) */
  redoStack: { run(): Promise<void> }[]

  init(): Promise<void>
  addRoot(): Promise<void>
  addRootFromHandle(handle: FileSystemDirectoryHandle): Promise<void>
  addDemoRoot(): Promise<void>
  reauthRoot(name: string): Promise<void>
  removeRoot(name: string): Promise<void>

  newTab(path?: string): void
  closeTab(id: string): void
  setActive(id: string): void
  jumpToTab(index: number): void
  /** 拖拽重排:把 fromId 的标签移动到 toId 标签当前所在位置 */
  moveTab(fromId: string, toId: string): void
  nextTab(delta: number): void
  openHome(): void
  navigate(path: string, tabId?: string): void
  goBack(): void
  goForward(): void
  goUp(): void
  refresh(tabId?: string): Promise<void>
  setFilter(text: string): void

  openEntry(entry: FileEntry, opts?: { forceView?: boolean }): void
  closeView(): void
  requestCloseView(): void
  setDirty(dirty: boolean): void
  saveView(): Promise<void>

  clickSelect(entry: FileEntry, index: number, ordered: FileEntry[], e: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): void
  selectAll(ordered: FileEntry[]): void
  clearSelection(): void

  startRename(path: string | null): void
  commitRename(newName: string): Promise<void>

  createEntry(kind: 'folder' | 'file'): void
  deleteSelection(): void
  deletePaths(paths: string[], kinds: ('file' | 'directory')[], permanent?: boolean): Promise<void>
  permanentDeleteSelection(): void
  copySelection(entries: FileEntry[]): void
  cutSelection(entries: FileEntry[]): void
  paste(): Promise<void>
  moveEntries(entries: FileEntry[], destDir: string): Promise<void>
  undo(): Promise<void>
  redo(): Promise<void>
  duplicateSelection(): Promise<void>

  /** 取消当前进行中的文件操作(状态栏「取消」按钮调用) */
  cancelOperation(): void

  setOp(op: FsState['op']): void
}

let tabSeq = 1
const nextTabId = () => `t${tabSeq++}`

/** 当前进行中操作的取消控制器(不入 state:不需要触发渲染) */
let opAbort: AbortController | null = null
/** 防双击双启动:记录最近一次用外部程序打开的文件(path + 时间) */
let lastExternalOpen = { path: '', at: 0 }
/** 操作序号:并发收尾时只有最后一个作业有权清掉状态栏进度 */
let opSeq = 0

const RECENT_DELETED_KEY = 'mx-fm-recent-deleted'
const RECENT_DELETED_MAX = 50

function loadRecentDeleted(): DeletedRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_DELETED_KEY) || '[]')
    return Array.isArray(raw) ? (raw as DeletedRecord[]).slice(0, RECENT_DELETED_MAX) : []
  } catch {
    return []
  }
}

function persistRecentDeleted(list: DeletedRecord[]) {
  try {
    localStorage.setItem(RECENT_DELETED_KEY, JSON.stringify(list.slice(0, RECENT_DELETED_MAX)))
  } catch {
    /* ignore */
  }
}

/** 记录可撤销操作;任何新操作都会使重做栈失效 */
function pushUndoOp(op: UndoOp) {
  useFs.setState({ undoStack: [...useFs.getState().undoStack, op].slice(-50), redoStack: [] })
}

/** 关闭标签页的实际执行(不带脏确认,供确认弹窗回调复用) */
function actuallyCloseTab(id: string) {
  const s = useFs.getState()
  const idx = s.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  const tabs = s.tabs.filter((t) => t.id !== id)
  const listings = { ...s.listings }
  const selection = { ...s.selection }
  delete listings[id]
  delete selection[id]
  let activeId = s.activeId
  if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? ''
  persistSession(tabs, activeId)
  useFs.setState({ tabs, activeId, listings, selection })
  void syncWatches()
}

/** 防止演示模式并发初始化(双击/重试)创建多个 provider 实例 */
let demoLoading = false

/** 恢复上次会话的标签页路径(根不存在的自动跳过) */
async function restoreSession() {
  let restored = false
  try {
    const session = JSON.parse(localStorage.getItem('mx-fm-session') || 'null')
    if (session && Array.isArray(session.tabs)) {
      const s = useFs.getState()
      const tabs: Tab[] = []
      for (const path of session.tabs) {
        if (typeof path === 'string' && s.provider!.hasRoot(path.split('/').filter(Boolean)[0])) {
          tabs.push({ id: nextTabId(), history: [path], idx: 0, view: null, filter: '' })
        }
      }
      if (tabs.length) {
        const act = tabs.some((t) => t.id === session.activeId) ? session.activeId : tabs[0].id
        useFs.setState({ tabs, activeId: act, ready: true })
        restored = true
        persistSession(tabs, act)
        await Promise.all(tabs.map((t) => loadDir(t.id)))
      }
    }
  } catch {
    /* ignore */
  }
  if (!restored) {
    useFs.setState({ ready: true })
    persistSession([], '')
    if (useFs.getState().provider?.kind === 'native') useFs.getState().newTab(HOME_PATH)
  }
}

/** 当前活动查看器的保存回调(由 ViewerHost 注册) */
let saveFn: (() => Promise<void>) | null = null
export function registerSaveFn(fn: (() => Promise<void>) | null) {
  saveFn = fn
}

function persistSession(tabs: Tab[], activeId: string) {
  try {
    localStorage.setItem(
      'mx-fm-session',
      JSON.stringify({ tabs: tabs.map((t) => t.history[t.idx]), activeId })
    )
  } catch {
    /* ignore */
  }
}

function errToast(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'NotAllowedError') return '没有访问权限,请在侧边栏重新授权该文件夹'
    if (e.name === 'NotFoundError') return '路径不存在'
    return e.message
  }
  return String(e)
}

async function loadDir(tabId: string) {
  const s = useFs.getState()
  const tab = s.tabs.find((t) => t.id === tabId)
  if (!tab || !s.provider) return
  const path = tab.history[tab.idx]
  useFs.setState({ listings: { ...s.listings, [tabId]: { entries: s.listings[tabId]?.entries ?? [], loading: true } } })
  try {
    const entries = await s.provider.list(path)
    useFs.setState({ listings: { ...useFs.getState().listings, [tabId]: { entries, loading: false } } })
    void syncWatches()
  } catch (e) {
    useFs.setState({ listings: { ...useFs.getState().listings, [tabId]: { entries: [], loading: false } } })
    useUi.getState().toast(errToast(e), 'error')
    const rootName = path.split('/').filter(Boolean)[0]
    if (e instanceof Error && e.name === 'NotAllowedError') {
      useFs.setState({ roots: useFs.getState().roots.map((r) => (r.name === rootName ? { ...r, needsAuth: true } : r)) })
    }
  }
}

export const useFs = create<FsState>()((set, get) => {
  const ui = useUi.getState

  const activeTab = () => {
    const s = get()
    return s.tabs.find((t) => t.id === s.activeId)
  }

  function withSession(tabs: Tab[], activeId?: string) {
    persistSession(tabs, activeId ?? get().activeId)
    return tabs
  }

  async function runConflictAware(
    entries: FileEntry[],
    destDir: string,
    move: boolean
  ): Promise<void> {
    const s = get()
    const provider = s.provider!
    // 目标在自己内部时禁止(移动文件夹到自己的子目录)
    if (move) {
      const bad = entries.find((e) => destDir === e.path || destDir.startsWith(e.path + '/'))
      if (bad) {
        ui().toast(`无法把「${bad.name}」移动到其自身内部`, 'error')
        return
      }
    }
    const existence = await Promise.all(
      entries.map(async (e) => ({ e, exists: await provider.exists(joinPath(destDir, e.name)) }))
    )
    const conflicts = existence.filter((x) => x.exists).length
    const sameDir = entries.every((e) => parentOf(e.path) === destDir)

    const run = async (mode: ConflictMode) => {
      // 主进程同时只接受一个作业,第二个 opStart 会直接报 busy —— 这里提前拦下来更好定位
      if (opAbort) {
        ui().toast('已有文件操作正在进行,请先等待完成或取消', 'error')
        return
      }
      const label = move ? '移动中' : '复制中'
      const token = ++opSeq
      const ac = new AbortController()
      opAbort = ac
      get().setOp({ label, done: 0, total: entries.length, canCancel: true })
      const onBulkProgress = (p: BulkProgress) => {
        const cur = get().op
        if (!cur) return
        set({
          op: {
            ...cur,
            done: p.fileIndex,
            total: p.fileCount,
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            currentName: p.currentName,
          },
        })
      }
      try {
        const out = await copyEntries(provider, entries, destDir, {
          mode,
          move,
          sameDirCopy: sameDir && !move,
          signal: ac.signal,
          onBulkProgress,
          onProgress: (done, total) => {
            const cur = get().op
            if (cur) set({ op: { ...cur, done, total } })
          },
        })
        const n = out.created.length
        const parts = [`${n} 项`]
        if (out.skipped) parts.push(`跳过 ${out.skipped}`)
        if (out.overwritten) parts.push(`覆盖 ${out.overwritten}`)
        if (out.failed.length) parts.push(`失败 ${out.failed.length}:${out.failed[0]}`)
        ui().toast(`${move ? '移动' : '复制'}完成:${parts.join(',')}`, out.failed.length ? 'error' : 'success')
        if (out.created.length) {
          const tab = activeTab()
          if (tab && tab.history[tab.idx] === destDir) {
            set({ selection: { ...get().selection, [tab.id]: out.created.map((c) => c.path) } })
          }
        }
        if (out.overwritten === 0 && out.failed.length === 0 && out.created.length) {
          const op: UndoOp = move
            ? {
                kind: 'move',
                pairs: out.results
                  .map((r, i) => (r ? { created: r, source: { path: entries[i].path, kind: entries[i].kind } } : null))
                  .filter(Boolean) as { created: CopyItem; source: CopyItem }[],
              }
            : {
                kind: 'paste',
                created: out.created,
                sources: out.results
                  .map((r, i) => (r ? { path: entries[i].path, kind: entries[i].kind } : null))
                  .filter(Boolean) as CopyItem[],
              }
          pushUndoOp(op)
        }
      } catch (e) {
        if (isAbortError(e)) ui().toast('已取消操作', 'info')
        else ui().toast(errToast(e), 'error')
      } finally {
        if (opAbort === ac) opAbort = null
        if (opSeq === token) get().setOp(null)
        await get().refresh()
      }
    }

    if (conflicts > 0 && !sameDir) {
      ui().showDialog({
        type: 'conflict',
        count: conflicts,
        onChoose: (mode) => {
          ui().closeDialog()
          void run(mode)
        },
      })
    } else {
      await run('overwrite')
    }
  }

  return {
    ready: false,
    provider: null,
    roots: [],
    tabs: [],
    activeId: '',
    listings: {},
    selection: {},
    anchor: {},
    renamingPath: null,
    clipboard: null,
    op: null,
    recentDeleted: loadRecentDeleted(),
    undoStack: [],
    redoStack: [],

    async init() {
      // Android / iOS(Capacitor 壳)
      if (isCapacitorNative()) {
        try {
          const provider = new CapacitorProvider()
          await provider.boot()
          set({ provider, roots: provider.rootInfos() })
        } catch {
          set({ provider: new MemoryProvider() })
          ui().toast('存储初始化失败,已回退演示模式', 'error')
        }
        await restoreSession()
        return
      }
      const api = (window as unknown as { mxAPI?: unknown }).mxAPI
      if (api) {
        // 桌面版:真实文件系统,磁盘 + 常用目录作为根
        try {
          const provider = new ElectronProvider(api)
          await provider.boot()
          set({ provider, roots: provider.rootInfos() })
        } catch {
          set({ provider: new FsaProvider() })
          ui().toast('桌面环境初始化失败,已回退浏览器模式', 'error')
          set({ ready: true })
          return
        }
        await restoreSession()
        return
      }
      // 浏览器版:File System Access API + 持久化授权句柄
      const roots: RootInfo[] = []
      try {
        const stored = await idbAllRoots()
        const provider = new FsaProvider()
        for (const r of stored) {
          provider.addRoot(r.handle)
          let needsAuth = false
          try {
            needsAuth = (await r.handle.queryPermission!({ mode: 'readwrite' })) !== 'granted'
          } catch {
            needsAuth = true
          }
          roots.push({ name: r.name, kind: 'fsa', needsAuth })
        }
        set({ provider, roots })
      } catch {
        set({ provider: new FsaProvider() })
      }
      await restoreSession()
    },

    async addRoot() {
      const s = get()
      // 桌面版:系统文件夹选择对话框
      if (s.provider!.kind === 'native') {
        const ep = s.provider as ElectronProvider
        const picked = await ep.pickFolder()
        if (!picked) return
        const name = ep.addUserRoot(picked)
        set({ roots: [...get().roots.filter((r) => r.name !== name), { name, kind: 'native', needsAuth: false }] })
        get().newTab('/' + name)
        ui().toast(`已添加「${name}」`, 'success')
        return
      }
      const w = window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }
      if (!w.showDirectoryPicker) {
        ui().toast('当前浏览器不支持文件夹授权,请使用 Edge / Chrome,或试试演示模式', 'error')
        return
      }
      try {
        const handle = await w.showDirectoryPicker({ mode: 'readwrite' })
        await get().addRootFromHandle(handle)
      } catch {
        /* 用户取消 */
      }
    },

    async addRootFromHandle(handle) {
      const s = get()
      const name = handle.name
      if (!(s.provider!.kind === 'fsa')) {
        ui().toast('演示模式下无法添加本地文件夹,请刷新页面', 'error')
        return
      }
      s.provider!.addRoot(handle)
      try {
        await idbPutRoot(name, handle)
      } catch {
        /* 隐私模式等场景下不可持久化,仍可本次使用 */
      }
      let needsAuth = false
      try {
        needsAuth = (await handle.queryPermission!({ mode: 'readwrite' })) !== 'granted'
      } catch {
        needsAuth = true
      }
      const already = s.roots.find((r) => r.name === name)
      const roots = already
        ? s.roots.map((r) => (r.name === name ? { ...r, needsAuth } : r))
        : [...s.roots, { name, kind: 'fsa' as const, needsAuth }]
      set({ roots })
      // 新标签页打开
      const tab: Tab = { id: nextTabId(), history: [`/${name}`], idx: 0, view: null, filter: '' }
      const tabs = [...s.tabs, tab]
      set({ tabs: withSession(tabs, tab.id), activeId: tab.id, listings: { ...s.listings, [tab.id]: { entries: [], loading: true } } })
      await loadDir(tab.id)
      ui().toast(`已添加「${name}」`, 'success')
    },

    async addDemoRoot() {
      const name = '演示项目'
      if (demoLoading) return
      // 已存在则直接聚焦/开标签页(provider 是唯一事实来源)
      if (get().provider!.hasRoot(name)) {
        const s0 = get()
        const t = s0.tabs.find((t) => t.history[t.idx] === `/${name}`)
        if (t) {
          get().setActive(t.id)
        } else {
          get().newTab(`/${name}`)
        }
        return
      }
      demoLoading = true
      try {
        // await 之后状态可能已变化,重新读取
        const s = get()
        if (s.provider!.hasRoot(name)) return
        const root = await buildDemoRoot()
        if (get().provider!.hasRoot(name)) return
        // 三种 Provider 都内嵌了 MemoryProvider,直接往当前实例添加
        get().provider!.addRoot(root)
        set({ roots: [...get().roots.filter((r) => r.name !== name), { name, kind: 'memory', needsAuth: false }] })
        const tab: Tab = { id: nextTabId(), history: [`/${name}`], idx: 0, view: null, filter: '' }
        const tabs = [...get().tabs, tab]
        set({ tabs: withSession(tabs, tab.id), activeId: tab.id, listings: { ...get().listings, [tab.id]: { entries: [], loading: true } }, selection: { ...get().selection, [tab.id]: [] } })
        await loadDir(tab.id)
      } catch (e) {
        ui().toast(errToast(e), 'error')
      } finally {
        demoLoading = false
      }
    },

    async reauthRoot(name) {
      const s = get()
      if (s.provider!.kind !== 'fsa') return
      const p = s.provider as FsaProvider
      // 从 provider 侧拿到句柄
      const handle = (p as unknown as { roots: Map<string, FileSystemDirectoryHandle> }).roots.get(name)
      if (!handle) return
      try {
        const state = await handle.requestPermission!({ mode: 'readwrite' })
        if (state === 'granted') {
          set({ roots: get().roots.map((r) => (r.name === name ? { ...r, needsAuth: false } : r)) })
          ui().toast(`「${name}」已授权`, 'success')
          await Promise.all(get().tabs.map((t) => loadDir(t.id)))
        } else {
          ui().toast('授权被拒绝', 'error')
        }
      } catch {
        ui().toast('授权失败', 'error')
      }
    },

    async removeRoot(name) {
      const s = get()
      s.provider!.removeRoot(name)
      try {
        await idbDeleteRoot(name)
      } catch {
        /* ignore */
      }
      const roots = s.roots.filter((r) => r.name !== name)
      const keepTabs = s.tabs.filter((t) => !t.history[t.idx].startsWith(`/${name}`))
      const listings = { ...s.listings }
      const selection = { ...s.selection }
      for (const t of s.tabs) {
        if (!keepTabs.includes(t)) {
          delete listings[t.id]
          delete selection[t.id]
        }
      }
      const tabs = keepTabs.length ? keepTabs : []
      const activeId = tabs.some((t) => t.id === s.activeId) ? s.activeId : tabs[tabs.length - 1]?.id ?? ''
      set({ roots, tabs: withSession(tabs, activeId), activeId, listings, selection })
      void syncWatches()
      if (activeId) await loadDir(activeId)
    },

    newTab(path) {
      const s = get()
      const cur = activeTab()
      const fallback = cur ? cur.history[cur.idx] : s.roots[0] ? `/${s.roots[0].name}` : ''
      const p = path ?? fallback
      if (p === HOME_PATH) {
        const existing = s.tabs.find((t) => t.history[t.idx] === HOME_PATH)
        if (existing) {
          get().setActive(existing.id)
          return
        }
        const tab: Tab = { id: nextTabId(), history: [HOME_PATH], idx: 0, view: null, filter: '' }
        const tabs = [...s.tabs, tab]
        set({ tabs: withSession(tabs, tab.id), activeId: tab.id, selection: { ...s.selection, [tab.id]: [] }, listings: { ...s.listings, [tab.id]: { entries: [], loading: false } } })
        return
      }
      const rootName = p.split('/').filter(Boolean)[0]
      const target = p && s.provider!.hasRoot(rootName) ? p : s.roots[0] ? `/${s.roots[0].name}` : ''
      if (!target) return
      const tab: Tab = { id: nextTabId(), history: [target], idx: 0, view: null, filter: '' }
      const tabs = [...s.tabs, tab]
      set({ tabs: withSession(tabs, tab.id), activeId: tab.id, listings: { ...s.listings, [tab.id]: { entries: [], loading: true } }, selection: { ...s.selection, [tab.id]: [] } })
      void loadDir(tab.id)
    },

    closeTab(id) {
      const s = get()
      const tab = s.tabs.find((t) => t.id === id)
      if (!tab) return
      if (tab.view?.dirty) {
        ui().showDialog({
          type: 'confirm',
          title: '未保存的修改',
          message: `「${tab.view.entry.name}」有未保存的修改,确定要关闭标签页吗?`,
          danger: true,
          okText: '放弃修改',
          onOk: () => {
            ui().closeDialog()
            actuallyCloseTab(id)
          },
        })
        return
      }
      actuallyCloseTab(id)
    },

    setActive(id) {
      const s = get()
      if (s.activeId === id) return
      set({ activeId: id, selection: { ...s.selection, [id]: s.selection[id] ?? [] } })
      persistSession(get().tabs, id)
      if (!get().listings[id]) void loadDir(id)
    },

    jumpToTab(index) {
      const t = get().tabs[index]
      if (t) get().setActive(t.id)
    },

    /** 拖拽重排:把 fromId 的标签移动到 toId 标签当前所在位置 */
    moveTab(fromId, toId) {
      const s = get()
      const from = s.tabs.findIndex((t) => t.id === fromId)
      const to = s.tabs.findIndex((t) => t.id === toId)
      if (from === -1 || to === -1 || from === to) return
      const tabs = [...s.tabs]
      const [moved] = tabs.splice(from, 1)
      tabs.splice(to, 0, moved)
      set({ tabs })
      persistSession(tabs, s.activeId)
    },

    nextTab(delta) {
      const s = get()
      if (s.tabs.length < 2) return
      const idx = s.tabs.findIndex((t) => t.id === s.activeId)
      const next = s.tabs[(idx + delta + s.tabs.length) % s.tabs.length]
      get().setActive(next.id)
    },

    /** 回主页:复用已有主页标签,没有则新建(与侧栏入口一致) */
    openHome() {
      const tab = activeTab()
      if (tab && tab.history[tab.idx] === HOME_PATH) return
      get().newTab(HOME_PATH)
    },

    navigate(path, tabId) {
      const s = get()
      const tab = tabId ? s.tabs.find((t) => t.id === tabId) : activeTab()
      if (!tab) return
      const cur = tab.history[tab.idx]
      if (!path || path === cur) return
      const rootName = path.split('/').filter(Boolean)[0]
      if (!s.provider!.hasRoot(rootName)) {
        ui().toast(`未找到根目录「${rootName}」`, 'error')
        return
      }
      const history = [...tab.history.slice(0, tab.idx + 1), path]
      const tabs = s.tabs.map((t) =>
        t.id === tab.id ? { ...t, history, idx: history.length - 1, view: null, filter: '' } : t
      )
      set({
        tabs: withSession(tabs, s.activeId),
        selection: { ...s.selection, [tab.id]: [] },
        anchor: { ...s.anchor, [tab.id]: undefined },
        renamingPath: null,
      })
      // 主动导航离开主页时,复位主页分类展开状态
      if (path !== HOME_PATH) useScan.setState({ openGroup: null })
      void loadDir(tab.id)
    },

    goBack() {
      const s = get()
      const tab = activeTab()
      if (!tab || tab.idx === 0) return
      const tabs = s.tabs.map((t) => (t.id === tab.id ? { ...t, idx: t.idx - 1, view: null, filter: '' } : t))
      set({ tabs: withSession(tabs, s.activeId), selection: { ...s.selection, [tab.id]: [] } })
      void loadDir(tab.id)
    },

    goForward() {
      const s = get()
      const tab = activeTab()
      if (!tab || tab.idx >= tab.history.length - 1) return
      const tabs = s.tabs.map((t) => (t.id === tab.id ? { ...t, idx: t.idx + 1, view: null, filter: '' } : t))
      set({ tabs: withSession(tabs, s.activeId), selection: { ...s.selection, [tab.id]: [] } })
      void loadDir(tab.id)
    },

    goUp() {
      const tab = activeTab()
      if (!tab) return
      if (tab.history[tab.idx] === HOME_PATH) return
      const parent = parentOf(tab.history[tab.idx])
      if (parent !== '/') get().navigate(parent)
    },

    async refresh(tabId) {
      const id = tabId ?? get().activeId
      const tab = get().tabs.find((t) => t.id === id)
      if (tab?.history[tab.idx] === HOME_PATH) {
        await (await import('./scan')).useScan.getState().scan()
        return
      }
      if (id) await loadDir(id)
    },

    setFilter(text) {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      set({ tabs: withSession(s.tabs.map((t) => (t.id === tab.id ? { ...t, filter: text } : t)), s.activeId) })
    },

    openEntry(entry, opts) {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      const entryCat = categoryOf(entry)
      if (entry.kind === 'directory' && entryCat !== 'executable') {
        // 普通文件夹导航;.app 等 bundle 不是文件夹,走下面的查看/运行
        get().navigate(entry.path)
        return
      }
      // .app bundle:双击行为由 execAppBundleDoubleClick 设置决定(默认进可执行信息,可切为访达式直接运行)
      const isBundle = entry.kind === 'directory' && entryCat === 'executable'
      // 可执行/安装包/脚本 → 分流到运行链路(主进程分级 + 原生确认);
      // forceView(Alt+双击 / 菜单「打开可执行信息」)跳过运行直接进查看器
      const bundleWantsRun = isBundle && useSettings.getState().execAppBundleDoubleClick === 'run'
      if (!opts?.forceView && (bundleWantsRun || isLaunchableEntry(entry))) {
        void launchEntry(entry)
        return
      }
      // 普通文件按打开方式设置分流(扩展名配置 → 类型配置 → 内置查看器):
      // system=系统默认 app=指定应用 internal=内置查看器
      // forceView(Alt+双击/查看器内「上一个/下一个」)同时跳过分流,强制进内置查看器
      const target = opts?.forceView
        ? ({ kind: 'internal' } as import('./settings').OpenWithTarget)
        : useSettings.getState().getOpenWithForEntry(entry)
      if (target.kind === 'system') {
        // 防双击双启动:双击 = 两次 click,同一文件 600ms 内只触发一次外部打开
        const now = Date.now()
        if (lastExternalOpen.path === entry.path && now - lastExternalOpen.at < 600) return
        lastExternalOpen = { path: entry.path, at: now }
        if (s.provider?.openInSystem) {
          s.provider
            .openInSystem(entry.path)
            .catch((e) => useUi.getState().toast(String(e.message || e), 'error'))
        } else {
          useUi.getState().toast('当前环境不支持用系统默认应用打开', 'error')
        }
        return
      }
      if (target.kind === 'app') {
        const now = Date.now()
        if (lastExternalOpen.path === entry.path && now - lastExternalOpen.at < 600) return
        lastExternalOpen = { path: entry.path, at: now }
        if (s.provider?.openWithApp) {
          s.provider
            .openWithApp(entry.path, target.appPath)
            .catch((e) => useUi.getState().toast(String(e.message || e), 'error'))
        } else {
          useUi.getState().toast('当前环境不支持指定应用打开', 'error')
        }
        return
      }
      const category = entryCat
      const tabs = s.tabs.map((t) =>
        t.id === tab.id ? { ...t, view: { entry, category, dirty: false } } : t
      )
      set({ tabs })
      persistSession(tabs, s.activeId)
    },

    requestCloseView() {
      const s = get()
      const tab = activeTab()
      if (!tab?.view) return
      if (tab.view.dirty) {
        ui().showDialog({
          type: 'confirm',
          title: '未保存的修改',
          message: `「${tab.view.entry.name}」有未保存的修改,确定要关闭吗?`,
          danger: true,
          okText: '放弃修改',
          onOk: () => {
            ui().closeDialog()
            get().closeView()
          },
        })
      } else {
        get().closeView()
      }
    },

    closeView() {
      const s = get()
      const tab = activeTab()
      if (!tab?.view) return
      const tabs = s.tabs.map((t) => (t.id === tab.id ? { ...t, view: null } : t))
      set({ tabs })
      registerSaveFn(null)
    },

    setDirty(dirty) {
      const s = get()
      const tab = activeTab()
      if (!tab?.view || tab.view.dirty === dirty) return
      set({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, view: { ...t.view!, dirty } } : t)) })
    },

    async saveView() {
      if (saveFn) await saveFn()
    },

    clickSelect(entry, index, ordered, e) {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      const sel = s.selection[tab.id] ?? []
      const anchor = s.anchor[tab.id]
      let next: string[]
      if (e.ctrlKey || e.metaKey) {
        next = sel.includes(entry.path) ? sel.filter((p) => p !== entry.path) : [...sel, entry.path]
        set({ anchor: { ...s.anchor, [tab.id]: entry.path } })
      } else if (e.shiftKey && anchor) {
        const a = ordered.findIndex((x) => x.path === anchor)
        if (a === -1) next = [entry.path]
        else {
          const [lo, hi] = a < index ? [a, index] : [index, a]
          next = ordered.slice(lo, hi + 1).map((x) => x.path)
        }
      } else {
        next = [entry.path]
        set({ anchor: { ...s.anchor, [tab.id]: entry.path } })
      }
      set({ selection: { ...s.selection, [tab.id]: next } })
    },

    selectAll(ordered) {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      set({ selection: { ...s.selection, [tab.id]: ordered.map((e) => e.path) } })
    },

    clearSelection() {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      set({ selection: { ...s.selection, [tab.id]: [] } })
    },

    startRename(path) {
      set({ renamingPath: path })
    },

    async commitRename(newName) {
      const s = get()
      const path = s.renamingPath
      set({ renamingPath: null })
      if (!path || !isValidName(newName) || newName === baseName(path)) return
      const kind = s.listings[s.activeId]?.entries.find((e) => e.path === path)?.kind ?? 'file'
      try {
        const to = await s.provider!.rename(path, kind, newName)
        const op: UndoOp = { kind: 'rename', from: path, to, entryKind: kind }
        pushUndoOp(op)
        // 正在查看该文件时同步路径
        const tab = activeTab()
        if (tab?.view?.entry.path === path) {
          set({
            tabs: s.tabs.map((t) =>
              t.id === tab.id
                ? { ...t, view: { ...t.view!, entry: { ...t.view!.entry, path: to, name: newName } } }
                : t
            ),
          })
        }
        await get().refresh()
        ui().toast('已重命名', 'success')
      } catch (e) {
        ui().toast(errToast(e), 'error')
      }
    },

    createEntry(kind) {
      const tab = activeTab()
      if (!tab) return
      const isFolder = kind === 'folder'
      ui().showDialog({
        type: 'prompt',
        title: isFolder ? '新建文件夹' : '新建文件',
        label: '名称',
        initial: isFolder ? '新建文件夹' : '新建文本文档.txt',
        okText: '创建',
        validate: (v) => (isValidName(v) ? null : '名称不能为空且不能包含 / 或 \\'),
        onOk: async (name) => {
          ui().closeDialog()
          const s = get()
          const p = joinPath(tab.history[tab.idx], name)
          try {
            if (await s.provider!.exists(p)) {
              ui().toast('同名项目已存在', 'error')
              return
            }
            if (isFolder) await s.provider!.mkdir(p)
            else await s.provider!.createFile(p)
            const op: UndoOp = { kind: 'create', target: { path: p, kind: isFolder ? 'directory' : 'file' } }
            pushUndoOp(op)
            await get().refresh()
            set({ selection: { ...get().selection, [tab.id]: [p] } })
          } catch (e) {
            ui().toast(errToast(e), 'error')
          }
        },
      })
    },

    deleteSelection() {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      const sel = s.selection[tab.id] ?? []
      if (!sel.length) return
      const entries = (s.listings[tab.id]?.entries ?? []).filter((e) => sel.includes(e.path))
      if (!entries.length) return
      // 桌面版删除进回收站/废纸篓,文案如实
      const plat = (s.provider as unknown as { platform?: string } | null)?.platform
      const tail =
        s.provider?.kind === 'native'
          ? plat === 'darwin'
            ? '文件将被移到废纸篓。'
            : '文件将被移入回收站。'
          : '此操作无法撤销。'
      const doDelete = () => {
        ui().closeDialog()
        void get().deletePaths(
          entries.map((e) => e.path),
          entries.map((e) => e.kind)
        )
      }
      if (entries.length === 1) {
        ui().showDialog({
          type: 'confirm',
          title: '删除项目',
          message: `确定要删除「${entries[0].name}」吗?${tail}`,
          danger: true,
          okText: '删除',
          onOk: doDelete,
        })
      } else {
        ui().showDialog({
          type: 'confirm',
          title: '删除多个项目',
          message: `确定要删除选中的 ${entries.length} 个项目吗?${tail}`,
          danger: true,
          okText: '全部删除',
          onOk: doDelete,
        })
      }
    },

    permanentDeleteSelection() {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      const sel = s.selection[tab.id] ?? []
      if (!sel.length) return
      const entries = (s.listings[tab.id]?.entries ?? []).filter((e) => sel.includes(e.path))
      if (!entries.length) return
      const doDelete = () => {
        ui().closeDialog()
        void get().deletePaths(
          entries.map((e) => e.path),
          entries.map((e) => e.kind),
          true
        )
      }
      ui().showDialog({
        type: 'confirm',
        title: '彻底删除',
        message: `确定要彻底删除选中的 ${entries.length} 个项目吗?\n不经过回收站/废纸篓,此操作无法撤销。`,
        danger: true,
        okText: '彻底删除',
        onOk: doDelete,
      })
    },

    async deletePaths(paths, kinds, permanent = false) {
      const s = get()
      const provider = s.provider!
      // 与批量复制/移动互斥:作业进行中删除会抢进度条并干扰作业读取源文件
      if (opAbort) {
        ui().toast('已有文件操作正在进行,请先等待完成或取消', 'error')
        return
      }
      const label = permanent ? '彻底删除中' : '删除中'
      const token = ++opSeq
      s.setOp({ label, done: 0, total: paths.length, canCancel: false })
      const trashed: CopyItem[] = []
      const removed = new Set<string>() // 实际删除成功的路径:只有这些才从选中集里清掉
      let ok = 0
      let failed = 0
      let lastErr: unknown = null
      // 逐项 try/catch:单项失败(被占用/不支持回收站等)不中断剩余项,成功项照常进撤销栈
      for (let i = 0; i < paths.length; i++) {
        try {
          const r = await removeWithResult(provider, paths[i], kinds[i], permanent)
          if (r.trashed) trashed.push({ path: paths[i], kind: kinds[i] })
          removed.add(paths[i])
          ok++
        } catch (e) {
          failed++
          lastErr = e
        }
        const cur = get().op
        if (cur) set({ op: { ...cur, done: i + 1 } })
      }
      // 进了回收站的删除可以「还原」:主进程没有回收站还原接口,
      // 所以撤销只做提示,同时把记录写进 localStorage 供重启后查看最近删除。
      if (trashed.length) {
        const at = Date.now()
        const records: DeletedRecord[] = trashed.map((it) => ({
          path: it.path,
          name: baseName(it.path),
          kind: it.kind,
          at,
          trashed: true,
        }))
        const next = [...records, ...get().recentDeleted].slice(0, RECENT_DELETED_MAX)
        set({ recentDeleted: next })
        persistRecentDeleted(next)
        pushUndoOp({ kind: 'trash', items: trashed, at })
      }
      if (failed) {
        ui().toast(`已删除 ${ok} 个,失败 ${failed} 个(${errToast(lastErr)})`, 'error')
      } else {
        ui().toast(
          trashed.length
            ? `已删除 ${ok} 个项目(已移入回收站,可在回收站中还原)`
            : `已删除 ${ok} 个项目`,
          'success'
        )
      }
      {
        if (opSeq === token) get().setOp(null)
        // 从选中集中移除实际删除成功的路径(失败的文件还在,不能清);
        // 同一文件可能在多个标签页都被选中,遍历所有 tab 清理
        const tabs = get().tabs
        for (const t of tabs) {
          const sel = get().selection[t.id]
          if (!sel?.length) continue
          const next = sel.filter((x) => !removed.has(x))
          if (next.length !== sel.length) set({ selection: { ...get().selection, [t.id]: next } })
          const anc = get().anchor[t.id]
          if (anc && removed.has(anc)) set({ anchor: { ...get().anchor, [t.id]: undefined } })
        }
        // 正在查看被删除的文件则关闭查看器
        const tab = activeTab()
        if (tab?.view && paths.includes(tab.view.entry.path)) get().closeView()
        await get().refresh()
      }
    },

    copySelection(entries) {
      if (!entries.length) return
      set({ clipboard: { mode: 'copy', entries } })
      ui().toast(`已复制 ${entries.length} 个项目`)
      writeSystemClipboard(entries, false)
    },

    cutSelection(entries) {
      if (!entries.length) return
      set({ clipboard: { mode: 'cut', entries } })
      ui().toast(`已剪切 ${entries.length} 个项目`)
      writeSystemClipboard(entries, true)
    },

    async paste() {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      const destDir = tab.history[tab.idx]
      if (s.clipboard) {
        const clip = s.clipboard
        // 同目录剪切 = 无操作;同目录复制 = 生成副本(交给冲突流程重命名)
        if (clip.mode === 'cut' && clip.entries.every((e) => parentOf(e.path) === destDir)) {
          ui().toast('源和目标是同一个文件夹', 'info')
          set({ clipboard: null })
          return
        }
        await runConflictAware(clip.entries, destDir, clip.mode === 'cut')
        if (clip.mode === 'cut') set({ clipboard: null })
        return
      }
      // 应用内剪贴板为空:尝试系统剪贴板(仅桌面版且目标是真实目录)
      if (s.provider?.kind !== 'native' || destDir === HOME_PATH) {
        ui().toast('剪贴板是空的', 'info')
        return
      }
      const extras = nativeExtras()
      if (!extras) {
        ui().toast('剪贴板是空的', 'info')
        return
      }
      let clip: { paths: string[]; cut: boolean } | null = null
      try {
        clip = await extras.clipRead()
      } catch {
        clip = null
      }
      if (!clip || !clip.paths.length) {
        ui().toast('剪贴板是空的', 'info')
        return
      }
      const ep = s.provider as ElectronProvider
      // 本机路径 → 虚拟路径,并按父目录分组 list 一次拿到 kind/size(顺带过滤已不存在的路径)
      const byParent = new Map<string, string[]>()
      for (const np of clip.paths) {
        try {
          const vp = ep.toVirtualPath(np)
          const parent = parentOf(vp)
          const arr = byParent.get(parent)
          if (arr) arr.push(vp)
          else byParent.set(parent, [vp])
        } catch {
          /* 不在任何已挂载根内,跳过 */
        }
      }
      const entries: FileEntry[] = []
      for (const [parent, vps] of byParent) {
        try {
          const list = await s.provider.list(parent)
          for (const vp of vps) {
            const hit = list.find((e) => e.path === vp)
            if (hit) entries.push(hit)
          }
        } catch {
          /* 父目录已不可访问,跳过 */
        }
      }
      if (!entries.length) {
        ui().toast('剪贴板中没有可用的文件', 'info')
        return
      }
      await runConflictAware(entries, destDir, clip.cut)
    },

    async moveEntries(entries, destDir) {
      if (!entries.length) return
      await runConflictAware(entries, destDir, true)
    },

    async undo() {
      const s = get()
      const op = s.undoStack[s.undoStack.length - 1]
      if (!op) {
        ui().toast('没有可撤销的操作')
        return
      }
      // 撤销成功后压入的反向动作;重做完成后把原操作放回撤销栈,撤销链保持连续
      const pushBackUndo = () => set({ undoStack: [...get().undoStack, op].slice(-50) })
      const redo: { run(): Promise<void> } = (() => {
        const p = () => get().provider!
        if (op.kind === 'create') {
          return {
            run: async () => {
              if (op.target.kind === 'directory') await p().mkdir(op.target.path)
              else await p().createFile(op.target.path)
              pushBackUndo()
            },
          }
        }
        if (op.kind === 'rename') {
          return {
            run: async () => {
              await p().rename(op.from, op.entryKind, baseName(op.to))
              pushBackUndo()
            },
          }
        }
        if (op.kind === 'paste') {
          return {
            run: async () => {
              for (let i = 0; i < op.created.length; i++) {
                const src = op.sources[i]
                if (!src) continue
                const entry: FileEntry = {
                  name: baseName(src.path),
                  path: src.path,
                  kind: src.kind,
                  size: 0,
                  modified: null,
                  ext: '',
                }
                const destDir = parentOf(op.created[i].path)
                const sameDir = destDir === parentOf(src.path)
                await copyEntries(p(), [entry], destDir, sameDir ? { mode: 'keepBoth', sameDirCopy: true } : { mode: 'overwrite' })
              }
              pushBackUndo()
            },
          }
        }
        if (op.kind === 'trash') {
          return {
            run: async () => {
              for (const it of op.items) await p().remove(it.path, it.kind)
              pushBackUndo()
            },
          }
        }
        return {
          run: async () => {
            for (const pair of op.pairs) {
              const entry: FileEntry = {
                name: baseName(pair.source.path),
                path: pair.source.path,
                kind: pair.source.kind,
                size: 0,
                modified: null,
                ext: '',
              }
              await copyEntries(p(), [entry], parentOf(pair.created.path), { mode: 'overwrite', move: true })
            }
            pushBackUndo()
          },
        }
      })()
      try {
        if (op.kind === 'create') {
          // 防误删:目录里已被放入内容、或空文件已被编辑(非 0 字节)时拒绝撤销
          try {
            if (op.target.kind === 'directory') {
              const children = await s.provider!.list(op.target.path)
              if (children.length) {
                ui().toast(`「${baseName(op.target.path)}」里已有内容,已跳过撤销(不会连内容一起删除)`, 'error')
                return
              }
            } else {
              const siblings = await s.provider!.list(parentOf(op.target.path))
              const hit = siblings.find((x) => x.path === op.target.path)
              if (hit && hit.size > 0) {
                ui().toast(`「${baseName(op.target.path)}」已被编辑过,已跳过撤销删除`, 'error')
                return
              }
            }
          } catch {
            /* 目标已不存在等:继续走删除,由 remove 报出真实错误 */
          }
          await s.provider!.remove(op.target.path, op.target.kind)
        } else if (op.kind === 'rename') {
          await s.provider!.rename(op.to, op.entryKind, baseName(op.from))
        } else if (op.kind === 'paste') {
          for (const c of [...op.created].reverse()) await s.provider!.remove(c.path, c.kind)
        } else if (op.kind === 'move') {
          for (const pair of op.pairs) {
            const entry: FileEntry = {
              name: baseName(pair.created.path),
              path: pair.created.path,
              kind: pair.created.kind,
              size: 0,
              modified: null,
              ext: '',
            }
            await copyEntries(s.provider!, [entry], parentOf(pair.source.path), { mode: 'overwrite', move: true })
          }
        }
        // trash 没有可用的还原接口,撤销只提示去回收站还原;
        // 此时若注册 redo,用户还原文件后再按重做会把刚还原的文件再次删除 —— 不注册
        const trashed = op.kind === 'trash'
        set({
          undoStack: s.undoStack.slice(0, -1),
          redoStack: (trashed ? get().redoStack : [...get().redoStack, redo]).slice(-50),
        })
        ui().toast(trashed ? '文件已移入回收站,请从回收站还原' : '已撤销', trashed ? 'info' : 'success')
        await get().refresh()
      } catch (e) {
        ui().toast(errToast(e), 'error')
      }
    },

    async redo() {
      const s = get()
      const entry = s.redoStack[s.redoStack.length - 1]
      if (!entry) {
        ui().toast('没有可重做的操作')
        return
      }
      try {
        set({ redoStack: s.redoStack.slice(0, -1) })
        await entry.run()
        ui().toast('已重做', 'success')
        await get().refresh()
      } catch (e) {
        ui().toast(errToast(e), 'error')
      }
    },

    /** 复制副本:在原目录生成「名称 (2)」 */
    async duplicateSelection() {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      const sel = s.selection[tab.id] ?? []
      if (sel.length !== 1) return
      const entry = (s.listings[tab.id]?.entries ?? []).find((e) => e.path === sel[0])
      if (!entry) return
      await runConflictAware([entry], parentOf(entry.path), false)
    },

    cancelOperation() {
      if (!get().op?.canCancel) return
      opAbort?.abort()
      opAbort = null
      const cur = get().op
      if (cur) set({ op: { ...cur, canCancel: false, label: '正在取消…' } })
    },

    setOp(op) {
      set({ op })
    },
  }
})

/* ---------------- 系统剪贴板写入(随应用内复制/剪切同步) ---------------- */

function writeSystemClipboard(entries: FileEntry[], cut: boolean) {
  const s = useFs.getState()
  if (s.provider?.kind !== 'native') return
  const extras = nativeExtras()
  if (!extras) return
  const ep = s.provider as ElectronProvider
  const paths: string[] = []
  for (const e of entries) {
    try {
      paths.push(ep.toNativePath(e.path))
    } catch {
      /* 演示根等无本机路径,跳过 */
    }
  }
  if (!paths.length) return
  extras.clipWrite(paths, cut).catch(() => {})
}

/* ---------------- 目录实时监听(仅桌面版) ---------------- */

/** 虚拟目录 → watchId,插入顺序即创建顺序(Map 保序,用于淘汰最旧) */
const watchIds = new Map<string, number>()
/** 防 watchStart 并发重复发起 */
const watchPending = new Set<string>()
const WATCH_MAX = 16

/** 当前所有 tab 正在浏览的真实目录(HOME_PATH 除外) */
function desiredWatchDirs(): Set<string> {
  const s = useFs.getState()
  if (s.provider?.kind !== 'native') return new Set()
  return new Set(s.tabs.map((t) => t.history[t.idx]).filter((p) => p !== HOME_PATH))
}

/**
 * 对账式同步:想让所有打开的 tab 目录都有 watch。
 * - 不在期望集合里的旧 watch 停掉(导航离开/关标签/删根后清理)
 * - 新目录 watchStart(同目录去重,含并发去重)
 * - 超过 WATCH_MAX 时按创建顺序停最旧的
 * loadDir 可能并发调用,靠 watchId 兜底:事件按 dir 匹配,不与具体 tab 强绑定。
 */
async function syncWatches() {
  const s = useFs.getState()
  if (s.provider?.kind !== 'native') return
  const extras = nativeExtras()
  if (!extras) return
  const ep = s.provider as ElectronProvider
  const want = desiredWatchDirs()

  for (const [dir, id] of [...watchIds]) {
    if (want.has(dir)) continue
    watchIds.delete(dir)
    extras.watchStop(id).catch(() => {})
  }

  for (const dir of want) {
    if (watchIds.has(dir) || watchPending.has(dir)) continue
    if (watchIds.size + watchPending.size >= WATCH_MAX) break
    let nativeDir: string
    try {
      nativeDir = ep.toNativePath(dir)
    } catch {
      continue
    }
    watchPending.add(dir)
    try {
      const id = await extras.watchStart(nativeDir)
      // await 期间目录可能已不期望/已有同目录 watch:立即停掉多余的
      if (!want.has(dir) || watchIds.has(dir)) {
        extras.watchStop(id).catch(() => {})
      } else {
        watchIds.set(dir, id)
      }
    } catch {
      /* 目录可能已消失,忽略 */
    } finally {
      watchPending.delete(dir)
    }
  }

  // 兜底淘汰(理论上 start 侧已限流)
  while (watchIds.size > WATCH_MAX) {
    const oldest = watchIds.keys().next().value
    if (oldest === undefined) break
    const id = watchIds.get(oldest)!
    watchIds.delete(oldest)
    extras.watchStop(id).catch(() => {})
  }
}

// 模块级只订阅一次:回调内部按 provider 类型/批量操作状态自行过滤
if (typeof window !== 'undefined') {
  const extras = nativeExtras()
  if (extras) {
    extras.onFsChanged((ev) => {
      const s = useFs.getState()
      if (s.provider?.kind !== 'native') return
      if (s.op) return // 批量操作进行中跳过,避免干扰进度
      let vdir: string
      try {
        vdir = (s.provider as ElectronProvider).toVirtualPath(ev.dir)
      } catch {
        return
      }
      for (const t of s.tabs) {
        if (t.history[t.idx] !== vdir) continue
        if (s.listings[t.id]?.loading) continue // 已有刷新在途
        void loadDir(t.id) // 只重载 listings,不动 selection/滚动
      }
    })
    window.addEventListener('beforeunload', () => {
      extras.watchStopAll().catch(() => {})
    })
  }
}

/** 在终端打开当前 tab 所在目录(桌面版,失败 toast) */
function openTerminalHere() {
  const s = useFs.getState()
  const extras = nativeExtras()
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const dir = tab ? tab.history[tab.idx] : ''
  if (!extras || !dir || dir === HOME_PATH) return
  try {
    extras
      .openInTerminal((s.provider as ElectronProvider).toNativePath(dir))
      .catch((e: unknown) => useUi.getState().toast(String((e as Error).message || e), 'error'))
  } catch (e) {
    useUi.getState().toast(String((e as Error).message || e), 'error')
  }
}

/** 判断条目是否走"运行"链路(executable/installer 类,或按设置的脚本) */
function isLaunchableEntry(entry: FileEntry): boolean {
  if (entry.kind !== 'file' && categoryOf(entry) !== 'executable') return false
  const cat = categoryOf(entry)
  if (LAUNCHABLE_CATEGORIES.has(cat)) return true
  // 脚本保留在 code 类:双击行为由 execScriptDefault 设置决定
  if (isScriptEntry(entry)) return useSettings.getState().execScriptDefault === 'run'
  return false
}

/** 运行入口:路径转本机格式后交主进程分级 + 原生确认;确认框在主进程,渲染层不画 */
async function launchEntry(entry: FileEntry, args?: string[]) {
  const s = useFs.getState()
  const launch = nativeLaunch()
  if (!launch || s.provider?.kind !== 'native') {
    useUi.getState().toast('当前环境不支持运行程序', 'error')
    return
  }
  // execRunPolicy 在主进程 exec:run 内部生效(never→跳过确认),此处不重复判定
  try {
    const native = (s.provider as ElectronProvider).toNativePath(entry.path)
    const r = await launch.execRun({ path: native, args })
    if (r.mode === 'denied') {
      useUi.getState().toast(r.reason || '已取消运行', 'info')
      return
    }
    useUi.getState().toast(`已启动 ${entry.name}`, 'success')
  } catch (e) {
    useUi.getState().toast(String((e as Error).message || e), 'error')
  }
}

/** 构造单个文件的「打开方式」子菜单;会同时修改该扩展名的默认设置 */
function buildOpenWithMenuItems(entry: FileEntry): MenuItem[] {
  const s = useFs.getState()
  if (s.provider?.kind !== 'native' || entry.kind !== 'file') return []
  const st = useSettings.getState()
  const ext = extOf(entry.name)
  const target = st.getOpenWith(ext)
  const check = (kind: string) => (target.kind === kind ? '✓ ' : '')
  const provider = s.provider as ElectronProvider
  const apply = async (t: import('./settings').OpenWithTarget) => {
    try {
      if (t.kind === 'internal') {
        st.setOpenWith(ext, { kind: 'internal' })
        s.openEntry(entry, { forceView: true })
      } else if (t.kind === 'system') {
        st.setOpenWith(ext, { kind: 'system' })
        await provider.openInSystem!(entry.path)
      } else if (t.kind === 'app') {
        st.setOpenWith(ext, t)
        await provider.openWithApp!(entry.path, t.appPath)
      }
    } catch (e) {
      useUi.getState().toast(String((e as Error).message || e), 'error')
    }
  }
  const pickOther = async () => {
    try {
      const appPath = await provider.pickOpenWithApp!()
      if (!appPath) return
      const appName = appPath.replace(/\\/g, '/').split('/').pop() || appPath
      await apply({ kind: 'app', appPath, appName })
    } catch (e) {
      useUi.getState().toast(String((e as Error).message || e), 'error')
    }
  }
  return [
    {
      label: '打开方式',
      children: [
        { label: `${check('internal')}内置查看器`, onClick: () => void apply({ kind: 'internal' }) },
        { label: `${check('system')}系统默认应用`, onClick: () => void apply({ kind: 'system' }) },
        { label: '其他应用...', onClick: () => void pickOther() },
        { sep: true },
        {
          label: '重置为内置查看器',
          disabled: target.kind === 'internal',
          onClick: () => st.setOpenWith(ext, { kind: 'internal' }),
        },
      ],
    },
  ]
}

/** 供 FileList 的右键菜单使用:基于当前选择构造通用操作项 */
export function buildEntryMenuItems(sel: FileEntry[]): MenuItem[] {
  const s = useFs.getState()
  const items: MenuItem[] = []
  const single = sel.length === 1
  const plat = (s.provider as unknown as { platform?: string } | null)?.platform
  const isNative = s.provider?.kind === 'native'
  const launch = nativeLaunch()
  if (single && sel[0].kind === 'directory') {
    const cat = categoryOf(sel[0])
    if (cat === 'executable') {
      // bundle(.app 等):第一项是「运行」,之后才是「打开包内容」
      items.push({ label: '运行', onClick: () => s.openEntry(sel[0]) })
      items.push({ label: '打开可执行信息', onClick: () => s.openEntry(sel[0], { forceView: true }) })
    } else {
      items.push({ label: '打开', onClick: () => s.openEntry(sel[0]) })
      items.push({ label: '在新标签页打开', onClick: () => s.newTab(sel[0].path) })
    }
    items.push({ sep: true })
  }
  // 单个可执行/安装包/脚本:置顶「运行」组(受保护目录时禁用,由主进程 execIsSensitive 判定)
  if (isNative && launch && single && sel[0].kind === 'file' && isLaunchableEntry(sel[0])) {
    const entry = sel[0]
    items.push({ label: categoryOf(entry) === 'installer' ? '安装' : '运行', onClick: () => void launchEntry(entry) })
    items.push({ label: '打开可执行信息', onClick: () => s.openEntry(entry, { forceView: true }) })
    if (isScriptEntry(entry)) {
      items.push({ label: '在终端中运行', onClick: () => openTerminalHere() })
    }
    items.push({ sep: true })
  }
  items.push({ label: '复制', disabled: !sel.length, onClick: () => s.copySelection(sel) })
  items.push({ label: '剪切', disabled: !sel.length, onClick: () => s.cutSelection(sel) })
  if (single) items.push({ label: '重命名 (F2)', onClick: () => s.startRename(sel[0].path) })
  items.push({
    label: sel.length > 1 ? `删除 ${sel.length} 项` : '删除',
    danger: true,
    disabled: !sel.length,
    onClick: () => s.deleteSelection(),
  })
  if (isNative && single) {
    items.push({ sep: true })
    items.push({
      label: plat === 'darwin' ? '在 Finder 中显示' : '在资源管理器中显示',
      onClick: () => {
        const p = s.provider as unknown as { reveal(p: string): Promise<void> }
        p.reveal(sel[0].path).catch((e) => useUi.getState().toast(String(e.message || e), 'error'))
      },
    })
    if (sel[0].kind === 'file') {
      items.push(...buildOpenWithMenuItems(sel[0]))
    }
    if (nativeExtras()) {
      items.push({ label: '在终端打开', onClick: openTerminalHere })
    }
  }
  return items
}

export function buildEmptyMenuItems(): MenuItem[] {
  const s = useFs.getState()
  const st = useSettings.getState()
  const isNative = s.provider?.kind === 'native'
  const check = (on: boolean) => (on ? '✓ ' : '')
  const items: MenuItem[] = [
    {
      label: '新建',
      children: [
        { label: '文件夹', onClick: () => s.createEntry('folder') },
        { label: '文本文档', onClick: () => s.createEntry('file') },
      ],
    },
    {
      label: '排序方式',
      children: [
        {
          label: `${check(st.sortKey === 'name' && st.sortAsc)}名称`,
          onClick: () => {
            st.set('sortKey', 'name')
            st.set('sortAsc', true)
          },
        },
        {
          label: `${check(st.sortKey === 'size' && !st.sortAsc)}大小`,
          onClick: () => {
            st.set('sortKey', 'size')
            st.set('sortAsc', false)
          },
        },
        {
          label: `${check(st.sortKey === 'modified' && !st.sortAsc)}修改时间`,
          onClick: () => {
            st.set('sortKey', 'modified')
            st.set('sortAsc', false)
          },
        },
        {
          label: `${check(st.sortKey === 'type' && st.sortAsc)}类型`,
          onClick: () => {
            st.set('sortKey', 'type')
            st.set('sortAsc', true)
          },
        },
        { sep: true },
        { label: `${check(st.foldersFirst)}目录优先`, onClick: () => st.set('foldersFirst', !st.foldersFirst) },
      ],
    },
    {
      label: '显示',
      children: [
        { label: `${check(st.viewMode === 'details')}详细列表`, onClick: () => st.set('viewMode', 'details') },
        { label: `${check(st.viewMode === 'grid')}大图标`, onClick: () => st.set('viewMode', 'grid') },
        { sep: true },
        { label: `${check(st.showHidden)}显示隐藏文件`, onClick: () => st.toggle('showHidden') },
      ],
    },
    { sep: true },
    // 桌面版应用内剪贴板为空时还能从系统剪贴板读,所以不按 s.clipboard 禁用
    { label: '粘贴', disabled: !s.clipboard && !isNative, onClick: () => void s.paste() },
    { sep: true },
    { label: '刷新', onClick: () => void s.refresh() },
  ]
  if (isNative && nativeExtras()) {
    items.push({ label: '在终端打开', onClick: openTerminalHere })
  }
  return items
}

// 便于控制台调试
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__fs = useFs
}
