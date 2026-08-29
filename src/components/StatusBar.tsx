import { useFs } from '../stores/fs'

export function StatusBar() {
  const s = useFs()
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const listing = tab ? s.listings[tab.id] : undefined
  const sel = tab ? (s.selection[tab.id] ?? []) : []
  const selEntries = (listing?.entries ?? []).filter((e) => sel.includes(e.path))
  const selSize = selEntries.reduce((a, e) => a + (e.kind === 'file' ? e.size : 0), 0)
  const pct = s.op ? Math.round((s.op.done / Math.max(s.op.total, 1)) * 100) : 0

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-brd bg-panel px-3 text-xs text-txt2">
      <span>
        {listing ? `${listing.entries.length} 个项目` : '—'}
        {sel.length > 0 && ` · 选中 ${sel.length} 项`}
        {selSize > 0 && ` (${formatSize(selSize)})`}
      </span>
      {s.op && (
        <span className="flex flex-1 items-center gap-2">
          <span className="text-txt">
            {s.op.label} {s.op.done}/{s.op.total}
          </span>
          <span className="h-1.5 w-40 overflow-hidden rounded-full bg-panel2">
            <span className="block h-full rounded-full bg-acc transition-all" style={{ width: `${pct}%` }} />
          </span>
        </span>
      )}
      <span className="flex-1" />
      {tab?.history[tab.idx] && <span className="max-w-[40%] truncate">{tab.history[tab.idx]}</span>}
      <span className="rounded bg-panel2 px-1.5 py-0.5 text-[11px]">
        {s.provider?.kind === 'memory' ? '演示数据' : s.provider?.kind === 'native' ? '本地磁盘' : '浏览器授权'}
      </span>
    </footer>
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
