import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2, AlertTriangle } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { fmtBytes, decodeSmart, encodeSmart } from '../utils/format'

const SIZE_LIMIT = 30 * 1024 * 1024
const COL_CAP = 256

/** 支持引号内逗号/换行的完整 CSV 解析 */
export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === delim) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function sniffDelim(text: string): string {
  const line = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length)
  const counts: [string, number][] = [
    [',', 0],
    ['\t', 0],
    [';', 0],
  ]
  let inQ = false
  for (const ch of line) {
    if (ch === '"') inQ = !inQ
    else if (!inQ) for (const [d] of counts) if (ch === d) counts.find((c) => c[0] === d)![1]++
  }
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

function serialize(rows: string[][], delim: string): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell.includes(delim) || cell.includes('"') || /[\n\r]/.test(cell)) {
            return `"${cell.replace(/"/g, '""')}"`
          }
          return cell
        })
        .join(delim)
    )
    .join('\n')
}

export function CsvViewer({ entry, readOnly, api }: ViewerProps) {
  const [matrix, setMatrix] = useState<string[][] | null>(null)
  const [encoding, setEncoding] = useState('UTF-8')
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const delimRef = useRef(',')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    setMatrix(null)
    setError(null)
    api.registerSave(null)
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (f.size > SIZE_LIMIT) {
          if (alive) setError(`文件较大(${fmtBytes(f.size)}),仅支持预览前 30000 行,且不能编辑保存`)
          const head = new Uint8Array(await f.slice(0, 4 * 1024 * 1024).arrayBuffer())
          const dec = decodeSmart(head)
          setEncoding(dec.encoding)
          const text = dec.text
          const rows = parseCsv(text, sniffDelim(text)).slice(0, 30000)
          delimRef.current = sniffDelim(text)
          if (alive) {
            setTruncated(true)
            setMatrix(rows)
          }
          return
        }
        const bytes = new Uint8Array(await f.arrayBuffer())
        const dec = decodeSmart(bytes)
        setEncoding(dec.encoding)
        const text = dec.text
        const delim = sniffDelim(text)
        delimRef.current = delim
        const rows = parseCsv(text, delim)
        if (alive) setMatrix(rows)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
      api.registerSave(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path, entry.size, readOnly])

  const doSave = async () => {
    if (!matrix) return
    try {
      const provider = useFs.getState().provider!
      // 按检测到的原编码回写(UTF-16 走 encodeSmart;GBK 暂只能转 UTF-8,是已知限制)
      if (encoding === 'UTF-16LE' || encoding === 'UTF-16BE') {
        await provider.writeBytes(entry.path, encodeSmart(serialize(matrix, delimRef.current), encoding))
      } else {
        await provider.writeText(entry.path, serialize(matrix, delimRef.current))
      }
      api.setDirty(false)
      useUi.getState().toast('CSV 已保存', 'success')
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  useEffect(() => {
    if (readOnly || !matrix || truncated) {
      api.registerSave(null)
      return
    }
    api.registerSave(() => doSave())
    return () => api.registerSave(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, matrix, truncated])

  const rowCount = matrix?.length ?? 0
  // 大文件可达数十万行:不能用 Math.max(...rows.map()) 展开(参数超限直接 RangeError)
  let maxCols = 1
  if (matrix) for (const r of matrix) if (r.length > maxCols) maxCols = r.length
  const colCount = Math.min(maxCols, COL_CAP)

  const virt = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 20,
  })

  const setCell = (r: number, c: number, v: string) => {
    if (!matrix) return
    const next = matrix.map((row) => row.slice())
    while (next[r].length <= c) next[r].push('')
    next[r][c] = v
    setMatrix(next)
    api.setDirty(true)
  }

  if (error && !matrix)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <div className="text-sm">{error}</div>
      </div>
    )
  if (!matrix)
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 解析中…
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      {(truncated || colCount >= COL_CAP) && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 text-xs text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5" /> 文件过大,当前仅预览{truncated ? '前 30000 行' : ''},编辑保存已禁用
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virt.getTotalSize() + 30, position: 'relative', width: 'max-content', minWidth: '100%' }}>
          {/* 表头 */}
          <div
            className="sticky top-0 z-10 flex border-b border-brd bg-panel2 text-xs font-medium text-txt2"
            style={{ height: 30 }}
          >
            <div className="flex w-12 shrink-0 items-center justify-center border-r border-brd">#</div>
            {Array.from({ length: colCount }, (_, c) => (
              <div key={c} className="flex min-w-[110px] items-center border-r border-brd px-2">
                {c + 1}
              </div>
            ))}
          </div>
          {virt.getVirtualItems().map((vi) => {
            const r = vi.index
            const row = matrix[r] ?? []
            return (
              <div
                key={r}
                className="absolute left-0 top-[30px] flex text-[13px]"
                style={{ height: 28, transform: `translateY(${vi.start}px)`, width: 'max-content', minWidth: '100%' }}
              >
                <div className="flex w-12 shrink-0 items-center justify-center border-b border-r border-brd bg-panel2 text-[11px] text-txt2">
                  {r + 1}
                </div>
                {Array.from({ length: colCount }, (_, c) => {
                  const isEditing = editing?.r === r && editing?.c === c
                  return (
                    <div
                      key={c}
                      onDoubleClick={() => !readOnly && !truncated && setEditing({ r, c })}
                      className="min-w-[110px] max-w-[320px] truncate border-b border-r border-brd px-2 leading-[27px] hover:bg-hover"
                      title={row[c] ?? ''}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          autoFocus
                          defaultValue={row[c] ?? ''}
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
                        row[c] ?? ''
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-brd bg-panel px-3 text-[11px] text-txt2">
        <span>{rowCount} 行 × {colCount} 列</span>
        <span>分隔符:{delimRef.current === '\t' ? 'Tab' : delimRef.current}</span>
        {!readOnly && !truncated && <span>双击单元格可编辑,Ctrl+S 保存</span>}
      </div>
    </div>
  )
}

export { serialize as serializeCsv }
