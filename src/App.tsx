import { useEffect } from 'react'
import { FolderPlus, MonitorPlay, FolderOpen } from 'lucide-react'
import { useFs } from './stores/fs'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { TabsBar } from './components/TabsBar'
import { FileList } from './components/FileList'
import { StatusBar } from './components/StatusBar'
import { ContextMenu } from './components/ContextMenu'
import { Dialogs } from './components/Dialogs'
import { Toasts } from './components/Toasts'
import { PreviewPanel } from './components/PreviewPanel'
import { ViewerHost } from './viewers/registry'
import { processEntries } from './utils/listing'
import { themeMeta } from './stores/settings'

export default function App() {
  const s = useFs()
  const st = useSettings()
  const tab = s.tabs.find((t) => t.id === s.activeId)

  useEffect(() => {
    void useFs.getState().init()
    // 窄屏(手机)默认收起侧栏与预览面板
    if (window.innerWidth < 820) {
      useSettings.setState({ sidebarVisible: false, previewVisible: false })
    }
  }, [])

  useEffect(() => {
    const meta = themeMeta(st.theme)
    document.documentElement.dataset.theme = meta.id
    document.documentElement.classList.toggle('dark', meta.dark)
  }, [st.theme])

  // 有未保存修改时关闭页面前提示
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useFs.getState().tabs.some((t) => t.view?.dirty)) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const editable =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || !!t.closest('.cm-editor'))
      const s = useFs.getState()
      const st = useSettings.getState()
      const ui = useUi.getState()
      const tab = s.tabs.find((x) => x.id === s.activeId)

      if (e.key === 'Escape') {
        if (ui.menu) {
          ui.closeMenu()
          return
        }
        if (ui.dialog) return
        if (editable) return
        if (st.previewVisible && !tab?.view) {
          st.set('previewVisible', false)
          return
        }
        if (tab?.view) {
          s.requestCloseView()
          return
        }
        if (tab) s.clearSelection()
        return
      }

      if (editable) return

      const mod = e.ctrlKey || e.metaKey

      if (!tab) {
        if (e.altKey && e.key.toLowerCase() === 't') {
          e.preventDefault()
          s.newTab()
        }
        return
      }

      const listing = s.listings[tab.id]
      const ordered = listing
        ? processEntries(listing.entries, {
            showHidden: st.showHidden,
            filter: tab.filter,
            sortKey: st.sortKey,
            sortAsc: st.sortAsc,
            foldersFirst: st.foldersFirst,
          })
        : []
      const sel = s.selection[tab.id] ?? []
      const selEntries = ordered.filter((x) => sel.includes(x.path))
      const single = sel.length === 1 ? ordered.find((x) => x.path === sel[0]) : undefined

      if (mod && e.key.toLowerCase() === 's') {
        if (tab.view?.dirty) {
          e.preventDefault()
          void s.saveView()
        }
        return
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.getElementById('mx-search')?.focus()
        return
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void s.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'a' && !tab.view) {
        e.preventDefault()
        s.selectAll(ordered)
        return
      }
      if (mod && e.key.toLowerCase() === 'c' && !tab.view) {
        s.copySelection(selEntries)
        return
      }
      if (mod && e.key.toLowerCase() === 'x' && !tab.view) {
        s.cutSelection(selEntries)
        return
      }
      if (mod && e.key.toLowerCase() === 'v' && !tab.view) {
        e.preventDefault()
        void s.paste()
        return
      }
      if (e.altKey && e.key === 'ArrowLeft') {
        s.goBack()
        return
      }
      if (e.altKey && e.key === 'ArrowRight') {
        s.goForward()
        return
      }
      if (e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        s.newTab()
        return
      }

      switch (e.key) {
        case 'F5':
          e.preventDefault()
          void s.refresh()
          break
        case 'F2':
          if (single && !tab.view) s.startRename(single.path)
          break
        case 'Delete':
          if (!tab.view && sel.length) s.deleteSelection()
          break
        case 'Backspace':
          if (!tab.view) s.goUp()
          break
        case ' ':
          if (!tab.view) {
            e.preventDefault()
            st.toggle('previewVisible')
          }
          break
        case 'Enter':
          if (!tab.view && single) s.openEntry(single)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showWelcome = s.ready && s.tabs.length === 0

  return (
    <div className="flex h-full flex-col bg-app text-txt pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabsBar />
          {tab?.view ? (
            <ViewerHost entry={tab.view.entry} category={tab.view.category} />
          ) : showWelcome ? (
            <Welcome />
          ) : (
            <FileList />
          )}
        </main>
        <PreviewPanel />
      </div>
      <StatusBar />
      <ContextMenu />
      <Dialogs />
      <Toasts />
    </div>
  )
}

function Welcome() {
  const s = useFs()
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-5 rounded-2xl border border-brd bg-panel px-10 py-12 text-center shadow-sm">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-acc text-white shadow-lg">
          <FolderOpen className="h-9 w-9" />
        </div>
        <div>
          <div className="text-xl font-semibold">MX 文件管理器</div>
          <div className="mt-1.5 text-sm text-txt2">点击文件直接预览、编辑、播放 —— 无需外部程序</div>
        </div>
        <div className="flex flex-col gap-2.5">
          <button
            onClick={() => void s.addRoot()}
            className="flex h-10 items-center justify-center gap-2 rounded-lg bg-acc px-6 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            <FolderPlus className="h-4.5 w-4.5" /> 添加文件夹
          </button>
          <button
            onClick={() => void s.addDemoRoot()}
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-brd bg-panel2 px-6 text-sm text-txt transition-colors hover:bg-hover"
          >
            <MonitorPlay className="h-4.5 w-4.5" /> 先看看演示模式
          </button>
        </div>
        {!supported && (
          <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-500">
            当前浏览器不支持本地文件夹授权(File System Access API)。
            <br />
            请使用 Edge / Chrome 打开本应用,或先体验演示模式。
          </div>
        )}
        <div className="text-[11px] leading-relaxed text-txt2">
          也可以直接把文件夹拖进窗口
          <br />
          支持格式:图片 · 视频 · 音频 · PDF · Word · Excel · CSV · Markdown · 代码 · ZIP · HEX
        </div>
      </div>
    </div>
  )
}
