import { create } from 'zustand'
import { nativeExtras2, type TrashItem } from '../fs/electron'
import { useFs } from './fs'
import { useUi } from './ui'

interface TrashState {
  items: TrashItem[]
  loading: boolean
  error: string | null
  load(): Promise<void>
  restore(ids: string[]): Promise<void>
  empty(): Promise<void>
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 能力缺失文案:浏览器版 / 桌面版但 preload 太旧(Capacitor 壳的 kind 也是 native,同样落这里) */
function unavailable(): string {
  return useFs.getState().provider?.kind === 'native' ? '当前版本主进程不支持回收站' : '浏览器版不支持回收站'
}

export const useTrash = create<TrashState>()((set, get) => ({
  items: [],
  loading: false,
  error: null,

  /** 拉取回收站列表;浏览器版/无能力时直接置错误 */
  async load() {
    const extras = nativeExtras2()
    if (!extras) {
      set({ items: [], loading: false, error: unavailable() })
      return
    }
    set({ loading: true, error: null })
    try {
      const items = await extras.trashList()
      set({ items, loading: false })
    } catch (e) {
      set({ error: errText(e), loading: false })
    }
  },

  /** 还原选中项(确认与否由 UI 层负责);toast 结果后刷新列表 */
  async restore(ids) {
    if (!ids.length) return
    const ui = useUi.getState()
    const extras = nativeExtras2()
    if (!extras) {
      ui.toast(unavailable(), 'error')
      return
    }
    try {
      const r = await extras.trashRestore(ids)
      ui.toast(
        r.failed ? `还原成功 ${r.restored} 项,失败 ${r.failed} 项` : `已还原 ${r.restored} 项`,
        r.failed ? 'error' : 'success'
      )
    } catch (e) {
      ui.toast(errText(e), 'error')
    }
    await get().load()
  },

  /** 清空回收站(确认弹窗由 UI 层负责,这里只执行);toast 后刷新列表 */
  async empty() {
    const ui = useUi.getState()
    const extras = nativeExtras2()
    if (!extras) {
      ui.toast(unavailable(), 'error')
      return
    }
    try {
      const r = await extras.trashEmpty()
      ui.toast(`已清空回收站(共 ${r.cleaned} 项)`, 'success')
    } catch (e) {
      ui.toast(errText(e), 'error')
    }
    await get().load()
  },
}))
