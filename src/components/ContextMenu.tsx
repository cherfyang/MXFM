import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useUi, type MenuItem } from '../stores/ui'

const MENU_W = 208
const ITEM_H = 32
const EDGE = 4

/** 一层菜单项列表(根菜单与子菜单共用,可递归):悬停含 children 的项时展开 flyout */
function MenuList({ items, onClose }: { items: MenuItem[]; onClose(): void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  // 菜单重新打开(items 引用变化)时收起遗留的子菜单
  useEffect(() => setOpenIdx(null), [items])

  return (
    <>
      {items.map((item, i) =>
        item.sep ? (
          <div key={i} className="mx-2 my-1 border-t border-brd" onMouseEnter={() => setOpenIdx(null)} />
        ) : (
          <div key={i} className="relative" onMouseEnter={() => setOpenIdx(item.children ? i : null)}>
            <button
              disabled={item.disabled}
              onClick={() => {
                if (item.children) return // 父项点击只展开/保持子菜单,不关闭整个菜单
                onClose()
                item.onClick?.()
              }}
              className={`flex h-8 w-full items-center gap-2.5 px-3 text-left text-[13px] disabled:pointer-events-none disabled:opacity-35 ${
                item.danger ? 'text-danger hover:bg-hover' : 'text-txt hover:bg-hover'
              } ${openIdx === i ? 'bg-hover' : ''}`}
            >
              {item.icon && <span className="flex h-4 w-4 items-center justify-center">{item.icon}</span>}
              {item.label}
              {item.children && <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-60" />}
            </button>
            {item.children && openIdx === i && <MenuFlyout items={item.children} onClose={onClose} />}
          </div>
        )
      )}
    </>
  )
}

/** 子菜单 flyout:绝对定位于父项(relative wrapper)右缘、顶对齐;右缘/底缘溢出时翻转 */
function MenuFlyout({ items, onClose }: { items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [flipX, setFlipX] = useState(false)
  const [flipY, setFlipY] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setFlipX(r.right > window.innerWidth - EDGE)
    setFlipY(r.bottom > window.innerHeight - EDGE)
  }, [])

  return (
    <div
      ref={ref}
      className={`mx-fade absolute z-10 rounded-lg border border-brd bg-panel py-1 shadow-xl shadow-black/25 ${
        flipX ? 'right-full' : 'left-full'
      } ${flipY ? 'bottom-0' : 'top-0'}`}
      style={{ width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}

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
  if (x + MENU_W > window.innerWidth) x = Math.max(EDGE, window.innerWidth - MENU_W - 6)
  if (y + h > window.innerHeight) y = Math.max(EDGE, window.innerHeight - h - 6)

  return (
    <div
      ref={ref}
      className="mx-fade fixed z-50 rounded-lg border border-brd bg-panel py-1 shadow-xl shadow-black/25"
      style={{ left: x, top: y, width: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={menu.items} onClose={closeMenu} />
    </div>
  )
}
