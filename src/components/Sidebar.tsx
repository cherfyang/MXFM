import { FolderOpen, Plus, X, Zap, MonitorPlay, HardDrive } from 'lucide-react'
import { useFs } from '../stores/fs'
import { useSettings } from '../stores/settings'
import { Btn } from './ui'

export function Sidebar() {
  const s = useFs()
  const st = useSettings()
  if (!st.sidebarVisible) return null

  const activePath = s.tabs.find((t) => t.id === s.activeId)?.history[s.tabs.find((t) => t.id === s.activeId)!.idx]
  const activeRoot = activePath?.split('/').filter(Boolean)[0]

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-brd bg-panel">
      <div className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-txt2">位置</div>
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
            }}
            className={`group flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] ${
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
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-panel2 group-hover:opacity-70"
              title="移除该位置"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {!s.roots.length && <div className="px-2 py-3 text-xs text-txt2">还没有添加任何位置</div>}
      </div>
      <div className="space-y-1.5 border-t border-brd p-2.5">
        <Btn className="w-full" onClick={() => void s.addRoot()}>
          <Plus className="h-4 w-4" /> 添加文件夹
        </Btn>
        {!s.roots.some((r) => r.kind === 'memory') && (
          <Btn className="w-full" onClick={() => void s.addDemoRoot()}>
            <MonitorPlay className="h-4 w-4" /> 演示模式
          </Btn>
        )}
        <div className="pt-1 text-center text-[11px] leading-relaxed text-txt2">
          {s.provider?.kind === 'native'
            ? '点击上方按钮可添加任意文件夹'
            : '从资源管理器拖入文件夹\n也可以快速添加位置'}
        </div>
      </div>
    </aside>
  )
}
