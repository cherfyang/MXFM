import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Plus, Loader2 } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { fmtBytes } from '../utils/format'

const CHUNK = 64 * 1024
const MAX_LOAD = 2 * 1024 * 1024

export function HexViewer({ entry }: ViewerProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [totalSize, setTotalSize] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setBytes(null)
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (!alive) return
        setTotalSize(f.size)
        const data = await provider.readBytes(entry.path, 0, CHUNK)
        if (alive) setBytes(data)
      } catch {
        if (alive) setBytes(new Uint8Array(0))
      }
    })()
    return () => {
      alive = false
    }
  }, [entry.path])

  const loadMore = async () => {
    if (!bytes) return
    const provider = useFs.getState().provider
    if (!provider) return
    // 竞态守卫:读取期间切到别的文件,过期响应不得覆盖新文件内容
    const pathAtRequest = entry.path
    try {
      const nextLen = Math.min(bytes.length + CHUNK, totalSize, MAX_LOAD)
      const data = await provider.readBytes(entry.path, 0, nextLen)
      if (entry.path !== pathAtRequest) return
      setBytes(data)
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const rowCount = bytes ? Math.ceil(bytes.length / 16) : 0

  const virt = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 40,
  })

  const rows = useMemo(() => {
    if (!bytes) return []
    return Array.from({ length: rowCount }, (_, r) => {
      const off = r * 16
      const slice = bytes.slice(off, off + 16)
      return { offset: off, slice }
    })
  }, [bytes, rowCount])

  if (!bytes)
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 读取字节…
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[12.5px] leading-5">
        <div style={{ height: virt.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
          {virt.getVirtualItems().map((vi) => {
            const { offset, slice } = rows[vi.index]
            return (
              <div key={offset} className="absolute left-0 top-0 flex h-5 items-center gap-4" style={{ transform: `translateY(${vi.start}px)` }}>
                <span className="w-16 shrink-0 select-none text-right text-txt2">{offset.toString(16).padStart(8, '0')}</span>
                <span className="flex w-[440px] shrink-0 gap-0">
                  {Array.from({ length: 16 }, (_, i) =>
                    i < slice.length ? (
                      <span
                        key={i}
                        className="w-[26px] text-center"
                        style={{ color: slice[i] >= 0x20 && slice[i] < 0x7f ? 'var(--txt)' : 'var(--acc)' }}
                      >
                        {slice[i].toString(16).padStart(2, '0')}
                      </span>
                    ) : (
                      <span key={i} className="w-[26px] text-center opacity-0">
                        00
                      </span>
                    )
                  )}
                </span>
                <span className="shrink-0 text-txt2">
                  {Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-brd bg-panel px-3 text-xs text-txt2">
        <span>
          已加载 {fmtBytes(bytes.length)} / 共 {fmtBytes(totalSize)}
        </span>
        {bytes.length < totalSize && bytes.length < MAX_LOAD && (
          <button
            onClick={() => void loadMore()}
            className="flex items-center gap-1 rounded bg-panel2 px-2 py-0.5 text-txt hover:bg-hover"
          >
            <Plus className="h-3 w-3" /> 加载更多
          </button>
        )}
        {bytes.length >= MAX_LOAD && totalSize > MAX_LOAD && <span>(已达预览上限 {fmtBytes(MAX_LOAD)})</span>}
      </div>
    </div>
  )
}
