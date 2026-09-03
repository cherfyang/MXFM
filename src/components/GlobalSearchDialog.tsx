import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X, Loader2, RefreshCw, Folder, ExternalLink, FolderOpen } from 'lucide-react'
import { useGlobalSearch, itemToFileEntry, type GlobalSearchItem } from '../stores/globalSearch'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { categoryOf, type Category } from '../utils/categories'
import { extOf, fmtBytes, fmtDate } from '../utils/format'
import { EntryIcon } from './Icons'
import { Btn } from './ui'
import type { FileEntry } from '../fs/types'
import { parentOf } from '../utils/path'

/** 分类过滤:与主页扫描的六大类对齐,方便按类型缩小结果 */
const FILTERS: { id: string; label: string; match(e: { kind: 'file' | 'directory'; name: string; ext: string }): boolean }[] = [
  { id: 'all', label: '全部', match: () => true },
  { id: 'folder', label: '文件夹', match: (e) => e.kind === 'directory' },
  { id: 'image', label: '图片', match: (e) => e.kind === 'file' && categoryOf(e) === 'image' },
  { id: 'video', label: '视频', match: (e) => e.kind === 'file' && categoryOf(e) === 'video' },
  { id: 'audio', label: '音频', match: (e) => e.kind === 'file' && categoryOf(e) === 'audio' },
  {
    id: 'document',
    label: '文档',
    match: (e) => {
      if (e.kind !== 'file') return false
      const c = categoryOf(e)
      return c === 'pdf' || c === 'word' || c === 'ppt' || c === 'legacy' || c === 'markdown' || c === 'text' || c === 'code'
    },
  },
  { id: 'sheet', label: '表格', match: (e) => e.kind === 'file' && (categoryOf(e) === 'excel' || categoryOf(e) === 'csv') },
  { id: 'zip', label: '压缩包', match: (e) => e.kind === 'file' && categoryOf(e) === 'zip' },
  { id: 'ebook', label: '电子书', match: (e) => e.kind === 'file' && categoryOf(e) === 'ebook' },
  { id: 'exe', label: '程序', match: (e) => e.kind === 'file' && (categoryOf(e) === 'executable' || categoryOf(e) === 'installer') },
]

type SortId = 'relevance' | 'name' | 'size' | 'modified'
const SORTS: { id: SortId; label: string }[] = [
  { id: 'relevance', label: '相关度' },
  { id: 'name', label: '名称' },
  { id: 'size', label: '大小' },
  { id: 'modified', label: '修改时间' },
]

function fmtTimeAgo(ts: number | null): string {
  if (!ts) return '从未构建'
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return fmtDate(ts)
}

