import { useEffect, useRef, useState } from 'react'
import {
  PanelLeft,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCw,
  Search,
  List,
  LayoutGrid,
  Eye,
  EyeOff,
  PanelRight,
  FolderPlus,
  FilePlus,
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  MousePointerClick,
  Check,
  Gauge,
} from 'lucide-react'
import { useFs } from '../stores/fs'
import { useSettings, THEMES } from '../stores/settings'
import { useUi, type MenuItem } from '../stores/ui'
import { segments } from '../utils/path'
import { getDragPayload } from './dnd'
import { IconBtn } from './ui'

export function Toolbar() {
  const s = useFs()
  const st = useSettings()
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const path = tab?.history[tab.idx] ?? ''
  const viewOpen = !!tab?.view

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-brd bg-panel px-2">
      <IconBtn title="侧边栏" active={st.sidebarVisible} onClick={() => st.toggle('sidebarVisible')}>
        <PanelLeft className="h-4.5 w-4.5" />
      </IconBtn>
      <IconBtn title="后退 (Alt+←)" disabled={!tab || tab.idx === 0} onClick={() => s.goBack()}>
        <ArrowLeft className="h-4.5 w-4.5" />
      </IconBtn>
      <IconBtn
        title="前进 (Alt+→)"
        disabled={!tab || tab.idx >= tab.history.length - 1}
        onClick={() => s.goForward()}
      >
        <ArrowRight className="h-4.5 w-4.5" />
      </IconBtn>
      <IconBtn title="上一级 (Backspace)" disabled={!path || segments(path).length <= 1} onClick={() => s.goUp()}>
        <ArrowUp className="h-4.5 w-4.5" />
      </IconBtn>
      <IconBtn title="刷新 (F5)" disabled={!path} onClick={() => void s.refresh()}>
        <RefreshCw className="h-4.5 w-4.5" />
      </IconBtn>

      {viewOpen ? (
        <div className="mx-2 flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-acc">查看器</span>
          <span className="truncate text-txt2">{tab!.view!.entry.path}</span>
        </div>
      ) : (
        <Breadcrumb path={path} />
      )}

      <SearchBox />

      <IconBtn
        title="新建文件夹"
        disabled={!path || viewOpen}
        onClick={() => s.createEntry('folder')}
      >
        <FolderPlus className="h-4.5 w-4.5" />
      </IconBtn>
      <IconBtn title="新建文件" disabled={!path || viewOpen} onClick={() => s.createEntry('file')}>
        <FilePlus className="h-4.5 w-4.5" />
      </IconBtn>
      <IconBtn
        title={st.viewMode === 'details' ? '切换到大图标' : '切换到详细列表'}
        disabled={!path}
        onClick={() => st.toggle('viewMode')}
      >
        {st.viewMode === 'details' ? <LayoutGrid className="h-4.5 w-4.5" /> : <List className="h-4.5 w-4.5" />}
      </IconBtn>
      <IconBtn title="预览面板 (空格)" active={st.previewVisible} onClick={() => st.toggle('previewVisible')}>
        <PanelRight className="h-4.5 w-4.5" />
      </IconBtn>
      <MoreMenu />
    </header>
  )
}

function SearchBox() {
  const s = useFs()
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const filter = tab?.filter ?? ''
  const [text, setText] = useState(filter)

  useEffect(() => {
    setText(filter)
  }, [filter, tab?.id])

  return (
    <div className="relative mx-2 h-8 w-56 shrink-0">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-txt2" />
      <input
        id="mx-search"
        value={text}
        placeholder="搜索当前文件夹 (Ctrl+F)"
        onChange={(e) => {
          setText(e.target.value)
          s.setFilter(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setText('')
            s.setFilter('')
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="h-8 w-full rounded-md border border-transparent bg-panel2 pl-7 pr-2 text-[13px] outline-none placeholder:text-txt2 focus:border-acc"
      />
    </div>
  )
}

function Breadcrumb({ path }: { path: string }) {
  const s = useFs()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(path)
  const inputRef = useRef<HTMLInputElement>(null)
  const segs = segments(path)
  const dragOver = useRef<HTMLDivElement>(null)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    if (editing) {
      setDraft(path)
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [editing, path])

  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft !== path) s.navigate(draft.trim())
  }

  if (!path) return <div className="min-w-0 flex-1" />

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="mx-2 h-8 min-w-0 flex-1 rounded-md border border-acc bg-panel2 px-2.5 text-[13px] outline-none"
      />
    )
  }

  return (
    <div
      className={`mx-1 flex min-w-0 flex-1 items-center overflow-x-auto rounded-md px-1 ${
        dropping ? 'ring-2 ring-acc' : ''
      }`}
      onDoubleClick={() => setEditing(true)}
      title="双击可编辑路径;拖拽文件夹到此处可移动"
      onDragOver={(e) => {
        if (getDragPayload()) {
          e.preventDefault()
          setDropping(true)
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        const payload = getDragPayload()
        if (!payload) return
        e.preventDefault()
        e.stopPropagation()
        const target = segs.length > 1 ? '/' + segs.slice(0, -1).join('/') : '/'
        if (target === '/') return
        const entries = (s.listings[s.activeId]?.entries ?? []).filter((en) => payload.includes(en.path))
        void s.moveEntries(entries, target)
      }}
    >
      {segs.map((seg, i) => {
        const target = '/' + segs.slice(0, i + 1).join('/')
        return (
          <span key={target} className="flex shrink-0 items-center">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-txt2" />}
            <button
              onClick={() => s.navigate(target)}
              onDragOver={(e) => {
                if (getDragPayload() && i > 0) e.preventDefault()
              }}
              onDrop={(e) => {
                if (i === 0) return
                e.preventDefault()
                e.stopPropagation()
                const payload = getDragPayload()
                if (!payload) return
                const entries = (s.listings[s.activeId]?.entries ?? []).filter((en) => payload.includes(en.path))
                void s.moveEntries(entries, target)
              }}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] hover:bg-hover ${
                i === segs.length - 1 ? 'font-medium text-txt' : 'text-txt2'
              }`}
            >
              {i === 0 ? <FolderOpen className="h-3.5 w-3.5" /> : null}
              {seg}
            </button>
          </span>
        )
      })}
    </div>
  )
}

function MoreMenu() {
  const st = useSettings()
  const openMenu = useUi((s) => s.openMenu)

  const themeItems: MenuItem[] = THEMES.map((t) => ({
    label: st.theme === t.id ? `✓ ${t.name}` : t.name,
    onClick: () => st.set('theme', t.id),
  }))

  return (
    <IconBtn
      title="更多选项"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        openMenu(r.left - 190, r.bottom + 4, [
          {
            label: '显示隐藏文件',
            icon: st.showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />,
            onClick: () => st.toggle('showHidden'),
          },
          {
            label: `单击打开:${st.singleClickOpen ? '开' : '关'}`,
            icon: <MousePointerClick className="h-4 w-4" />,
            onClick: () => st.toggle('singleClickOpen'),
          },
          { sep: true },
          ...themeItems,
          { sep: true },
          {
            label: '内存占用诊断',
            icon: <Gauge className="h-4 w-4" />,
            onClick: () => useUi.getState().showDialog({ type: 'memory' }),
          },
        ])
      }}
    >
      <MoreHorizontal className="h-4.5 w-4.5" />
    </IconBtn>
  )
}
