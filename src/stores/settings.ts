import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ViewMode = 'details' | 'grid'
export type SortKey = 'name' | 'size' | 'type' | 'modified'
export type ThemeId = 'dark' | 'light' | 'green' | 'warm' | 'ocean'

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
      set: (key, value) => set({ [key]: value } as Partial<SettingsState>),
      toggle: (key) => set({ [key]: !get()[key] } as Partial<SettingsState>),
    }),
    {
      name: 'mx-fm-settings',
      migrate: (state) => {
        // 旧版本只有 dark/light 两值,直接兼容
        const t = (state as { theme?: string }).theme
        if (t !== 'dark' && t !== 'light' && t !== 'green' && t !== 'warm' && t !== 'ocean') {
          ;(state as { theme?: ThemeId }).theme = 'dark'
        }
        return state as SettingsState
      },
      version: 1,
    }
  )
)
