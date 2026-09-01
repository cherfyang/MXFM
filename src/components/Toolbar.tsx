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
  X,
  Home,
  Loader2,
  FolderSearch,
  Folder,
  File,
} from 'lucide-react'
import { useFs } from '../stores/fs'
import { useSearch, type SearchResultItem } from '../stores/search'
import { useSettings, THEMES } from '../stores/settings'
import { useUi, type MenuItem } from '../stores/ui'
import { segments } from '../utils/path'
import { fmtBytes } from '../utils/format'
import { useIsMobile } from '../hooks/useIsMobile'
import { HOME_PATH } from '../stores/scan'
import { getDragPayload } from './dnd'
import { IconBtn } from './ui'

export function Toolbar() {
  const s = useFs()
  const st = useSettings()
  const isMobile = useIsMobile()
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const path = tab?.history[tab.idx] ?? ''
  const viewOpen = !!tab?.view
  const [searchOpen, setSearchOpen] = useState(false)

  return (
    <header className="shrink-0 border-b border-brd bg-panel">
      <div className="flex h-12 items-center gap-1 px-2 md:h-11">
        <IconBtn title="侧边栏" active={st.sidebarVisible} onClick={() => st.toggle('sidebarVisible')}>
          <PanelLeft className="h-5 w-5 md:h-4.5 md:w-4.5" />
        </IconBtn>
        <IconBtn title="后退 (Alt+←)" disabled={!tab || tab.idx === 0} onClick={() => s.goBack()}>
          <ArrowLeft className="h-5 w-5 md:h-4.5 md:w-4.5" />
        </IconBtn>
        {!isMobile && (
          <>
            <IconBtn
              title="前进 (Alt+→)"
              disabled={!tab || tab.idx >= tab.history.length - 1}
              onClick={() => s.goForward()}
            >
              <ArrowRight className="h-4.5 w-4.5" />
            </IconBtn>
            <IconBtn title="上一级 (Backspace)" disabled={!path || path === HOME_PATH || segments(path).length <= 1} onClick={() => s.goUp()}>
              <ArrowUp className="h-4.5 w-4.5" />
            </IconBtn>
            <IconBtn title="刷新 (F5)" disabled={!path} onClick={() => void s.refresh()}>
              <RefreshCw className="h-4.5 w-4.5" />
            </IconBtn>
          </>
        )}

        {viewOpen ? (
          <div className="mx-2 flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span className="rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-acc">查看器</span>
            <span className="truncate text-txt2">{tab!.view!.entry.path}</span>
          </div>
        ) : (
          <Breadcrumb path={path} />
        )}

        {isMobile ? (
          <IconBtn title="搜索" active={searchOpen} onClick={() => setSearchOpen((v) => !v)}>
            {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
          </IconBtn>
        ) : (
          <SearchBox />
        )}

        {!isMobile && (
          <>
            <IconBtn title="新建文件夹" disabled={!path || viewOpen} onClick={() => s.createEntry('folder')}>
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
          </>
        )}
        <MoreMenu />
      </div>
      {isMobile && searchOpen && <SearchBox mobile />}
    </header>
  )
}

function SearchBox({ mobile }: { mobile?: boolean }) {
  const s = useFs()
  const search = useSearch()
  const tab = s.tabs.find((t) => t.id === s.activeId)
  const filter = tab?.filter ?? ''
  const [text, setText] = useState(filter)
  const [recursive, setRecursive] = useState(false)
  const [dropOpen, setDropOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)
  // effect 内读取最新模式:递归模式下外部 filter 变化(如 navigate 重置)不回写输入框
  const recRef = useRef(recursive)
  recRef.current = recursive
  const isNative = s.provider?.kind === 'native'

  useEffect(() => {
    if (!recRef.current) setText(filter)
  }, [filter, tab?.id])

  // 卸载时终止在途搜索(不动递归开关,开关为组件内瞬时态)
  useEffect(() => {
    return () => {
      window.clearTimeout(timer.current)
      useSearch.getState().cancel()
      useSearch.getState().clear()
    }
  }, [])

  const closeDrop = () => {
    window.clearTimeout(timer.current)
    useSearch.getState().cancel()
    useSearch.getState().clear()
    setDropOpen(false)
  }

  // 点击外部关闭下拉
  useEffect(() => {
    if (!dropOpen) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) closeDrop()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [dropOpen])

  // debounce 400ms 后启动递归搜索;目录在触发时读取最新 tab 状态
  const scheduleSearch = (q: string) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const st = useFs.getState()
      const t = st.tabs.find((x) => x.id === st.activeId)
      useSearch.getState().start(t?.history[t.idx] ?? '', q)
    }, 400)
  }

  const onChange = (v: string) => {
    setText(v)
    if (!recursive) {
      s.setFilter(v)
      return
    }
    // 递归模式:输入只驱动搜索,不同步 tab.filter
    useSearch.getState().cancel()
    window.clearTimeout(timer.current)
    const q = v.trim()
    if (q.length >= 2) {
      scheduleSearch(q)
      setDropOpen(true)
    } else {
      useSearch.getState().clear()
      setDropOpen(false)
    }
  }

  const toggleRecursive = () => {
    const next = !recursive
    setRecursive(next)
    window.clearTimeout(timer.current)
    useSearch.getState().cancel()
    useSearch.getState().clear()
    setDropOpen(false)
    const q = text.trim()
    if (next) {
      // 进入递归:清掉遗留的当前目录过滤,输入仅驱动搜索
      s.setFilter('')
      if (q.length >= 2) {
        scheduleSearch(q)
        setDropOpen(true)
      }
    } else {
      // 退出递归:恢复 filter 绑定,把当前输入同步回 tab.filter(保持所见即所滤)
      s.setFilter(text)
    }
  }

  const pick = (item: SearchResultItem) => {
    const st = useFs.getState()
    const tabId = st.activeId
    st.navigate(item.dir)
    // 下轮渲染后写入选中,避免被 navigate 的 selection 重置覆盖
    setTimeout(() => {
      useFs.setState({ selection: { ...useFs.getState().selection, [tabId]: [item.path] } })
    }, 0)
    closeDrop()
    inputRef.current?.blur()
  }

  const input = (
    <input
      ref={inputRef}
      id={mobile ? undefined : 'mx-search'}
      value={text}
      placeholder={recursive ? '搜索当前文件夹及子目录' : '搜索当前文件夹'}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (dropOpen && !containerRef.current?.contains(document.activeElement)) closeDrop()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (recursive) {
            setText('')
            closeDrop()
          } else {
            setText('')
            s.setFilter('')
          }
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className={`h-10 w-full rounded-md border border-transparent bg-panel2 pl-8 ${
        isNative ? 'pr-8' : 'pr-2'
      } text-[15px] outline-none placeholder:text-txt2 focus:border-acc md:h-8 md:text-[13px]`}
    />
  )

  const recBtn = isNative ? (
    <button
      onClick={toggleRecursive}
      title="在子目录中搜索(仅桌面版)"
      className={`absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded ${
        recursive ? 'bg-acc text-white' : 'text-txt2 hover:bg-hover'
      }`}
    >
      <FolderSearch className="h-3.5 w-3.5" />
    </button>
  ) : null

  const results = search.results.slice(0, 50)

  const renderResult = (r: SearchResultItem) => (
    <>
      {r.isDir ? (
        <Folder className="h-4 w-4 shrink-0 text-acc" />
      ) : (
        <File className="h-4 w-4 shrink-0 text-txt2" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{r.name}</span>
        <span className="block truncate text-[11px] text-txt2" title={r.path}>
          {r.path}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-txt2">{fmtBytes(r.size)}</span>
    </>
  )

  const drop =
    recursive && dropOpen ? (
      <div className="absolute right-0 top-full z-50 mt-1 w-[min(440px,calc(100vw-16px))] overflow-hidden rounded-md border border-brd bg-panel shadow-xl shadow-black/30">
        <div className="max-h-[280px] overflow-y-auto py-1">
          {search.running && !results.length ? (
            <div className="flex items-center justify-center gap-2 py-5 text-[13px] text-txt2">
              <Loader2 className="h-4 w-4 animate-spin" /> 搜索中…
            </div>
          ) : results.length ? (
            results.map((r) =>
              r.external ? (
                <div
                  key={r.path}
                  title="不在已授权的目录内"
                  className="flex w-full cursor-not-allowed items-center gap-2 px-2.5 py-1.5 opacity-40"
                >
                  {renderResult(r)}
                </div>
              ) : (
                <button
                  key={r.path}
                  onClick={() => pick(r)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover"
                >
                  {renderResult(r)}
                </button>
              ),
            )
          ) : search.error ? null : (
            <div className="px-2.5 py-5 text-center text-[13px] text-txt2">无匹配结果</div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-brd px-2.5 py-1.5 text-[11px] text-txt2">
          {search.running && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-acc" />}
          <span className="shrink-0">共 {search.total} 项结果</span>
          {search.truncated && <span className="shrink-0 text-amber-500">结果过多已截断</span>}
          {search.error && <span className="min-w-0 flex-1 truncate text-danger">{search.error}</span>}
          {search.running && (
            <button
              onClick={() => useSearch.getState().cancel()}
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-hover"
              title="停止搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    ) : null

  if (mobile) {
    return (
      <div ref={containerRef} className="relative flex h-11 items-center border-t border-brd px-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-txt2" />
        {input}
        {recBtn}
        {drop}
      </div>
    )
  }
  return (
    <div ref={containerRef} className="relative mx-2 h-8 w-56 shrink-0">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-txt2" />
      {input}
      {recBtn}
      {drop}
    </div>
  )
}

function Breadcrumb({ path }: { path: string }) {
  const s = useFs()
  const isMobile = useIsMobile()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(path)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)
  const segs = segments(path)
  const isHome = path === HOME_PATH

  useEffect(() => {
    if (editing) {
      setDraft(path)
      requestAnimationFrame(() => inputRef.current?.select())
    }
  }, [editing, path])

  // 全局快捷键 Ctrl/Cmd+L(macOS 另有 ⌘⇧G)进入路径编辑
  useEffect(() => {
    const onEditPath = () => {
      if (!isHome && !isMobile) setEditing(true)
    }
    window.addEventListener('mx-edit-path', onEditPath)
    return () => window.removeEventListener('mx-edit-path', onEditPath)
  }, [isHome, isMobile])

  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft !== path) s.navigate(draft.trim())
  }

  if (!path) return <div className="min-w-0 flex-1" />

  if (isHome) {
    return (
      <div className="mx-1 flex min-w-0 flex-1 items-center gap-1.5 px-1.5">
        <Home className="h-4 w-4 text-acc" />
        <span className="text-[13px] font-medium">主页 · 本机文件总览</span>
      </div>
    )
  }

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
        className="mx-2 h-9 min-w-0 flex-1 rounded-md border border-acc bg-panel2 px-2.5 text-[14px] outline-none md:h-8 md:text-[13px]"
      />
    )
  }

  return (
    <div
      className={`mx-1 flex min-w-0 flex-1 items-center overflow-x-auto rounded-md px-1 ${
        dropping ? 'ring-2 ring-acc' : ''
      }`}
      onDoubleClick={() => !isMobile && setEditing(true)}
      title={isMobile ? undefined : '双击可编辑路径;拖拽文件夹到此处可移动'}
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
            {i > 0 && <ChevronRight className="h-4 w-4 text-txt2 md:h-3.5 md:w-3.5" />}
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
              className={`flex items-center gap-1 rounded px-1.5 py-1 text-[15px] hover:bg-hover md:py-0.5 md:text-[13px] ${
                i === segs.length - 1 ? 'font-medium text-txt' : 'text-txt2'
              }`}
            >
              {i === 0 ? <FolderOpen className="h-4 w-4" /> : null}
              {seg}
            </button>
          </span>
        )
      })}
    </div>
  )
}

