import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useFs } from '../stores/fs'
import { useSettings } from '../stores/settings'
import type { FileEntry } from '../fs/types'
import { resolveCategory, ViewerHost } from '../viewers/registry'
import type { Category } from '../utils/categories'

/** 右侧快速预览面板:选中单个文件后按空格打开 */
export function PreviewPanel() {
  const s = useFs()
  const st = useSettings()
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const sel = tab ? (s.selection[tab.id] ?? []) : []
  const entry: FileEntry | null =
    sel.length === 1 ? (s.listings[tab!.id]?.entries ?? []).find((e) => e.path === sel[0]) ?? null : null

  const [cat, setCat] = useState<Category>('binary')
  useEffect(() => {
    if (!entry) return
    let alive = true
    resolveCategory(entry).then((c) => alive && setCat(c))
    return () => {
      alive = false
    }
  }, [entry?.path, entry?.kind, entry?.ext])

  if (!st.previewVisible || !tab || tab.view || !entry) return null

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-brd bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-brd px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{entry.name}</span>
        <button
          onClick={() => st.set('previewVisible', false)}
          className="rounded p-1 text-txt2 hover:bg-hover hover:text-txt"
          title="关闭预览 (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ViewerHost entry={entry} category={cat} readOnly embedded />
    </aside>
  )
}
