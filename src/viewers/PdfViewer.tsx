import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, AlertTriangle } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { IconBtn } from '../components/ui'

export function PdfViewer({ entry }: ViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<any>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1.3)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    let alive = true
    setStatus('loading')
    ;(async () => {
      try {
        const [pdfjs, worker] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ])
        pdfjs.GlobalWorkerOptions.workerSrc = (worker as any).default
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        const data = new Uint8Array(await f.arrayBuffer())
        const doc = await pdfjs.getDocument({ data }).promise
        if (!alive) {
          void doc.destroy()
          return
        }
        docRef.current = doc
        setNumPages(doc.numPages)
        setPage(1)
        setStatus('ready')
      } catch (e) {
        if (alive) {
          setStatus('error')
          setErrMsg(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      alive = false
      void docRef.current?.destroy()
      docRef.current = null
    }
  }, [entry.path])

  // 渲染当前页
  useEffect(() => {
    if (status !== 'ready') return
    let task: any = null
    ;(async () => {
      const doc = docRef.current
      const canvas = canvasRef.current
      if (!doc || !canvas) return
      const p = await doc.getPage(page)
      const viewport = p.getViewport({ scale })
      canvas.width = Math.floor(viewport.width * devicePixelRatio)
      canvas.height = Math.floor(viewport.height * devicePixelRatio)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      task = p.render({ canvasContext: canvas.getContext('2d')!, viewport, transform: devicePixelRatio > 1 ? [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0] : undefined })
      await task.promise
    })().catch(() => {})
    return () => {
      try {
        task?.cancel()
      } catch {
        /* ignore */
      }
    }
  }, [page, scale, status])

  if (status === 'loading')
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在解析 PDF…
      </div>
    )
  if (status === 'error')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <div className="text-sm">PDF 加载失败:{errMsg}</div>
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-brd bg-panel px-2">
        <IconBtn title="上一页" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          <ChevronLeft className="h-4 w-4" />
        </IconBtn>
        <span className="text-xs text-txt2">
          第 <input
            value={page}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isInteger(n)) setPage(Math.min(numPages, Math.max(1, n)))
            }}
            className="mx-1 h-6 w-10 rounded border border-brd bg-panel2 px-1 text-center text-txt outline-none"
          />{' '}
          / {numPages} 页
        </span>
        <IconBtn title="下一页" disabled={page >= numPages} onClick={() => setPage((p) => Math.min(numPages, p + 1))}>
          <ChevronRight className="h-4 w-4" />
        </IconBtn>
        <span className="mx-2 h-4 border-l border-brd" />
        <IconBtn title="缩小" onClick={() => setScale((s) => Math.max(0.4, +(s - 0.2).toFixed(2)))}>
          <ZoomOut className="h-4 w-4" />
        </IconBtn>
        <span className="w-12 text-center text-xs text-txt2">{Math.round(scale * 100)}%</span>
        <IconBtn title="放大" onClick={() => setScale((s) => Math.min(4, +(s + 0.2).toFixed(2)))}>
          <ZoomIn className="h-4 w-4" />
        </IconBtn>
      </div>
      <div ref={wrapRef} className="min-h-0 flex-1 overflow-auto bg-panel2 p-4">
        <div className="mx-auto w-fit shadow-lg">
          <canvas ref={canvasRef} className="bg-white" />
        </div>
      </div>
    </div>
  )
}
