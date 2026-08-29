import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2, FolderPlus, ChevronDown, ChevronUp, ChevronRight } from 'lucide-react'
import { useFs } from '../stores/fs'
import { useSettings, type SortKey } from '../stores/settings'
import { useUi } from '../stores/ui'
import type { FileEntry } from '../fs/types'
import { processEntries } from '../utils/listing'
import { fmtBytes, fmtDate } from '../utils/format'
import { describeType, categoryOf } from '../utils/categories'
import { isValidName } from '../utils/path'
import { EntryIcon } from './Icons'
import { buildEntryMenuItems, buildEmptyMenuItems } from '../stores/fs'
import { setDragPayload, getDragPayload } from './dnd'
import { useIsMobile } from '../hooks/useIsMobile'

// ---------- 触屏长按(全局单指状态) ----------
const lp = { timer: 0, fired: false, x: 0, y: 0, path: '' }
const emptyLp = { timer: 0 }

function lpClear() {
  if (lp.timer) window.clearTimeout(lp.timer)
  if (emptyLp.timer) window.clearTimeout(emptyLp.timer)
}

function lpOpenMenu(x: number, y: number, path: string) {
  const s = useFs.getState()
  const tabId = s.activeId
  const entries = s.listings[tabId]?.entries ?? []
  let sel = s.selection[tabId] ?? []
  if (!sel.includes(path)) {
    useFs.setState({ selection: { ...s.selection, [tabId]: [path] } })
    sel = [path]
  }
  const selEntries = entries.filter((e) => sel.includes(e.path))
  useUi.getState().openMenu(x, y, buildEntryMenuItems(selEntries))
}

function lpStart(e: React.TouchEvent, entry: FileEntry) {
  const t = e.touches[0]
  lp.x = t.clientX
  lp.y = t.clientY
  lp.path = entry.path
  lp.fired = false
  lpClear()
  lp.timer = window.setTimeout(() => {
    lp.fired = true
    lpOpenMenu(lp.x, lp.y, entry.path)
  }, 480)
}

function lpMove(e: React.TouchEvent) {
  const t = e.touches[0]
  if (Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 12) {
    if (lp.timer) window.clearTimeout(lp.timer)
  }
}

function lpConsume(path: string): boolean {
  if (lp.fired && lp.path === path) {
    lp.fired = false
    return true
  }
  return false
}

