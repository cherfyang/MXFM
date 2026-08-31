import { create } from 'zustand'
import type { FSProvider, FileEntry, RootInfo, ConflictMode } from '../fs/types'
import { FsaProvider } from '../fs/fsa'
import { ElectronProvider } from '../fs/electron'
import { CapacitorProvider, isCapacitorNative } from '../fs/capacitor'
import { HOME_PATH, useScan } from './scan'
import { MemoryProvider, buildDemoRoot } from '../fs/memory'
import { copyEntries, type CopyItem } from '../fs/ops'
import { idbAllRoots, idbPutRoot, idbDeleteRoot } from '../fs/idb'
import { joinPath, parentOf, baseName, isValidName } from '../utils/path'
import { categoryOf, type Category } from '../utils/categories'
import { useUi, type MenuItem } from './ui'

export interface ViewedFile {
  entry: FileEntry
  category: Category
  dirty: boolean
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

type UndoOp =
  | { kind: 'create'; target: CopyItem }
  | { kind: 'rename'; from: string; to: string; entryKind: 'file' | 'directory' }
  | { kind: 'paste'; created: CopyItem[] }
  | { kind: 'move'; pairs: { created: CopyItem; source: CopyItem }[] }

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
  op: { label: string; done: number; total: number } | null
  undoStack: UndoOp[]

  init(): Promise<void>
  addRoot(): Promise<void>
  addRootFromHandle(handle: FileSystemDirectoryHandle): Promise<void>
  addDemoRoot(): Promise<void>
  reauthRoot(name: string): Promise<void>
  removeRoot(name: string): Promise<void>

  newTab(path?: string): void
  closeTab(id: string): void
  setActive(id: string): void
  navigate(path: string, tabId?: string): void
  goBack(): void
  goForward(): void
  goUp(): void
  refresh(tabId?: string): Promise<void>
  setFilter(text: string): void

  openEntry(entry: FileEntry): void
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
  deletePaths(paths: string[], kinds: ('file' | 'directory')[]): Promise<void>
  copySelection(entries: FileEntry[]): void
  cutSelection(entries: FileEntry[]): void
  paste(): Promise<void>
  moveEntries(entries: FileEntry[], destDir: string): Promise<void>
  undo(): Promise<void>

  setOp(op: FsState['op']): void
}

