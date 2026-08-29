import { useEffect, useRef } from 'react'
import { useUi } from '../stores/ui'

const MENU_W = 208
const ITEM_H = 32

export function ContextMenu() {
  const menu = useUi((s) => s.menu)
  const closeMenu = useUi((s) => s.closeMenu)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, closeMenu])

  if (!menu) return null

  let x = menu.x
  let y = menu.y
  const h = menu.items.reduce((acc, it) => acc + (it.sep ? 9 : ITEM_H), 8)
  if (x + MENU_W > window.innerWidth) x = Math.max(4, window.innerWidth - MENU_W - 6)
  if (y + h > window.innerHeight) y = Math.max(4, window.innerHeight - h - 6)

  return (
    <div
      ref={ref}
      className="mx-fade fixed z-50 rounded-lg border border-brd bg-panel py-1 shadow-xl shadow-black/25"
      style={{ left: x, top: y, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item.sep ? (
          <div key={i} className="mx-2 my-1 border-t border-brd" />
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => {
              closeMenu()
              item.onClick?.()
            }}
            className={`flex h-8 w-full items-center gap-2.5 px-3 text-left text-[13px] disabled:pointer-events-none disabled:opacity-35 ${
              item.danger ? 'text-danger hover:bg-hover' : 'text-txt hover:bg-hover'
            }`}
          >
            {item.icon && <span className="flex h-4 w-4 items-center justify-center">{item.icon}</span>}
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
