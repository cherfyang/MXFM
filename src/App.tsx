import { useEffect } from 'react'
import { FolderPlus, MonitorPlay, FolderOpen } from 'lucide-react'
import { useFs } from './stores/fs'
import { useSettings } from './stores/settings'
import { useUi } from './stores/ui'
import { Toolbar, openMoreMenu } from './components/Toolbar'
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
import { HomePage } from './components/HomePage'
import { HOME_PATH } from './stores/scan'

const IS_MAC = /Mac/i.test(navigator.platform)

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

  // 窗口标题跟随当前目录(桌面版)
  useEffect(() => {
    const cur = s.tabs.find((t) => t.id === s.activeId)
    const path = cur?.history[cur.idx]
    const name = path === HOME_PATH ? '主页' : path ? path.split('/').filter(Boolean).pop() : ''
    document.title = name ? `${decodeURIComponent(name)} - MX 文件管理器` : 'MX 文件管理器'
  }, [s.activeId, s.tabs])

  // 应用菜单动作(桌面版)
  useEffect(() => {
    const api = (window as unknown as { mxAPI?: { onMenuAction(cb: (action: string) => void): () => void } }).mxAPI
    if (!api?.onMenuAction) return
    const off = api.onMenuAction((action) => {
      const s2 = useFs.getState()
      if (action === 'newFolder') s2.createEntry('folder')
      else if (action === 'newFile') s2.createEntry('file')
      else if (action === 'refresh') void s2.refresh()
      else if (action === 'closeTab') {
        if (s2.activeId) s2.closeTab(s2.activeId)
      } else if (action === 'nextTab') s2.nextTab(1)
      else if (action === 'prevTab') s2.nextTab(-1)
    })
    return off
  }, [])

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

  // 浏览器版:拦截窗口级拖放,防止文件被拖到列表外区域时被浏览器直接打开
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      // FileList 自身已处理放置;这里只兜底拦截其它区域的浏览器默认行为(打开文件/导航)
      if (isFileDrag(e)) {
        e.preventDefault()
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
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
        // 全屏(视频 F 键)时 Esc 只退出全屏,不关查看器
        if (document.fullscreenElement) {
          void document.exitFullscreen()
          return
        }
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
        if (e.altKey && e.code === 'KeyT') {
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
      // 重做:Ctrl/Cmd+Shift+Z,Windows 另支持 Ctrl+Y(编辑态由 CodeMirror 自行处理)
      if (((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'y')) && !tab.view) {
        e.preventDefault()
        void s.redo()
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        openMoreMenu()
        return
      }
      if (mod && e.key.toLowerCase() === 'd' && !tab.view) {
        e.preventDefault()
        void s.duplicateSelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'o' && !tab.view && single) {
        e.preventDefault()
        const p = s.provider as unknown as { openInSystem?(path: string): Promise<void> } | null
        if (p?.openInSystem) p.openInSystem(single.path).catch((er) => useUi.getState().toast(String((er as Error).message || er), 'error'))
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'r' && !tab.view && single) {
        e.preventDefault()
        const p = s.provider as unknown as { reveal?(path: string): Promise<void> } | null
        if (p?.reveal) p.reveal(single.path).catch((er) => useUi.getState().toast(String((er as Error).message || er), 'error'))
        return
      }
      if (e.key === '?' && !mod && !e.altKey) {
        e.preventDefault()
        ui.showDialog({ type: 'shortcuts' })
        return
      }
      if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('mx-edit-path'))
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'g' && !editable) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('mx-edit-path'))
        return
      }
      // Alt+Home / ⌘⇧H 回主页
      if ((e.altKey && e.key === 'Home') || (mod && e.shiftKey && e.key.toLowerCase() === 'h')) {
        e.preventDefault()
        s.openHome()
        return
      }
      // Ctrl/Cmd+W 关闭标签页;菜单加速器拦截时会走 menu-action,这里兜底(浏览器版无菜单)
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (s.activeId) s.closeTab(s.activeId)
        return
      }
      // Ctrl+Tab / Ctrl+Shift+Tab 与 ⌘⇧] / ⌘⇧[ 切换标签页(桌面端菜单加速器优先,此处兜底浏览器版)
      if ((e.ctrlKey && e.key === 'Tab') || (mod && (e.key === ']' || e.key === '['))) {
        e.preventDefault()
        s.nextTab(e.shiftKey || e.key === '[' ? -1 : 1)
        return
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (e.shiftKey) {
          // Ctrl/Cmd+Shift+F 全局搜索
          ui.showDialog({ type: 'globalSearch' })
        } else {
          document.getElementById('mx-search')?.focus()
        }
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
      // README/速查表声称的快捷键:Ctrl+Shift+N 新建文件夹 / Ctrl+N 新建文本文档
      // mac 上 Cmd+N 与"新建窗口"习惯冲突,遵循速查表约定仍映射为新建
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n' && !tab.view) {
        e.preventDefault()
        s.createEntry('folder')
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'n' && !tab.view) {
        e.preventDefault()
        s.createEntry('file')
        return
      }
      // mac ⌘↑ 上一级(速查表声称)
      if (e.metaKey && !e.ctrlKey && e.key === 'ArrowUp' && !tab.view) {
        e.preventDefault()
        s.goUp()
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
      if (e.altKey && e.code === 'KeyT') {
        e.preventDefault()
        s.newTab()
        return
      }

      // 数字键:Alt+N(全平台)与 ⌘N(mac)跳转标签;Win 的 Ctrl+1/2 切换列表/大图标视图
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (digit && !tab.view) {
        if ((e.altKey || e.metaKey) && !e.ctrlKey) {
          e.preventDefault()
          s.jumpToTab(Number(digit[1]) - 1)
          return
        }
        if (e.ctrlKey && !e.metaKey && !e.altKey && (digit[1] === '1' || digit[1] === '2')) {
          e.preventDefault()
          st.set('viewMode', digit[1] === '1' ? 'details' : 'grid')
          return
        }
      }
      // Ctrl/Cmd+Shift+. 显示/隐藏文件
      if (mod && e.shiftKey && e.key === '.') {
        e.preventDefault()
        st.toggle('showHidden')
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
          if (e.shiftKey) {
            if (!tab.view && sel.length) {
              e.preventDefault()
              s.permanentDeleteSelection()
            }
            break
          }
          if (!tab.view && sel.length) s.deleteSelection()
          break
        case 'Backspace':
          if (mod && e.altKey) {
            if (!tab.view && sel.length) {
              e.preventDefault()
              s.permanentDeleteSelection()
            }
            break
          }
          // mac ⌘⌫ 彻底删除(README/速查表声称的键位;mac 无剪切冲突,不会误占 Win 的 ⌘⌥⌫)
          if (IS_MAC && e.metaKey && !e.altKey) {
            if (!tab.view && sel.length) {
              e.preventDefault()
              s.permanentDeleteSelection()
            }
            break
          }
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
          ) : tab && tab.history[tab.idx] === HOME_PATH ? (
            <HomePage />
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