let tabSeq = 1
const nextTabId = () => `t${tabSeq++}`

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
      const s2 = get()
      s2.setOp({ label: move ? '移动中' : '复制中', done: 0, total: entries.length })
      try {
        const out = await copyEntries(provider, entries, destDir, {
          mode,
          move,
          sameDirCopy: sameDir && !move,
          onProgress: (done, total) => get().setOp({ label: move ? '移动中' : '复制中', done, total }),
        })
        const n = out.created.length
        ui().toast(
          `${move ? '移动' : '复制'}完成:${n} 项${out.skipped ? `,跳过 ${out.skipped}` : ''}${out.overwritten ? `,覆盖 ${out.overwritten}` : ''}`,
          'success'
        )
        if (out.created.length) {
          const tab = activeTab()
          if (tab && tab.history[tab.idx] === destDir) {
            set({ selection: { ...get().selection, [tab.id]: out.created.map((c) => c.path) } })
          }
        }
        if (out.overwritten === 0 && out.created.length) {
          const op: UndoOp = move
            ? {
                kind: 'move',
                pairs: out.results
                  .map((r, i) => (r ? { created: r, source: { path: entries[i].path, kind: entries[i].kind } } : null))
                  .filter(Boolean) as { created: CopyItem; source: CopyItem }[],
              }
            : { kind: 'paste', created: out.created }
          set({ undoStack: [...get().undoStack, op].slice(-50) })
        }
      } catch (e) {
        ui().toast(errToast(e), 'error')
      } finally {
        get().setOp(null)
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
    undoStack: [],

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
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return
      const tabs = s.tabs.filter((t) => t.id !== id)
      const listings = { ...s.listings }
      const selection = { ...s.selection }
      delete listings[id]
      delete selection[id]
      let activeId = s.activeId
      if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? ''
      set({ tabs: withSession(tabs, activeId), activeId, listings, selection })
    },

    setActive(id) {
      const s = get()
      if (s.activeId === id) return
      set({ activeId: id, selection: { ...s.selection, [id]: s.selection[id] ?? [] } })
      persistSession(get().tabs, id)
      if (!get().listings[id]) void loadDir(id)
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

    openEntry(entry) {
      const s = get()
      const tab = activeTab()
      if (!tab) return
      if (entry.kind === 'directory') {
        get().navigate(entry.path)
        return
      }
      const category = categoryOf(entry)
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
        set({ undoStack: [...s.undoStack, op].slice(-50) })
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
            set({ undoStack: [...s.undoStack, op].slice(-50) })
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

    async deletePaths(paths, kinds) {
      const s = get()
      s.setOp({ label: '删除中', done: 0, total: paths.length })
      let ok = 0
      try {
        for (let i = 0; i < paths.length; i++) {
          await s.provider!.remove(paths[i], kinds[i])
          ok++
          get().setOp({ label: '删除中', done: i + 1, total: paths.length })
        }
        ui().toast(`已删除 ${ok} 个项目`, 'success')
      } catch (e) {
        ui().toast(errToast(e), 'error')
      } finally {
        get().setOp(null)
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
    },

    cutSelection(entries) {
      if (!entries.length) return
      set({ clipboard: { mode: 'cut', entries } })
      ui().toast(`已剪切 ${entries.length} 个项目`)
    },

    async paste() {
      const s = get()
      const tab = activeTab()
      if (!tab || !s.clipboard) return
      const destDir = tab.history[tab.idx]
      const clip = s.clipboard
      // 同目录剪切 = 无操作;同目录复制 = 生成副本(交给冲突流程重命名)
      if (clip.mode === 'cut' && clip.entries.every((e) => parentOf(e.path) === destDir)) {
        ui().toast('源和目标是同一个文件夹', 'info')
        set({ clipboard: null })
        return
      }
      await runConflictAware(clip.entries, destDir, clip.mode === 'cut')
      if (clip.mode === 'cut') set({ clipboard: null })
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
      try {
        if (op.kind === 'create') {
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
        set({ undoStack: s.undoStack.slice(0, -1) })
        ui().toast('已撤销', 'success')
        await get().refresh()
      } catch (e) {
        ui().toast(errToast(e), 'error')
      }
    },

    setOp(op) {
      set({ op })
    },
  }
})

/** 供 FileList 的右键菜单使用:基于当前选择构造通用操作项 */
export function buildEntryMenuItems(sel: FileEntry[]): MenuItem[] {
  const s = useFs.getState()
  const items: MenuItem[] = []
  const single = sel.length === 1
  const plat = (s.provider as unknown as { platform?: string } | null)?.platform
  const isNative = s.provider?.kind === 'native'
  if (single && sel[0].kind === 'directory') {
    items.push({ label: '打开', onClick: () => s.openEntry(sel[0]) })
    items.push({ label: '在新标签页打开', onClick: () => s.newTab(sel[0].path) })
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
      items.push({
        label: '用系统默认程序打开',
        onClick: () => {
          const p = s.provider as unknown as { openInSystem(p: string): Promise<void> }
          p.openInSystem(sel[0].path).catch((e) => useUi.getState().toast(String(e.message || e), 'error'))
        },
      })
    }
  }
  return items
}

export function buildEmptyMenuItems(): MenuItem[] {
  const s = useFs.getState()
  return [
    { label: '新建文件夹', onClick: () => s.createEntry('folder') },
    { label: '新建文本文档', onClick: () => s.createEntry('file') },
    { sep: true },
    { label: '粘贴', disabled: !s.clipboard, onClick: () => void s.paste() },
    { sep: true },
    { label: '刷新', onClick: () => void s.refresh() },
  ]
}

// 便于控制台调试
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__fs = useFs
}
