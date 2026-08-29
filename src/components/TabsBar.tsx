import { X, Plus } from 'lucide-react'
import { useFs } from '../stores/fs'
import { baseName } from '../utils/path'
import { EntryIcon } from './Icons'

export function TabsBar() {
  const tabs = useFs((s) => s.tabs)
  const activeId = useFs((s) => s.activeId)
  const setActive = useFs((s) => s.setActive)
  const closeTab = useFs((s) => s.closeTab)
  const newTab = useFs((s) => s.newTab)

  if (!tabs.length) return null

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-brd bg-panel px-1.5 md:h-9 md:overflow-x-hidden">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = t.id === activeId
          const title = baseName(t.history[t.idx]) || t.history[t.idx]
          return (
            <div
              key={t.id}
              onClick={() => setActive(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(t.id)
              }}
              className={`group flex h-9 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[14px] md:h-7 md:px-2 md:text-[13px] transition-colors ${
                active ? 'bg-app text-txt' : 'text-txt2 hover:bg-hover'
              }`}
              title={t.history[t.idx]}
            >
              <EntryIcon category="folder" className="h-3.5 w-3.5" />
              <span className="truncate">{title}</span>
              {t.view?.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-acc" title="有未保存的修改" />}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                className={`ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-panel2 md:h-4 md:w-4 ${
                  active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
                }`}
                title="关闭标签页"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
        <button
          onClick={() => newTab()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-txt2 hover:bg-hover hover:text-txt md:h-7 md:w-7"
          title="新建标签页 (Alt+T)"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
