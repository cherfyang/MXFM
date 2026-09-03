import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { categoryOf, openWithCategoryOf } from '../utils/categories'

export type ViewMode = 'details' | 'grid'
export type SortKey = 'name' | 'size' | 'type' | 'modified'
export type ThemeId = 'dark' | 'light' | 'green' | 'warm' | 'ocean'
export type ExecRunPolicy = 'alwaysAsk' | 'askUntrusted' | 'never'
export type ExecAppBundleDoubleClick = 'viewer' | 'run'
export type ExecScriptDefault = 'view' | 'run'

/** 某种扩展名/类型对应的默认打开目标 */
export type OpenWithTarget =
  | { kind: 'internal' }
  | { kind: 'system' }
  | { kind: 'app'; appPath: string; appName?: string }

export interface ThemeMeta {
  id: ThemeId
  name: string
  dark: boolean
}

export const THEMES: ThemeMeta[] = [
  { id: 'dark', name: '深色', dark: true },
  { id: 'light', name: '浅色(白天)', dark: false },
  { id: 'green', name: '护眼绿', dark: false },
  { id: 'warm', name: '暖阳米黄', dark: false },
  { id: 'ocean', name: '海洋深蓝', dark: true },
]

export function themeMeta(id: string): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** 统一扩展名 key:小写、保留前导点、无扩展名返回空串 */
export function normalizeExt(ext: string): string {
  const e = ext.trim().toLowerCase()
  if (!e) return ''
  return e.startsWith('.') ? e : '.' + e
}

interface SettingsState {
  theme: ThemeId
  viewMode: ViewMode
  sortKey: SortKey
  sortAsc: boolean
  foldersFirst: boolean
  showHidden: boolean
  singleClickOpen: boolean
  sidebarVisible: boolean
  previewVisible: boolean
  // ---- 可执行程序 ----
  /** 运行前确认策略:alwaysAsk=每次确认 askUntrusted=仅未记住的程序确认 never=不确认(不推荐) */
  execRunPolicy: ExecRunPolicy
  /** .app bundle 双击行为:viewer=进可执行信息 run=直接运行(同访达) */
  execAppBundleDoubleClick: ExecAppBundleDoubleClick
  /** 脚本双击默认行为:view=编辑器 run=运行 */
  execScriptDefault: ExecScriptDefault
  /** 系统受保护目录内禁用运行 */
  execSafeModeSystemDirs: boolean
  /** 是否显示角标(安装包/脚本) */
  execShowBadges: boolean
  /** 透明图片背景棋盘格:true=显示 false=隐藏(默认隐藏)。文件列表缩略图与图片查看器共用 */
  showCheckerboard: boolean
  /** 按扩展名设置默认打开方式:key=小写扩展名(含点,无扩展名用 '');未命中则看类型配置,再回退内置查看器 */
  openWith: Record<string, OpenWithTarget>
  /** 按"大类"(视频/图片/音频等)设置默认打开方式:key=OPEN_WITH_CATEGORIES 的 id;优先级低于扩展名配置 */
  openWithCategory: Record<string, OpenWithTarget>
  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void
  toggle(key: 'viewMode' | 'foldersFirst' | 'showHidden' | 'singleClickOpen' | 'sidebarVisible' | 'previewVisible' | 'showCheckerboard'): void
  /** 设置/取消某个扩展名的默认打开方式;target=null 表示删除(回退到内置) */
  setOpenWith(ext: string, target: OpenWithTarget | null): void
  /** 设置/取消某个大类的默认打开方式;target=null 表示删除(回退到扩展名配置或内置) */
  setOpenWithCategory(catId: string, target: OpenWithTarget | null): void
  /** 读取某个扩展名的默认打开方式(总是返回有效对象) */
  getOpenWith(ext: string): OpenWithTarget
  /** 统一解析:扩展名配置 → 类型(大类)配置 → 内置查看器 */
  getOpenWithForEntry(entry: { kind: 'file' | 'directory'; name: string; ext: string }): OpenWithTarget
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      viewMode: 'details',
      sortKey: 'name',
      sortAsc: true,
      foldersFirst: true,
      showHidden: false,
      singleClickOpen: true,
      sidebarVisible: true,
      previewVisible: false,
      execRunPolicy: 'askUntrusted',
      execAppBundleDoubleClick: 'viewer',
      execScriptDefault: 'view',
      execSafeModeSystemDirs: true,
      execShowBadges: true,
      showCheckerboard: false,
      openWith: {},
      openWithCategory: {},
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      toggle: (key) => set({ [key]: !get()[key] } as Partial<SettingsState>),
      setOpenWith: (ext, target) => {
        const key = normalizeExt(ext)
        const next = { ...get().openWith }
        if (!target || target.kind === 'internal') delete next[key]
        else next[key] = target
        set({ openWith: next })
      },
      setOpenWithCategory: (catId, target) => {
        const next = { ...get().openWithCategory }
        if (!target || target.kind === 'internal') delete next[catId]
        else next[catId] = target
        set({ openWithCategory: next })
      },
      getOpenWith: (ext) => {
        return get().openWith[normalizeExt(ext)] ?? { kind: 'internal' }
      },
      getOpenWithForEntry: (entry) => {
        const st = get()
        // 扩展名配置最优先(显式针对单个格式的设置不该被大类覆盖)
        const byExt = st.openWith[normalizeExt(entry.ext || extFromEntryName(entry.name))]
        if (byExt) return byExt
        const byCat = st.openWithCategory[openWithCategoryOf(categoryOf(entry)) ?? '']
        if (byCat) return byCat
        return { kind: 'internal' }
      },
    }),
    {
      name: 'mx-fm-settings',
      migrate: (state, version) => {
        // v0/v1 → v2:补默认值;旧版本只有 dark/light 两值,直接兼容
        const s = state as Record<string, unknown>
        const t = s.theme
        if (t !== 'dark' && t !== 'light' && t !== 'green' && t !== 'warm' && t !== 'ocean') {
          s.theme = 'dark'
        }
        if (version < 2) {
          s.execRunPolicy ??= 'askUntrusted'
          s.execAppBundleDoubleClick ??= 'viewer'
          s.execScriptDefault ??= 'view'
          s.execSafeModeSystemDirs ??= true
          s.execShowBadges ??= true
          s.showCheckerboard ??= false
          s.openWith ??= {}
        }
        if (version < 3) {
          s.openWithCategory ??= {}
        }
        return s as unknown as SettingsState
      },
      version: 3,
    }
  )
)

function extFromEntryName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}
