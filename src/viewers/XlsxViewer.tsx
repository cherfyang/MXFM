import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import * as XLSX from 'xlsx'
import { Loader2, AlertTriangle, Save } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { fmtBytes } from '../utils/format'

const SIZE_LIMIT = 40 * 1024 * 1024
const COL_CAP = 200

type Cell = string | number | boolean | null

function displayValue(cell: XLSX.CellObject | undefined): string {
  if (!cell) return ''
  if (cell.w !== undefined) return String(cell.w)
  if (cell.v !== undefined) {
    if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE'
    return String(cell.v)
  }
  return ''
}

export function XlsxViewer({ entry, readOnly, api }: ViewerProps) {
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null)
  const [sheetName, setSheetName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [size, setSize] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setWb(null)
    setError(null)
    api.registerSave(null)
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (!alive) return
        setSize(f.size)
        if (f.size > SIZE_LIMIT) {
          setError(`文件较大(${fmtBytes(f.size)}),超出预览上限`)
          return
        }
        const buf = await f.arrayBuffer()
        const book = XLSX.read(buf, { type: 'array' })
        if (!alive) return
        setWb(book)
        setSheetName(book.SheetNames[0] ?? '')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
      api.registerSave(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path, entry.size])

  const ws = wb && sheetName ? wb.Sheets[sheetName] : undefined
  const range = useMemo(() => {
    if (!ws || !ws['!ref']) return null
    return XLSX.utils.decode_range(ws['!ref'] as string)
  }, [ws, sheetName])

  const rowCount = range ? range.e.r - range.s.r + 1 : 0
  const colCount = Math.min(range ? range.e.c - range.s.c + 1 : 0, COL_CAP)
  const truncatedNow = range ? range.e.c - range.s.c + 1 > COL_CAP : false

  useEffect(() => {
    if (truncatedNow !== truncated) setTruncated(truncatedNow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [truncatedNow])

  const virt = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 20,
  })

  /** 原扩展名 → SheetJS 写出类型;不在表内说明不能按原格式写回,防止产生"xlsx 内容 + 错误扩展名"的坏文件 */
  const BOOKTYPE_BY_EXT: Record<string, XLSX.BookType> = {
    xlsx: 'xlsx',
    xlsm: 'xlsm',
    xls: 'xls',
    ods: 'ods',
    csv: 'csv',
    dif: 'dif',
    sylk: 'sylk',
  }

  const doSave = async () => {
    if (!wb) return
    const bookType = BOOKTYPE_BY_EXT[entry.ext]
    if (!bookType) {
      useUi.getState().toast(`.${entry.ext} 不支持原地保存,请用系统程序另存为 .xlsx`, 'error')
      return
    }
    try {
      const provider = useFs.getState().provider!
      const out = XLSX.write(wb, { bookType, type: 'array' })
      await provider.writeBytes(entry.path, new Uint8Array(out))
      api.setDirty(false)
      useUi.getState().toast(`Excel 已按 .${entry.ext} 保存(样式与公式可能丢失)`, 'success')
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  useEffect(() => {
    if (readOnly || !wb || truncated) {
      api.registerSave(null)
      return
    }
    api.registerSave(() => doSave())
    return () => api.registerSave(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, wb, truncated, sheetName])

  const setCell = (r: number, c: number, text: string) => {
    if (!wb || !ws || !range) return
    const addr = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })
    const num = Number(text.replace(/,/g, ''))
    if (text !== '' && Number.isFinite(num) && /^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(text.replace(/,/g, ''))) {
      ws[addr] = { t: 'n', v: num }
    } else if (text === '') {
      delete ws[addr]
    } else {
      ws[addr] = { t: 's', v: text }
    }
    setWb({ ...wb, Sheets: { ...wb.Sheets, [sheetName]: ws } })
    api.setDirty(true)
  }

  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <div className="text-sm">{error}</div>
      </div>
    )
  if (!wb)
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 解析中…
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      {/* sheet 标签 */}
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-brd bg-panel px-2">
        {wb.SheetNames.map((name) => (
          <button
            key={name}
            onClick={() => setSheetName(name)}
            className={`h-7 shrink-0 rounded-md px-3 text-[13px] ${
              name === sheetName ? 'bg-sel font-medium text-txt' : 'text-txt2 hover:bg-hover'
            }`}
          >
            {name}
          </button>
        ))}
        <span className="flex-1" />
        {!readOnly && !truncated && (
          <button
            onClick={() => void doSave()}
            className="flex h-7 items-center gap-1 rounded-md bg-panel2 px-2.5 text-xs text-txt hover:bg-hover"
            title="保存 (Ctrl+S)"
          >
            <Save className="h-3.5 w-3.5" /> 保存
          </button>
        )}
      </div>
      {truncated && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 text-xs text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5" /> 超过 {COL_CAP} 列,仅显示前 {COL_CAP} 列,编辑保存已禁用
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {!ws || !range ? (
          <div className="p-6 text-center text-sm text-txt2">空工作表</div>
        ) : (
          <div style={{ height: virt.getTotalSize() + 28, position: 'relative', width: 'max-content', minWidth: '100%' }}>
            <div className="sticky top-0 z-10 flex border-b border-brd bg-panel2 text-xs font-medium text-txt2" style={{ height: 28 }}>
              <div className="flex w-12 shrink-0 items-center justify-center border-r border-brd">#</div>
              {Array.from({ length: colCount }, (_, c) => (
                <div key={c} className="flex min-w-[100px] items-center border-r border-brd px-2">
                  {XLSX.utils.encode_col(range.s.c + c)}
                </div>
              ))}
            </div>
            {virt.getVirtualItems().map((vi) => {
              const r = vi.index
              return (
                <div
                  key={r}
                  className="absolute left-0 top-[28px] flex text-[13px]"
                  style={{ height: 26, transform: `translateY(${vi.start}px)`, width: 'max-content', minWidth: '100%' }}
                >
                  <div className="flex w-12 shrink-0 items-center justify-center border-b border-r border-brd bg-panel2 text-[11px] text-txt2">
                    {r + 1}
                  </div>
                  {Array.from({ length: colCount }, (_, c) => {
                    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })]
                    const isEditing = editing?.r === r && editing?.c === c
                    return (
                      <div
                        key={c}
                        onDoubleClick={() => !readOnly && !truncated && setEditing({ r, c })}
                        className="min-w-[100px] max-w-[300px] truncate border-b border-r border-brd px-2 leading-[25px] hover:bg-hover"
                        title={displayValue(cell)}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            defaultValue={displayValue(cell)}
                            onBlur={(e) => {
                              setCell(r, c, e.target.value)
                              setEditing(null)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                setCell(r, c, (e.target as HTMLInputElement).value)
                                setEditing(null)
                              }
                              if (e.key === 'Escape') setEditing(null)
                            }}
                            className="h-full w-full outline-none ring-1 ring-acc"
                          />
                        ) : (
                          displayValue(cell)
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-brd bg-panel px-3 text-[11px] text-txt2">
        <span>
          {rowCount} 行 × {range ? range.e.c - range.s.c + 1 : 0} 列 · {fmtBytes(size)}
        </span>
        {!readOnly && !truncated && <span>双击单元格可编辑,Ctrl+S 写回原文件</span>}
      </div>
    </div>
  )
}
