import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, AlertTriangle, BookOpen } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useBlobUrl } from './registry'
import { IconBtn } from '../components/ui'

/** EPUB 阅读器 —— 基于 epub.js */
export function EpubViewer({ entry }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendRef = useRef<any>(null)
  const [url] = useBlobUrlSafe(entry)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (!url || !hostRef.current) return
    let r: any = null
    setStatus('loading')
    ;(async () => {
      try {
        const ePub = (await import('epubjs')).default
        const book = ePub(url)
        r = book.renderTo(hostRef.current!, { width: '100%', height: '100%', flow: 'paginated' })
        await r.display()
        rendRef.current = r
        setStatus('ready')
      } catch (e) {
        setStatus('error')
        setErrMsg((e as Error).message || String(e))
      }
    })()
    return () => {
      try {
        r?.destroy()
      } catch {
        /* ignore */
      }
      rendRef.current = null
    }
  }, [url])

  const flip = (d: number) => {
    if (d < 0) rendRef.current?.prev()
    else rendRef.current?.next()
  }

  // 键盘翻页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
      if (e.key === 'ArrowLeft') flip(-1)
      if (e.key === 'ArrowRight') flip(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (status === 'error')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <div className="text-sm">电子书打开失败:{errMsg}</div>
      </div>
    )

  return (
    <div className="relative flex h-full flex-col bg-app">
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-app">
          <span className="flex items-center text-txt2">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 打开电子书…
          </span>
        </div>
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-brd bg-panel px-2">
        <BookOpen className="ml-1 h-4 w-4 text-acc" />
        <span className="mx-2 min-w-0 flex-1 truncate text-[13px] font-medium">{entry.name}</span>
        <IconBtn title="上一页 (←)" onClick={() => flip(-1)}>
          <ChevronLeft className="h-4.5 w-4.5" />
        </IconBtn>
        <IconBtn title="下一页 (→)" onClick={() => flip(1)}>
          <ChevronRight className="h-4.5 w-4.5" />
        </IconBtn>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-panel2" />
    </div>
  )
}

/** useBlobUrl 的简易包装(避免循环依赖问题,行为一致) */
function useBlobUrlSafe(entry: import('../fs/types').FileEntry): [string | null] {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let u: string | null = null
    let alive = true
    ;(async () => {
      try {
        const provider = (await import('../stores/fs')).useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        u = URL.createObjectURL(f)
        if (alive) setUrl(u)
      } catch {
        /* ignore */
      }
    })()
    return () => {
      alive = false
      if (u) URL.revokeObjectURL(u)
    }
  }, [entry.path, entry.size, entry.modified])
  return [url]
}
