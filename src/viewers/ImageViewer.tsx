import { useEffect, useRef, useState } from 'react'
import {
  ZoomIn,
  ZoomOut,
  RotateCw,
  FlipHorizontal,
  Maximize,
  Loader2,
  ImageOff,
  Save,
  Wand2,
  X,
} from 'lucide-react'
import type { ViewerProps } from './registry'
import { useBlobUrl } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { useSettings } from '../stores/settings'
import { IconBtn } from '../components/ui'

function LazyEditor({ url, entry, onClose }: { url: string; entry: import('../fs/types').FileEntry; onClose(): void }) {
  const [Comp, setComp] = useState<React.ComponentType<Record<string, unknown>> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    import('react-filerobot-image-editor')
      .then((m) => setComp(() => m.default as unknown as React.ComponentType<Record<string, unknown>>))
      .catch((e) => setErr((e as Error).message))
  }, [])
  if (err) return <div className="flex h-full items-center justify-center text-sm text-txt">编辑器加载失败:{err}</div>
  if (!Comp)
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载编辑器…
      </div>
    )
  return (
    <Comp
      source={url}
      onClose={onClose}
      defaultSavedImageType="png"
      defaultSavedImageName={entry.name.replace(/\.[^.]+$/, '') + '-edited'}
      onSave={async (res: { imageBase64?: string; fullName?: string }) => {
        const dataUrl = res.imageBase64
        if (!dataUrl) return
        const blob = await (await fetch(dataUrl)).blob()
        const s = (await import('../stores/fs')).useFs.getState()
        const provider = s.provider!
        const dir = entry.path.slice(0, entry.path.length - entry.name.length - 1)
        const base = entry.name.replace(/\.[^.]+$/, '')
        const name = (await provider.exists(`${dir}/${base}-edited.png`))
          ? await provider.uniqueName(dir, `${base}-edited.png`)
          : `${base}-edited.png`
        await provider.writeBlob(`${dir}/${name}`, blob)
        ;(await import('../stores/ui')).useUi.getState().toast(`已保存为「${name}」`, 'success')
        await s.refresh()
        onClose()
      }}
    />
  )
}

