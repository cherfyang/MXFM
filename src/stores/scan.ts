import { create } from 'zustand'
import type { FileEntry } from '../fs/types'
import { categoryOf, type Category } from '../utils/categories'

/** 主页虚拟路径(@开头,不对应真实目录) */
export const HOME_PATH = '@home'

export type ScanGroup = '图片' | '视频' | '音频' | '文档' | '压缩包' | '电子书'

export const SCAN_GROUPS: { name: ScanGroup }[] = [
  { name: '图片' },
  { name: '视频' },
  { name: '音频' },
  { name: '文档' },
  { name: '压缩包' },
  { name: '电子书' },
]

function groupOf(cat: Category): ScanGroup | null {
  switch (cat) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'audio':
      return '音频'
    case 'pdf':
    case 'word':
    case 'excel':
    case 'csv':
    case 'ppt':
    case 'legacy':
    case 'markdown':
      return '文档'
    case 'zip':
      return '压缩包'
    case 'ebook':
      return '电子书'
    default:
      return null
  }
}

const SKIP_DIRS = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'perflogs',
  'system volume information', 'config.msi', 'recovery', 'appdata', 'node_modules',
  '.git', 'library', 'system', 'applications', 'usr', 'private', 'opt', 'cores',
  'volumes', 'xboxgames', 'windowsapps', 'drivers', 'intel', 'amd', 'nvidia',
])
const SKIP_FILES = new Set([
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp', 'desktop.ini',
])
const MAX_DEPTH = 10
const MAX_DIRS = 25000
const MAX_TOTAL_FILES = 60000
const RECENT_KEEP = 200
const TIME_CAP_MS = 120000 // 2 分钟硬上限

export interface CatResult {
  count: number
  size: number
  recent: FileEntry[]
}

function emptyGroups(): Record<ScanGroup, CatResult> {
  const g = {} as Record<ScanGroup, CatResult>
  for (const { name } of SCAN_GROUPS) g[name] = { count: 0, size: 0, recent: [] }
  return g
}

interface ScanState {
  running: boolean
  scannedDirs: number
  lastScanAt: number | null
  groups: Record<ScanGroup, CatResult>
  /** 主页当前展开的分类;放 store 里,打开文件预览使主页卸载后返回时仍能恢复 */
  openGroup: ScanGroup | null
  setOpenGroup(g: ScanGroup | null): void
  scan(): Promise<void>
}

const PERSIST_KEY = 'mx-fm-scan'

function hydrate(): { lastScanAt: number | null; groups: Record<ScanGroup, CatResult> } {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (raw) {
      const d = JSON.parse(raw)
      if (d.groups) return { lastScanAt: d.lastScanAt ?? null, groups: { ...emptyGroups(), ...d.groups } }
    }
  } catch {
    /* ignore */
  }
  return { lastScanAt: null, groups: emptyGroups() }
}

const initial = hydrate()

export const useScan = create<ScanState>()((set, get) => ({
  running: false,
  scannedDirs: 0,
  lastScanAt: initial.lastScanAt,
  groups: initial.groups,
  openGroup: null,
  setOpenGroup: (g) => set({ openGroup: g }),

  async scan() {
    if (get().running) return
    const provider = (await import('./fs')).useFs.getState().provider
    if (!provider) return
    const roots = (await import('./fs')).useFs.getState().roots.map((r) => '/' + r.name)
    if (!roots.length) return

    set({ running: true, scannedDirs: 0 })
    const groups = emptyGroups()
    const queue: string[] = [...roots]
    let scanned = 0
    let totalFiles = 0
    const startedAt = Date.now()

    const push = (e: FileEntry) => {
      const g = groupOf(categoryOf(e))
      if (!g) return
      const gr = groups[g]
      gr.count++
      gr.size += e.size
      if (e.modified) {
        gr.recent.push(e)
        if (gr.recent.length > RECENT_KEEP + 40) {
          gr.recent.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
          gr.recent.length = RECENT_KEEP
        }
      }
    }

    const worker = async () => {
      while (queue.length && !get().running === false) {
        if (Date.now() - startedAt > TIME_CAP_MS || scanned > MAX_DIRS || totalFiles > MAX_TOTAL_FILES) return
        const dir = queue.shift()
        if (!dir) return
        if (dir.split('/').filter(Boolean).length > MAX_DEPTH) continue
        let entries: FileEntry[]
        try {
          entries = await provider.list(dir)
        } catch {
          continue
        }
        for (const e of entries) {
          if (e.kind === 'directory') {
            const name = e.name.toLowerCase()
            if (SKIP_DIRS.has(name) || name.startsWith('$') || name.startsWith('.')) continue
            queue.push(e.path)
          } else {
            if (SKIP_FILES.has(e.name.toLowerCase())) continue
            totalFiles++
            push(e)
          }
        }
        scanned++
        if (scanned % 50 === 0) set({ scannedDirs: scanned, groups: { ...groups } })
      }
    }

    await Promise.all([worker(), worker(), worker(), worker()])

    for (const g of Object.values(groups)) {
      g.recent.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
      g.recent.length = Math.min(g.recent.length, RECENT_KEEP)
    }
    const lastScanAt = Date.now()
    set({ running: false, scannedDirs: scanned, groups: { ...groups }, lastScanAt })
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ lastScanAt, groups }))
    } catch {
      /* 容量超限等,忽略 */
    }
  },
}))