function MoreMenu() {
  return (
    <IconBtn
      title="更多选项 (Ctrl/Cmd+,)"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        openMoreMenu(r.left - 190, r.bottom + 4)
      }}
    >
      <MoreHorizontal className="h-5 w-5 md:h-4.5 md:w-4.5" />
    </IconBtn>
  )
}

/** 打开「更多选项」菜单;供工具栏按钮与全局快捷键(Ctrl/Cmd+,)共用 */
export function openMoreMenu(x?: number, y?: number) {
  const st = useSettings.getState()
  const s = useFs.getState()
  const openMenu = useUi.getState().openMenu
  const isMobile = window.innerWidth < 768

  const themeItems: MenuItem[] = THEMES.map((t) => ({
    label: st.theme === t.id ? `✓ ${t.name}` : t.name,
    onClick: () => useSettings.getState().set('theme', t.id),
  }))

  const mobileItems: MenuItem[] = isMobile
    ? [
        { sep: true },
        { label: st.viewMode === 'details' ? '切换到大图标' : '切换到详细列表', onClick: () => st.toggle('viewMode') },
        { label: '刷新', onClick: () => void s.refresh() },
        { label: '新建文件夹', onClick: () => s.createEntry('folder') },
        { label: '新建文本文档', onClick: () => s.createEntry('file') },
      ]
    : []

  openMenu(x ?? window.innerWidth - 210, y ?? 52, [
    {
      label: '显示隐藏文件',
      icon: st.showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />,
      onClick: () => useSettings.getState().toggle('showHidden'),
    },
    {
      label: `单击打开:${st.singleClickOpen ? '开' : '关'}`,
      icon: <MousePointerClick className="h-4 w-4" />,
      onClick: () => useSettings.getState().toggle('singleClickOpen'),
    },
    { sep: true },
    ...themeItems,
    ...mobileItems,
    { sep: true },
    {
      label: '键盘快捷键',
      icon: <Check className="h-4 w-4" />,
      onClick: () => useUi.getState().showDialog({ type: 'shortcuts' }),
    },
    {
      label: '内存占用诊断',
      icon: <Gauge className="h-4 w-4" />,
      onClick: () => useUi.getState().showDialog({ type: 'memory' }),
    },
  ])
}