export function FileList() {
  const s = useFs()
  const st = useSettings()
  const isMobile = useIsMobile()
  const openMenu = useUi((s2) => s2.openMenu)
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const listing = tab ? s.listings[tab.id] : undefined

  const entries = useMemo(
    () =>
      processEntries(listing?.entries ?? [], {
        showHidden: st.showHidden,
        filter: tab?.filter ?? '',
        sortKey: st.sortKey,
        sortAsc: st.sortAsc,
        foldersFirst: st.foldersFirst,
      }),
    [listing?.entries, st.showHidden, st.sortKey, st.sortAsc, st.foldersFirst, tab?.filter]
  )

  const sel = (tab && s.selection[tab.id]) || []
  const selSet = useMemo(() => new Set(sel), [sel])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [containerW, setContainerW] = useState(800)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth))
    ro.observe(el)
    setContainerW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  function rowProps(entry: FileEntry, index: number) {
    return {
      entry,
      selected: selSet.has(entry.path),
      index,
      onClick: (e: React.MouseEvent) => {
        if (lpConsume(entry.path)) return
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          s.clickSelect(entry, index, entries, e)
          return
        }
        // 手机上:文件夹单击直接进入
        if (isMobile && entry.kind === 'directory') {
          s.openEntry(entry)
          return
        }
        if (entry.kind === 'file' && st.singleClickOpen) {
          s.clickSelect(entry, index, entries, e)
          s.openEntry(entry)
        } else {
          s.clickSelect(entry, index, entries, e)
        }
      },
      onTouchStart: (e: React.TouchEvent) => {
        e.stopPropagation()
        lpStart(e, entry)
      },
      onTouchMove: lpMove,
      onTouchEnd: lpClear,
      onDoubleClick: () => {
        if (entry.kind === 'directory') s.openEntry(entry)
        else if (!st.singleClickOpen) s.openEntry(entry)
      },
      onContext: (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        let itemSel = sel
        if (!sel.includes(entry.path)) {
          s.clickSelect(entry, index, entries, { ctrlKey: false, shiftKey: false, metaKey: false })
          itemSel = [entry.path]
        }
        const selEntries = entries.filter((en) => itemSel.includes(en.path))
        openMenu(e.clientX, e.clientY, buildEntryMenuItems(selEntries))
      },
      onDragStartRow: (e: React.DragEvent) => {
        const paths = sel.includes(entry.path) ? sel : [entry.path]
        setDragPayload(paths)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', entry.name)
      },
      onDragEndRow: () => setDragPayload(null),
      canDropOn: () => {
        const payload = getDragPayload()
        if (!payload || entry.kind !== 'directory') return false
        if (payload.includes(entry.path)) return false
        if (payload.some((p) => entry.path.startsWith(p + '/'))) return false
        return true
      },
      onDropRow: (e: React.DragEvent) => {
        const payload = getDragPayload()
        setDragPayload(null)
        if (!payload || entry.kind !== 'directory') return
        e.preventDefault()
        e.stopPropagation()
        setDropping(false)
        const dragEntries = (listing?.entries ?? []).filter((en) => payload.includes(en.path))
        if (dragEntries.length) void s.moveEntries(dragEntries, entry.path)
      },
    }
  }

  const containerHandlers = {
    onClick: () => s.clearSelection(),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      openMenu(e.clientX, e.clientY, buildEmptyMenuItems())
    },
    onTouchStart: (e: React.TouchEvent) => {
      if ((e.target as HTMLElement).closest('[draggable]')) return
      const t = e.touches[0]
      const x = t.clientX
      const y = t.clientY
      emptyLp.timer = window.setTimeout(() => {
        useUi.getState().openMenu(x, y, buildEmptyMenuItems())
      }, 480)
    },
    onTouchMove: lpClear,
    onTouchEnd: lpClear,
    onDragOver: (e: React.DragEvent) => {
      if (getDragPayload()) e.preventDefault()
      setDropping(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.target === scrollRef.current) setDropping(false)
    },
    onDrop: async (e: React.DragEvent) => {
      const payload = getDragPayload()
      if (payload) {
        setDragPayload(null)
        setDropping(false)
        return
      }
      if (!tab || !s.provider) return
      e.preventDefault()
      setDropping(false)
      await importExternal(e.dataTransfer, tab.history[tab.idx])
    },
  }

  async function importExternal(dt: DataTransfer, destDir: string) {
    try {
      const items = Array.from(dt.items)
      const first = items[0] as
        | (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
        | undefined
      if (first?.getAsFileSystemHandle) {
        const h = await first.getAsFileSystemHandle()
        if (h && h.kind === 'directory') {
          await s.addRootFromHandle(h as FileSystemDirectoryHandle)
          return
        }
      }
      const files = Array.from(dt.files)
      if (files.length && s.provider) {
        let n = 0
        for (const f of files) {
          const dest = joinPathOf(destDir, f.name)
          if (await s.provider.exists(dest)) continue
          await s.provider.writeBlob(dest, f)
          n++
        }
        if (n) useUi.getState().toast(`已导入 ${n} 个文件`, 'success')
        else useUi.getState().toast('文件已存在,未导入', 'info')
        await s.refresh()
      }
    } catch {
      useUi.getState().toast('导入失败', 'error')
    }
  }

  if (!tab) return null

  if (listing?.loading && !listing.entries.length) {
    return (
      <div className="flex flex-1 items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
      </div>
    )
  }

  const droppingCls = dropping ? 'bg-sel/10 ring-2 ring-inset ring-acc' : ''

  if (!entries.length) {
    return (
      <div
        className={`flex flex-1 flex-col items-center justify-center gap-3 text-txt2 ${droppingCls}`}
        {...containerHandlers}
      >
        {tab.filter ? (
          <div className="text-center">
            <div className="text-sm">没有匹配「{tab.filter}」的项目</div>
            <button className="mt-2 text-acc hover:underline" onClick={() => s.setFilter('')}>
              清除搜索
            </button>
          </div>
        ) : (
          <>
            <FolderPlus className="h-12 w-12 opacity-40" />
            <div className="text-sm">此文件夹为空</div>
            <div className="flex gap-3 text-xs">
              <button className="text-acc hover:underline" onClick={() => s.createEntry('folder')}>
                新建文件夹
              </button>
              <button className="text-acc hover:underline" onClick={() => s.createEntry('file')}>
                新建文件
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return st.viewMode === 'details' ? (
    <DetailsView
      entries={entries}
      rowProps={rowProps}
      scrollRef={scrollRef}
      containerCls={droppingCls}
      containerHandlers={containerHandlers}
      renamingPath={s.renamingPath}
      commitRename={(name) => void s.commitRename(name)}
      cancelRename={() => s.startRename(null)}
    />
  ) : (
    <GridView
      entries={entries}
      rowProps={rowProps}
      scrollRef={scrollRef}
      containerW={containerW}
      containerCls={droppingCls}
      containerHandlers={containerHandlers}
      renamingPath={s.renamingPath}
      commitRename={(name) => void s.commitRename(name)}
      cancelRename={() => s.startRename(null)}
    />
  )
}

function joinPathOf(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

// ---------- 缩略图缓存(LRU) ----------
const thumbCache = new Map<string, string>()
const THUMB_CAP = 500

/** 内存诊断用 */
export function thumbCacheStats() {
  return { count: thumbCache.size, cap: THUMB_CAP }
}

function cacheThumb(key: string, url: string) {
  if (thumbCache.has(key)) return
  if (thumbCache.size >= THUMB_CAP) {
    const oldest = thumbCache.keys().next().value
    if (oldest) {
      const u = thumbCache.get(oldest)
      if (u) URL.revokeObjectURL(u)
      thumbCache.delete(oldest)
    }
  }
  thumbCache.set(key, url)
}

function useThumb(entry: FileEntry): string | null {
  const [url, setUrl] = useState<string | null>(() => {
    const key = `${entry.path}:${entry.size}:${entry.modified ?? 0}`
    return thumbCache.get(key) ?? null
  })
  useEffect(() => {
    const key = `${entry.path}:${entry.size}:${entry.modified ?? 0}`
    if (entry.kind !== 'file' || categoryOf(entry) !== 'image') return
    const cached = thumbCache.get(key)
    if (cached) {
      setUrl(cached)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        const u = URL.createObjectURL(f)
        cacheThumb(key, u)
        if (alive) setUrl(u)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      alive = false
    }
  }, [entry.path, entry.size, entry.modified, entry.kind])
  return url
}

// ---------- 行属性类型 ----------
interface RowData {
  entry: FileEntry
  selected: boolean
  index: number
  onClick(e: React.MouseEvent): void
  onTouchStart(e: React.TouchEvent): void
  onTouchMove(e: React.TouchEvent): void
  onTouchEnd(): void
  onDoubleClick(): void
  onContext(e: React.MouseEvent): void
  onDragStartRow(e: React.DragEvent): void
  onDragEndRow(): void
  canDropOn(): boolean
  onDropRow(e: React.DragEvent): void
}

interface ViewProps {
  entries: FileEntry[]
  rowProps(entry: FileEntry, index: number): RowData
  scrollRef: React.RefObject<HTMLDivElement | null>
  containerCls: string
  containerHandlers: React.HTMLAttributes<HTMLDivElement>
  renamingPath: string | null
  commitRename(name: string): void
  cancelRename(): void
}

// ---------- 详细列表 ----------
function DetailsView({ entries, rowProps, scrollRef, containerCls, containerHandlers, renamingPath, commitRename, cancelRename }: ViewProps) {
  const st = useSettings()
  const isMobile = useIsMobile()
  const ROW_H = isMobile ? 58 : 30
  const [droppingPath, setDroppingPath] = useState<string | null>(null)
  const virt = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 14,
  })

  const sortBtn = (key: SortKey, label: string, width?: number) => (
    <button
      onClick={(e) => {
        e.stopPropagation()
        if (st.sortKey === key) st.set('sortAsc', !st.sortAsc)
        else {
          st.set('sortKey', key)
          st.set('sortAsc', true)
        }
      }}
      className={`flex h-full items-center gap-0.5 border-l border-brd px-2.5 text-left text-xs text-txt2 hover:bg-hover ${
        width ? '' : 'flex-1'
      }`}
      style={width ? { width } : undefined}
    >
      <span className="truncate">{label}</span>
      {st.sortKey === key && (st.sortAsc ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
    </button>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 select-none items-center border-b border-brd bg-panel pl-2">
        {sortBtn('name', '名称')}
        {!isMobile && (
          <>
            {sortBtn('size', '大小', 120)}
            {sortBtn('type', '类型', 120)}
            {sortBtn('modified', '修改日期', 130)}
          </>
        )}
      </div>
      <div
        ref={scrollRef}
        className={`min-h-0 flex-1 overflow-auto ${containerCls}`}
        {...containerHandlers}
      >
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const entry = entries[vi.index]
            const rp = rowProps(entry, vi.index)
            const renaming = renamingPath === entry.path
            const dropping = droppingPath === entry.path
            if (isMobile) {
              return (
                <div
                  key={entry.path}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_H, transform: `translateY(${vi.start}px)` }}
                  draggable={false}
                  onClick={(e) => {
                    e.stopPropagation()
                    rp.onClick(e)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    rp.onDoubleClick()
                  }}
                  onContextMenu={rp.onContext}
                  onTouchStart={rp.onTouchStart}
                  onTouchMove={rp.onTouchMove}
                  onTouchEnd={rp.onTouchEnd}
                  onDrop={rp.onDropRow}
                  className={`flex cursor-default items-center gap-3 px-3 ${
                    rp.selected ? 'bg-sel' : 'active:bg-hover'
                  }`}
                  title={entry.name}
                >
                  <EntryIcon category={categoryOf(entry)} className="h-6 w-6" />
                  <span className="min-w-0 flex-1">
                    {renaming ? (
                      <RenameInput initial={entry.name} onCommit={commitRename} onCancel={cancelRename} />
                    ) : (
                      <span className="block truncate text-[15px] leading-5">{entry.name}</span>
                    )}
                    <span className="block truncate text-xs leading-4 text-txt2">
                      {describeType(entry)} · {entry.kind === 'file' ? fmtBytes(entry.size) : fmtDate(entry.modified)}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-txt2" />
                </div>
              )
            }
            return (
              <div
                key={entry.path}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_H, transform: `translateY(${vi.start}px)` }}
                draggable={!renaming}
                onClick={(e) => {
                  e.stopPropagation()
                  rp.onClick(e)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  rp.onDoubleClick()
                }}
                onContextMenu={rp.onContext}
                onTouchStart={rp.onTouchStart}
                onTouchMove={rp.onTouchMove}
                onTouchEnd={rp.onTouchEnd}
                onDragStart={rp.onDragStartRow}
                onDragEnd={rp.onDragEndRow}
                onDragOver={(e) => {
                  if (rp.canDropOn()) {
                    e.preventDefault()
                    e.stopPropagation()
                    e.dataTransfer.dropEffect = 'move'
                    setDroppingPath(entry.path)
                  }
                }}
                onDragLeave={() => setDroppingPath((p) => (p === entry.path ? null : p))}
                onDrop={rp.onDropRow}
                className={`flex h-[30px] cursor-default items-center pr-2 text-[13px] ${
                  rp.selected ? 'bg-sel' : 'hover:bg-hover'
                } ${dropping ? 'ring-1 ring-inset ring-acc bg-sel/50' : ''}`}
                title={entry.name}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2 pl-2.5">
                  <EntryIcon category={categoryOf(entry)} />
                  {renaming ? (
                    <RenameInput initial={entry.name} onCommit={commitRename} onCancel={cancelRename} />
                  ) : (
                    <span className="truncate">{entry.name}</span>
                  )}
                </span>
                <span className="w-[120px] shrink-0 px-2.5 text-txt2">{entry.kind === 'file' ? fmtBytes(entry.size) : '—'}</span>
                <span className="w-[120px] shrink-0 px-2.5 text-txt2">{describeType(entry)}</span>
                <span className="w-[130px] shrink-0 px-2.5 text-txt2">{fmtDate(entry.modified)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------- 大图标 ----------
const TILE_W = 112
const TILE_H = 136

function GridView(props: ViewProps & { containerW: number }) {
  const { entries, rowProps, scrollRef, containerCls, containerHandlers, renamingPath, commitRename, cancelRename } = props
  // 在挂载后测量自身宽度(父级的 observer 拿不到延迟挂载的滚动容器)
  const [width, setWidth] = useState(props.containerW)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [scrollRef])
  const cols = Math.max(1, Math.floor((width - 12) / (TILE_W + 4)))
  const rows = Math.ceil(entries.length / cols)
  const [dropTile, setDropTile] = useState<string | null>(null)

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_H,
    overscan: 4,
  })

  return (
    <div ref={scrollRef} className={`min-h-0 flex-1 overflow-auto ${containerCls}`} {...containerHandlers}>
      <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
        {virt.getVirtualItems().map((vi) => (
          <div
            key={vi.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: TILE_H,
              transform: `translateY(${vi.start}px)`,
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, ${TILE_W + 4}px)`,
              justifyItems: 'center',
              alignContent: 'start',
            }}
          >
            {entries.slice(vi.index * cols, vi.index * cols + cols).map((entry, i) => {
              const idx = vi.index * cols + i
              const rp = rowProps(entry, idx)
              const renaming = renamingPath === entry.path
              return (
                <Tile
                  key={entry.path}
                  rp={rp}
                  entry={entry}
                  selected={rp.selected}
                  renaming={renaming}
                  commitRename={commitRename}
                  cancelRename={cancelRename}
                  dropping={dropTile === entry.path}
                  setDropping={setDropTile}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function Tile({
  rp,
  entry,
  selected,
  renaming,
  commitRename,
  cancelRename,
  dropping,
  setDropping,
}: {
  rp: RowData
  entry: FileEntry
  selected: boolean
  renaming: boolean
  commitRename(name: string): void
  cancelRename(): void
  dropping: boolean
  setDropping: React.Dispatch<React.SetStateAction<string | null>>
}) {
  const thumb = useThumb(entry)
  const isImage = categoryOf(entry) === 'image'
  return (
    <div
      draggable={!renaming}
      onClick={(e) => {
        e.stopPropagation()
        rp.onClick(e)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        rp.onDoubleClick()
      }}
      onContextMenu={rp.onContext}
      onTouchStart={rp.onTouchStart}
      onTouchMove={rp.onTouchMove}
      onTouchEnd={rp.onTouchEnd}
      onDragStart={rp.onDragStartRow}
      onDragEnd={rp.onDragEndRow}
      onDragOver={(e) => {
        if (rp.canDropOn()) {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setDropping(entry.path)
        }
      }}
      onDragLeave={() => setDropping((p) => (p === entry.path ? null : p))}
      onDrop={rp.onDropRow}
      title={entry.name}
      className={`flex cursor-default flex-col items-center gap-1 rounded-lg p-2 text-center ${
        selected ? 'bg-sel' : 'hover:bg-hover'
      } ${dropping ? 'ring-2 ring-acc bg-sel/50' : ''}`}
      style={{ width: TILE_W, height: TILE_H - 12 }}
    >
      <div className="checker flex h-[68px] w-full items-center justify-center overflow-hidden rounded-md">
        {isImage && thumb ? (
          <img src={thumb} alt="" className="max-h-[68px] max-w-full object-contain" draggable={false} />
        ) : (
          <EntryIcon category={categoryOf(entry)} className="h-11 w-11" />
        )}
      </div>
      {renaming ? (
        <div className="w-full">
          <RenameInput initial={entry.name} onCommit={commitRename} onCancel={cancelRename} />
        </div>
      ) : (
        <span className="w-full truncate text-xs leading-4">{entry.name}</span>
      )}
    </div>
  )
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    const dot = initial.lastIndexOf('.')
    ref.current?.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <input
      ref={ref}
      value={value}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (isValidName(value) && value !== initial ? onCommit(value) : onCancel())}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && isValidName(value)) onCommit(value)
        if (e.key === 'Escape') onCancel()
      }}
      className="h-6 w-full rounded border border-acc bg-panel px-1 text-[13px] outline-none"
    />
  )
}
