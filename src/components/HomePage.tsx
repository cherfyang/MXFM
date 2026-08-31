import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  FileImage,
  Film,
  Music,
  FileText,
  FileArchive,
  BookOpen,
  RefreshCw,
  ChevronRight,
  Home,
  Loader2,
  FolderOpen,
} from 'lucide-react'
import { useScan, SCAN_GROUPS, type ScanGroup } from '../stores/scan'
import { useFs } from '../stores/fs'
import { fmtBytes, fmtDate } from '../utils/format'
import { categoryOf } from '../utils/categories'
import { EntryIcon } from './Icons'
import { parentOf } from '../utils/path'
import type { FileEntry } from '../fs/types'

const GROUP_STYLE: Record<ScanGroup, { icon: typeof FileImage; cls: string }> = {
  图片: { icon: FileImage, cls: 'text-emerald-500 bg-emerald-500/10' },
  视频: { icon: Film, cls: 'text-violet-400 bg-violet-400/10' },
  音频: { icon: Music, cls: 'text-pink-400 bg-pink-400/10' },
  文档: { icon: FileText, cls: 'text-sky-400 bg-sky-400/10' },
  压缩包: { icon: FileArchive, cls: 'text-amber-400 bg-amber-400/10' },
  电子书: { icon: BookOpen, cls: 'text-teal-400 bg-teal-400/10' },
}

export function HomePage() {
  const scan = useScan()
  const s = useFs()
  const [openGroup, setOpenGroup] = useState<ScanGroup | null>(null)

  // 启动自动更新:数据缺失或距上次扫描超过 30 分钟时自动重扫
  useEffect(() => {
    const stale = !scan.lastScanAt || Date.now() - scan.lastScanAt > 30 * 60 * 1000
    if (stale && !scan.running) void scan.scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recents = useMemo(() => {
    const all: FileEntry[] = []
    for (const g of Object.values(scan.groups)) all.push(...g.recent)
    return all.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).slice(0, 20)
  }, [scan.groups])

  const fmtTimeAgo = (ts: number | null) => {
    if (!ts) return '从未扫描'
    const m = Math.floor((Date.now() - ts) / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return `${m} 分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h} 小时前`
    return fmtDate(ts)
  }

  const open = (e: FileEntry) => s.openEntry(e)

  if (openGroup) {
    return <GroupList group={openGroup} onBack={() => setOpenGroup(null)} onOpen={open} />
  }

  const totalFiles = Object.values(scan.groups).reduce((a, g) => a + g.count, 0)
  const pct = scan.running ? Math.min(95, Math.round((scan.scannedDirs / 300) * 100)) : 100

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* 头部 */}
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-acc text-white">
            <Home className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold">主页</div>
            <div className="text-xs text-txt2">
              {scan.running
                ? `正在扫描本机文件… 已检查 ${scan.scannedDirs} 个文件夹`
                : `共发现 ${totalFiles.toLocaleString()} 个媒体/文档文件 · 上次扫描:${fmtTimeAgo(scan.lastScanAt)}`}
            </div>
          </div>
          <button
            onClick={() => void scan.scan()}
            disabled={scan.running}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-acc px-4 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {scan.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {scan.running ? '扫描中' : '重新扫描'}
          </button>
        </div>

        {scan.running && (
          <div className="mb-6 h-1.5 overflow-hidden rounded-full bg-panel2">
            <div className="h-full rounded-full bg-acc transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}

        {/* 分类卡片 */}
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {SCAN_GROUPS.map(({ name }) => {
            const g = scan.groups[name]
            const { icon: Icon, cls } = GROUP_STYLE[name]
            return (
              <button
                key={name}
                onClick={() => g.count > 0 && setOpenGroup(name)}
                className={`flex flex-col items-start gap-2 rounded-xl border border-brd bg-panel p-4 text-left transition-all ${
                  g.count > 0 ? 'hover:border-acc hover:shadow-md' : 'opacity-60'
                }`}
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${cls}`}>
                  <Icon className="h-5.5 w-5.5" />
                </span>
                <span className="mt-1 w-full truncate text-xl font-semibold tabular-nums">{g.count.toLocaleString()}</span>
                <span className="flex w-full items-center justify-between text-xs text-txt2">
                  <span>{name}</span>
                  <span>{g.count > 0 ? fmtBytes(g.size) : '—'}</span>
                </span>
              </button>
            )
          })}
        </div>

        {/* 最近文件 */}
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">最近文件</div>
          <div className="text-xs text-txt2">来自上次扫描,点击直接打开</div>
        </div>
        <div className="overflow-hidden rounded-xl border border-brd bg-panel">
          {recents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-txt2">
              <FolderOpen className="h-8 w-8 opacity-40" />
              <div className="text-sm">{scan.running ? '扫描完成后显示' : '还没有扫描结果,点击右上角「重新扫描」'}</div>
            </div>
          ) : (
            recents.map((e, i) => (
              <div
                key={e.path}
                onClick={() => open(e)}
                className={`flex cursor-default items-center gap-3 px-4 py-2.5 hover:bg-hover ${i > 0 ? 'border-t border-brd' : ''}`}
                title={e.path}
              >
                <EntryIcon category={categoryOf(e)} className="h-5 w-5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{e.name}</span>
                  <span className="block truncate text-[11px] text-txt2">{parentOf(e.path)}</span>
                </span>
                <span className="shrink-0 text-xs text-txt2">{fmtBytes(e.size)}</span>
                <span className="w-[110px] shrink-0 text-right text-xs text-txt2">{fmtDate(e.modified)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function GroupList({ group, onBack, onOpen }: { group: ScanGroup; onBack(): void; onOpen(e: FileEntry): void }) {
  const scan = useScan()
  const items = scan.groups[group].recent
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 20,
  })
  const { icon: Icon, cls } = GROUP_STYLE[group]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-brd bg-panel px-3">
        <button onClick={onBack} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-txt2 hover:bg-hover hover:text-txt">
          <Home className="h-4 w-4" /> 主页
        </button>
        <ChevronRight className="h-4 w-4 text-txt2" />
        <span className={`flex h-7 w-7 items-center justify-center rounded-md ${cls}`}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">{group}</span>
        <span className="text-xs text-txt2">
          {scan.groups[group].count.toLocaleString()} 个 · {fmtBytes(scan.groups[group].size)} · 显示最近 {items.length} 个
        </span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const e = items[vi.index]
            return (
              <div
                key={e.path}
                onClick={() => onOpen(e)}
                className="absolute left-0 top-0 flex w-full cursor-default items-center gap-3 px-5 hover:bg-hover"
                style={{ height: 44, transform: `translateY(${vi.start}px)` }}
                title={e.path}
              >
                <EntryIcon category={categoryOf(e)} />
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{e.name}</span>
                <span className="hidden min-w-0 max-w-[45%] flex-1 truncate text-[11px] text-txt2 sm:block">
                  {parentOf(e.path)}
                </span>
                <span className="shrink-0 text-xs text-txt2">{fmtBytes(e.size)}</span>
                <span className="w-[100px] shrink-0 text-right text-xs text-txt2">{fmtDate(e.modified)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
