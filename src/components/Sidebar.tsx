import { FolderOpen, Plus, X, Zap, MonitorPlay, HardDrive, Home } from 'lucide-react'
import { HOME_PATH } from '../stores/scan'
import { useFs } from '../stores/fs'
import { useSettings } from '../stores/settings'
import { useIsMobile } from '../hooks/useIsMobile'
import { Btn } from './ui'

export function Sidebar() {
  const s = useFs()
  const st = useSettings()
  const isMobile = useIsMobile()
  if (!st.sidebarVisible) return null

  const activeTab = s.tabs.find((t) => t.id === s.activeId)
  const activePath = activeTab?.history[activeTab.idx]
  const activeRoot = activePath?.split('/').filter(Boolean)[0]

  const closeOnMobile = () => {
    if (isMobile) st.set('sidebarVisible', false)
  }

  const body = (
    <>
      <div className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-txt2">主页</div>
      <div className="px-2 pb-1">
        <div
          role="button"
          onClick={() => {
            const t = s.tabs.find((t) => t.history[t.idx] === HOME_PATH)
            if (t) s.setActive(t.id)
            else s.newTab(HOME_PATH)
            closeOnMobile()
          }}
          className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] md:h-8"
        >
          <Home className="h-4 w-4 shrink-0 text-acc" />
          <span className="flex-1">文件总览</span>
        </div>
      </div>
      <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-txt2">位置</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {s.roots.map((r) => (
          <div
            key={r.name}
            role="button"
            onClick={() => {
              const t = s.tabs.find((t) => t.history[t.idx] === `/${r.name}`)
              if (t) s.setActive(t.id)
              else if (activePath) s.navigate(`/${r.name}`)
              else s.newTab(`/${r.name}`)
              closeOnMobile()
            }}
            className={`group flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] md:h-8 ${
              activeRoot === r.name ? 'bg-sel text-txt' : 'text-txt hover:bg-hover'
            }`}
            title={r.kind === 'memory' ? '演示数据(内存中,刷新即恢复)' : r.name}
          >
            {r.kind === 'memory' ? (
              <MonitorPlay className="h-4 w-4 shrink-0 text-violet-400" />
            ) : (
              <HardDrive className="h-4 w-4 shrink-0 text-txt2" />
            )}
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {r.needsAuth && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void s.reauthRoot(r.name)
                }}
                className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-500 hover:bg-amber-500/25"
                title="点击重新授权"
              >
                <Zap className="h-3 w-3" /> 授权
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                void s.removeRoot(r.name)
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-60 hover:bg-panel2 md:opacity-0 md:group-hover:opacity-70"
              title="移除该位置"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {!s.roots.length && <div className="px-2 py-3 text-xs text-txt2">还没有添加任何位置</div>}
      </div>
      <div className="space-y-1.5 border-t border-brd p-2.5">
        <Btn
          className="w-full"
          onClick={() => {
            void s.addRoot()
            closeOnMobile()
          }}
        >
          <Plus className="h-4 w-4" /> 添加文件夹
        </Btn>
        {!s.roots.some((r) => r.kind === 'memory') && (
          <Btn
            className="w-full"
            onClick={() => {
              void s.addDemoRoot()
              closeOnMobile()
            }}
          >
            <MonitorPlay className="h-4 w-4" /> 演示模式
          </Btn>
        )}
        <div className="pt-1 text-center text-[11px] leading-relaxed text-txt2">
          {(s.provider as unknown as { platform?: string } | null)?.platform === 'android'
            ? '已授权"所有文件访问"后可浏览全部存储'
            : s.provider?.kind === 'native'
              ? '点击上方按钮可添加任意文件夹'
              : '从资源管理器拖入文件夹\n也可以快速添加位置'}
        </div>
      </div>
    </>
  )

  // 移动端:抽屉 + 遮罩
  if (isMobile) {
    return (
      <>
        {st.sidebarVisible && (
          <div className="fixed inset-0 z-20 bg-black/50" onClick={closeOnMobile} />
        )}
        <aside
          className={`fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-brd bg-panel pt-[env(safe-area-inset-top)] shadow-2xl transition-transform duration-200 ${
            st.sidebarVisible ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {st.sidebarVisible && (
            <button
              onClick={closeOnMobile}
              className="absolute right-2 top-3 flex h-8 w-8 items-center justify-center rounded-md text-txt2 hover:bg-hover"
              title="关闭"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          )}
          {body}
        </aside>
      </>
    )
  }

  // 桌面端:常驻侧栏
  return <aside className="flex w-52 shrink-0 flex-col border-r border-brd bg-panel">{body}</aside>
}
