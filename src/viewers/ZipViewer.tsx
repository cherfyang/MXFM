import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { unzipSync, strFromU8 } from 'fflate'
import { Archive, Download, Loader2, AlertTriangle, X, Folder } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { fmtBytes } from '../utils/format'
import { extOf } from '../utils/format'
import { categoryOf } from '../utils/categories'
import { EntryIcon } from '../components/Icons'
import { baseName } from '../utils/path'

const SIZE_LIMIT = 200 * 1024 * 1024

interface ZipItem {
  path: string
  name: string
  isDir: boolean
  size: number
}

export function ZipViewer({ entry }: ViewerProps) {
  const [items, setItems] = useState<ZipItem[] | null>(null)
  const [data, setData] = useState<Record<string, Uint8Array> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; url?: string; text?: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setItems(null)
    setData(null)
    setError(null)
    setPreview(null)
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (f.size > SIZE_LIMIT) {
          setError(`压缩包过大(${fmtBytes(f.size)}),超出预览上限`)
          return
        }
        const buf = new Uint8Array(await f.arrayBuffer())
        const files = unzipSync(buf)
        if (!alive) return
        const list: ZipItem[] = Object.entries(files)
          .filter(([p]) => !p.startsWith('__MACOSX'))
          .map(([p, bytes]) => ({
            path: p,
            name: baseName(p.replace(/\/$/, '')) || p,
            isDir: p.endsWith('/'),
            size: bytes.length,
          }))
          .sort((a, b) => (a.isDir === b.isDir ? a.path.localeCompare(b.path) : a.isDir ? -1 : 1))
        setItems(list)
        setData(files)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [entry.path])

  const virt = useVirtualizer({
    count: items?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 20,
  })

  const openItem = (item: ZipItem) => {
    if (!data) return
    const bytes = data[item.path]
    if (!bytes || item.isDir) return
    const cat = categoryOf({ kind: 'file', name: item.name, ext: extOf(item.name) })
    if (cat === 'image' || cat === 'video' || cat === 'audio') {
      const blob = new Blob([bytes as BlobPart])
      setPreview({ path: item.path, url: URL.createObjectURL(blob) })
    } else if (cat === 'binary') {
      setPreview({ path: item.path, text: `二进制文件,共 ${fmtBytes(bytes.length)},不支持预览` })
    } else {
      try {
        setPreview({ path: item.path, text: strFromU8(bytes.slice(0, 512 * 1024)) })
      } catch {
        setPreview({ path: item.path, text: '无法解码该文件内容' })
      }
    }
  }

  const extractAll = async () => {
    if (!data || !items) return
    const s = useFs.getState()
    const dir = entry.path.slice(0, entry.path.length - entry.name.length - 1)
    const base = entry.name.replace(/\.zip$/i, '')
    const destName = (await s.provider!.exists(`${dir}/${base}`))
      ? await s.provider!.uniqueName(dir, base)
      : base
    const destDir = `${dir}/${destName}`
    try {
      await s.provider!.mkdir(destDir)
      const fileItems = items.filter((i) => !i.isDir)
      // 先按层级创建所有中间目录
      const dirs = new Set<string>()
      for (const item of fileItems) {
        const segs = item.path.split('/').slice(0, -1)
        let cur = destDir
        for (const seg of segs) {
          cur = `${cur}/${seg}`
          dirs.add(cur)
        }
      }
      for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
        await s.provider!.mkdir(d)
      }
      let n = 0
      for (const item of fileItems) {
        await s.provider!.writeBytes(`${destDir}/${item.path}`, data[item.path])
        n++
      }
      useUi.getState().toast(`已解压 ${n} 个文件到「${destDir.split('/').pop()}」`, 'success')
      await s.refresh()
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <div className="text-sm">{error}</div>
      </div>
    )
  if (!items)
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 读取压缩包…
      </div>
    )

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-brd bg-panel px-3">
        <Archive className="h-4 w-4 text-amber-400" />
        <span className="text-xs text-txt2">
          {items.filter((i) => !i.isDir).length} 个文件 · 共 {fmtBytes(items.reduce((a, i) => a + i.size, 0))}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => void extractAll()}
          className="flex h-7 items-center gap-1.5 rounded-md bg-acc px-2.5 text-xs text-white hover:opacity-90"
        >
          <Download className="h-3.5 w-3.5" /> 全部解压
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const item = items[vi.index]
            return (
              <div
                key={item.path}
                onClick={() => openItem(item)}
                className={`absolute left-0 top-0 flex h-[30px] w-full cursor-default items-center gap-2 px-3 text-[13px] hover:bg-hover ${
                  preview?.path === item.path ? 'bg-sel' : ''
                }`}
                style={{ transform: `translateY(${vi.start}px)` }}
                title={item.path}
              >
                {item.isDir ? (
                  <Folder className="h-4 w-4 shrink-0 text-acc" />
                ) : (
                  <EntryIcon category={categoryOf({ kind: 'file', name: item.name, ext: extOf(item.name) })} />
                )}
                <span className="min-w-0 flex-1 truncate">{item.path}</span>
                <span className="shrink-0 text-xs text-txt2">{item.isDir ? '' : fmtBytes(item.size)}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* 包内文件预览 */}
      {preview && (
        <div className="absolute inset-0 z-20 flex flex-col bg-panel shadow-2xl">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-brd px-3">
            <span className="min-w-0 flex-1 truncate text-[13px]">{preview.path}</span>
            <button
              onClick={() => {
                if (preview.url) URL.revokeObjectURL(preview.url)
                setPreview(null)
              }}
              className="rounded p-1.5 text-txt2 hover:bg-hover hover:text-txt"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {preview.url ? (
              /\.(mp4|webm|mkv)$/i.test(preview.path) ? (
                <video src={preview.url} controls className="max-h-full max-w-full" />
              ) : /\.(mp3|wav|ogg|flac|m4a)$/i.test(preview.path) ? (
                <audio src={preview.url} controls className="w-full" />
              ) : (
                <img src={preview.url} alt="" className="mx-auto max-w-full" />
              )
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-[13px]">{preview.text}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