/** 文件名高亮:非通配符查询时把命中片段标色 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q || /[*?]/.test(q)) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-acc">{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  )
}

function toFileEntry(r: GlobalSearchItem) {
  return itemToFileEntry(r)
}

export function GlobalSearchDialog() {
  const gs = useGlobalSearch()
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState<SortId>('relevance')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const close = () => useUi.getState().closeDialog()
  const query = gs.query.trim()

  useEffect(() => {
    inputRef.current?.focus()
    useGlobalSearch.getState().refreshIndex()
    // Esc 关闭对话框(挂在 window 上,输入框聚焦时同样生效)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 索引构建中每 3 秒轮询一次状态(进度事件已订阅,这里兜底拿最终 count)
  useEffect(() => {
    if (!gs.index.building) return
    const t = window.setInterval(() => useGlobalSearch.getState().refreshIndex(), 3000)
    return () => window.clearInterval(t)
  }, [gs.index.building])

  const items = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0]
    const list = gs.results.filter((r) => f.match({ kind: r.isDir ? 'directory' : 'file', name: r.name, ext: extOf(r.name) }))
    if (sort !== 'relevance') {
      const dir = sort === 'name' ? 1 : -1
      list.sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
        if (sort === 'size') return (a.size - b.size) * dir
        return ((a.modified ?? 0) - (b.modified ?? 0)) * dir
      })
    }
    return list
  }, [gs.results, filter, sort])

  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 46,
    overscan: 20,
  })

  const openItem = (r: GlobalSearchItem) => {
    const entry = toFileEntry(r)
    if (!entry) {
      useUi.getState().toast('该项不在已挂载的磁盘根内,无法打开', 'error')
      return
    }
    close()
    useFs.getState().openEntry(entry)
  }

  const revealItem = (r: GlobalSearchItem) => {
    if (!r.vpath) return
    const p = useFs.getState().provider as unknown as { reveal?(p: string): Promise<void> } | null
    p?.reveal?.(r.vpath).catch((e) => useUi.getState().toast(String((e as Error).message || e), 'error'))
  }

  const showMenu = (e: React.MouseEvent, r: GlobalSearchItem) => {
    e.preventDefault()
    const entry = toFileEntry(r)
    useUi.getState().openMenu(e.clientX, e.clientY, [
      { label: '打开', disabled: !entry, onClick: () => entry && openItem(r) },
      {
        label: '打开所在位置',
        disabled: !entry,
        onClick: () => {
          if (!entry) return
          close()
          useFs.getState().navigate(parentOf(entry.path))
        },
      },
      { label: '在资源管理器中显示', onClick: () => revealItem(r) },
      ...(entry && !r.isDir
        ? [
            {
              label: '用系统默认程序打开',
              onClick: () => {
                close()
                useFs
                  .getState()
                  .provider!.openInSystem!(entry.path)
                  .catch((err) => useUi.getState().toast(String((err as Error).message || err), 'error'))
              },
            },
          ]
        : []),
    ])
  }

  // Enter 打开第一个可见结果
  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && items.length) {
      e.preventDefault()
      openItem(items[0])
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/45 pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="mx-fade flex h-[min(72vh,640px)] w-[min(760px,calc(100vw-24px))] flex-col rounded-xl border border-brd bg-panel shadow-2xl shadow-black/30">
        {/* 搜索框 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-brd px-3">
          <Search className="h-4.5 w-4.5 shrink-0 text-txt2" />
          <input
            ref={inputRef}
            value={gs.query}
            onChange={(e) => useGlobalSearch.getState().setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索整个电脑的文件名…支持 * ? 通配符"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-txt2"
          />
          {gs.searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-acc" />}
          <button onClick={close} className="rounded p-1.5 text-txt2 hover:bg-hover hover:text-txt" title="关闭 (Esc)">
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* 索引状态 + 过滤/排序 */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-brd px-3 py-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`h-6 rounded-full px-2.5 text-xs transition-colors ${
                filter === f.id ? 'bg-acc text-white' : 'bg-panel2 text-txt2 hover:bg-hover hover:text-txt'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="flex-1" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortId)}
            className="h-6 rounded-md bg-panel2 px-1 text-xs text-txt2 outline-none [&>option]:text-black"
            title="结果排序"
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                按{s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-brd px-3 py-1.5 text-[11px] text-txt2">
          {gs.index.building ? (
            <>
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-acc" />
              <span>正在构建全盘索引(已索引 {gs.index.count.toLocaleString()} 项),当前结果可能不全</span>
            </>
          ) : (
            <span>
              已索引 {gs.index.count.toLocaleString()} 项 · 上次构建:{fmtTimeAgo(gs.index.lastBuildAt)}
              {gs.index.roots.length ? `(${gs.index.roots.join(' ')})` : ''}
            </span>
          )}
          <span className="flex-1" />
          <Btn className="h-6 px-2 text-xs" disabled={gs.index.building} onClick={() => useGlobalSearch.getState().rebuild()}>
            <RefreshCw className="h-3 w-3" /> 重建索引
          </Btn>
        </div>

        {/* 结果列表 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const r = items[vi.index]
              const openable = !!r.vpath
              return (
                <div
                  key={r.path}
                  style={{ height: 46, transform: `translateY(${vi.start}px)` }}
                  className="absolute left-0 top-0 flex w-full cursor-default items-center gap-2.5 px-3 hover:bg-hover"
                  title={r.path}
                  onClick={() => openItem(r)}
                  onContextMenu={(e) => showMenu(e, r)}
                >
                  {r.isDir ? <Folder className="h-5 w-5 shrink-0 text-acc" /> : <EntryIcon category={categoryOf({ kind: 'file', name: r.name, ext: extOf(r.name) })} />}
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-[13.5px] ${openable ? '' : 'opacity-50'}`}>
                      <Highlight text={r.name} query={query} />
                    </div>
                    <div className="truncate text-[11px] text-txt2">{parentOf(r.path.replace(/\\/g, '/'))}</div>
                  </div>
                  {!openable && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-txt2 opacity-40" />}
                  <span className="w-[80px] shrink-0 text-right text-xs tabular-nums text-txt2">
                    {r.isDir ? '' : fmtBytes(r.size)}
                  </span>
                  <span className="w-[100px] shrink-0 text-right text-xs text-txt2">{fmtDate(r.modified)}</span>
                </div>
              )
            })}
          </div>
          {!query ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
              <FolderOpen className="h-9 w-9 opacity-40" />
              <div className="text-sm">输入关键字,全盘文件名即时搜索</div>
              <div className="text-xs opacity-70">双击/回车打开 · 右键更多操作 · 类似 Everything 的体验</div>
            </div>
          ) : gs.index.count === 0 && !gs.index.building ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-txt2">
              <div className="text-sm">索引还没有建立</div>
              <Btn variant="primary" onClick={() => useGlobalSearch.getState().rebuild()}>
                <RefreshCw className="h-4 w-4" /> 立即构建索引
              </Btn>
            </div>
          ) : !items.length && !gs.searching ? (
            <div className="py-10 text-center text-sm text-txt2">{gs.error || '无匹配结果'}</div>
          ) : null}
        </div>

        {/* 底部状态 */}
        <div className="flex h-8 shrink-0 items-center gap-2 border-t border-brd px-3 text-[11px] text-txt2">
          <span>
            {query ? `共 ${gs.total.toLocaleString()} 项结果` + (gs.truncated ? '(已截断,可输入更精确的关键字)' : '') : '等待输入'}
          </span>
          <span className="flex-1" />
          <span>回车打开第一项 · 点击项直接打开</span>
        </div>
      </div>
    </div>
  )
}