export function ImageViewer({ entry, nav }: ViewerProps) {
  const url = useBlobUrl(entry)
  const showCheckerboard = useSettings((s) => s.showCheckerboard)
  const [editorOpen, setEditorOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const [rot, setRot] = useState(0)
  const [flip, setFlip] = useState(false)
  const [err, setErr] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    setScale(1)
    setRot(0)
    setFlip(false)
    setErr(false)
    setDims(null)
    setEditorOpen(false)
  }, [entry.path])

  const zoom = (d: number) => setScale((s) => Math.min(8, Math.max(0.1, +(s * d).toFixed(3))))
  const readDims = () => {
    const im = imgRef.current
    if (im && im.naturalWidth) setDims((d) => d ?? { w: im.naturalWidth, h: im.naturalHeight })
  }
  const scaled = (n: number) => Math.max(1, Math.round(n * scale))
  const swapped = rot % 180 !== 0
  // 显式尺寸模式:缩放/旋转时用真实布局尺寸替代 transform scale,让 overflow 滚动条生效(修复放大后无法平移)
  const explicit = dims !== null && (scale !== 1 || swapped)
  const boxW = dims ? (swapped ? scaled(dims.h) : scaled(dims.w)) : 0
  const boxH = dims ? (swapped ? scaled(dims.w) : scaled(dims.h)) : 0

  // Ctrl+滚轮缩放
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  // 键盘:左右切换,+/−/0 缩放,R 旋转
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.key === 'ArrowLeft' && nav) nav.onNav(-1)
      else if (e.key === 'ArrowRight' && nav) nav.onNav(1)
      else if (e.key === '+' || e.key === '=') zoom(1.25)
      else if (e.key === '-' || e.key === '_') zoom(1 / 1.25)
      else if (e.key === '0') {
        setScale(1)
        setRot(0)
        setFlip(false)
      } else if (e.key === 'r' || e.key === 'R') {
        // R 顺时针,Shift+R 逆时针
        setRot((r) => (((r + (e.shiftKey ? -90 : 90)) % 360) + 360) % 360)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav])

  const saveCopy = async () => {
    const img = imgRef.current
    if (!img) return
    try {
      const canvas = document.createElement('canvas')
      const swap = rot % 180 !== 0
      canvas.width = swap ? img.naturalHeight : img.naturalWidth
      canvas.height = swap ? img.naturalWidth : img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.translate(canvas.width / 2, canvas.height / 2)
      ctx.rotate((rot * Math.PI) / 180)
      ctx.scale(flip ? -1 : 1, 1)
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (!blob) {
        useUi
          .getState()
          .toast('图片过大,超出浏览器画布上限,另存失败(可先缩小/裁剪后再试)', 'error')
        return
      }
      const s = useFs.getState()
      const provider = s.provider!
      const dot = entry.name.lastIndexOf('.')
      const base = dot > 0 ? entry.name.slice(0, dot) : entry.name
      const dir = entry.path.slice(0, entry.path.length - entry.name.length - 1)
      const unique = await provider.uniqueName(dir, `${base}-edited.png`)
      await provider.writeBlob(`${dir}/${unique}`, blob)
      useUi.getState().toast(`已另存为「${unique.split('/').pop()}」`, 'success')
      await s.refresh()
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  if (err) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
        <ImageOff className="h-8 w-8" />
        <div className="text-sm">图片加载失败</div>
      </div>
    )
  }

  return (
    <div className="relative h-full">
      {/* 工具条 */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-brd bg-panel/90 p-1 shadow-md backdrop-blur">
        <IconBtn title="缩小" onClick={() => zoom(1 / 1.25)}>
          <ZoomOut className="h-4 w-4" />
        </IconBtn>
        <span className="w-12 text-center text-xs text-txt2">{Math.round(scale * 100)}%</span>
        <IconBtn title="放大" onClick={() => zoom(1.25)}>
          <ZoomIn className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="适应窗口" onClick={() => setScale(1)}>
          <Maximize className="h-4 w-4" />
        </IconBtn>
        <span className="mx-0.5 h-4 border-l border-brd" />
        <IconBtn title="旋转 90°" onClick={() => setRot((r) => (r + 90) % 360)}>
          <RotateCw className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="水平翻转" active={flip} onClick={() => setFlip((f) => !f)}>
          <FlipHorizontal className="h-4 w-4" />
        </IconBtn>
        <span className="mx-0.5 h-4 border-l border-brd" />
        <IconBtn title="另存为 PNG 副本" onClick={() => void saveCopy()}>
          <Save className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="图片编辑器(裁剪/标注/滤镜)" onClick={() => setEditorOpen(true)}>
          <Wand2 className="h-4 w-4" />
        </IconBtn>
      </div>

      {editorOpen && url && (
        <div className="absolute inset-0 z-30 flex flex-col bg-black/90 p-1 md:p-4">
          <div className="mb-1 flex h-9 shrink-0 items-center justify-between px-2">
            <span className="text-xs text-white/70">图片编辑器</span>
            <button onClick={() => setEditorOpen(false)} className="rounded p-1.5 text-white/70 hover:bg-white/10 hover:text-white" title="关闭编辑器">
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-panel">
            <LazyEditor url={url} entry={entry} onClose={() => setEditorOpen(false)} />
          </div>
        </div>
      )}

      {nav && (
        <>
          <button
            onClick={() => nav.onNav(-1)}
            className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-panel/80 p-2 text-txt shadow-md backdrop-blur hover:bg-hover"
            title="上一张 (←)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button
            onClick={() => nav.onNav(1)}
            className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-panel/80 p-2 text-txt shadow-md backdrop-blur hover:bg-hover"
            title="下一张 (→)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </>
      )}

      <div className={`${showCheckerboard ? 'checker' : ''} h-full overflow-auto`} onWheel={onWheel}>
        {!url ? (
          <div className="flex h-full items-center justify-center text-txt2">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="flex min-h-full min-w-full items-center justify-center p-6">
            {explicit ? (
              <div style={{ width: boxW, height: boxH, position: 'relative', flex: 'none' }}>
                <img
                  ref={imgRef}
                  src={url}
                  alt={entry.name}
                  onError={() => setErr(true)}
                  onLoad={readDims}
                  draggable={false}
                  className="shadow-lg"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: scaled(dims!.w),
                    height: scaled(dims!.h),
                    transform: `translate(-50%, -50%) rotate(${rot}deg) scaleX(${flip ? -1 : 1})`,
                  }}
                />
              </div>
            ) : (
              <img
                ref={imgRef}
                src={url}
                alt={entry.name}
                onError={() => setErr(true)}
                onLoad={readDims}
                draggable={false}
                className="max-h-none shadow-lg"
                style={{
                  transform: `rotate(${rot}deg) scaleX(${flip ? -1 : 1})`,
                  transition: 'transform 0.12s ease-out',
                  maxHeight: rot % 180 === 0 ? 'calc(100vh - 220px)' : 'none',
                  maxWidth: '100%',
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
