import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ViewMode = 'details' | 'grid'
export type SortKey = 'name' | 'size' | 'type' | 'modified'
export type ThemeId = 'dark' | 'light' | 'green' | 'warm' | 'ocean'
export type ExecRunPolicy = 'alwaysAsk' | 'askUntrusted' | 'never'
export type ExecAppBundleDoubleClick = 'viewer' | 'run'
export type ExecScriptDefault = 'view' | 'run'

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
  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void
  toggle(key: 'viewMode' | 'foldersFirst' | 'showHidden' | 'singleClickOpen' | 'sidebarVisible' | 'previewVisible'): void
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
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      toggle: (key) => set({ [key]: !get()[key] } as Partial<SettingsState>),
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
        }
        return s as unknown as SettingsState
      },
      version: 2,
    }
  )
)
