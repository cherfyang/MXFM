import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Play, X } from 'lucide-react'
import type { FileEntry } from '../fs/types'

/** 桌面版才有转码能力 */
export function transcodeAvailable(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { mxAPI?: { transcode?: unknown } }).mxAPI?.transcode
}

/** 这些扩展名浏览器基本放不了,直接自动开始转码 */
export const VIDEO_NEED_TRANSCODE = new Set(['avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mpe', 'ts', 'm2ts', 'vob', '3gp', 'asf', 'rm', 'rmvb', 'f4v'])
export const AUDIO_NEED_TRANSCODE = new Set(['ape', 'tta', 'wv', 'amr', 'ac3', 'dts', 'mka', 'caf'])

interface Props {
  entry: FileEntry
  kind: 'video' | 'audio'
  auto?: boolean
  onReady(url: string): void
}

type Phase = 'idle' | 'running' | 'error'

/** 原生播放失败时的转码面板:秒级重封装 / 完整转码,完成后回传可播放地址 */
export function TranscodeOverlay({ entry, kind, auto, onReady }: Props) {
  const [phase, setPhase] = useState<Phase>(auto ? 'running' : 'idle')
  const [msg, setMsg] = useState('')
  const started = useRef(false)

  const start = async () => {
    if (started.current) return
    started.current = true
    setPhase('running')
    const api = (window as unknown as {
      mxAPI: {
        transcode(p: string, kind: string): Promise<{ ok: boolean; outPath?: string; msg?: string }>
      }
    }).mxAPI
    const provider = (await import('../stores/fs')).useFs.getState().provider as unknown as {
      toNativePath?(p: string): string
    }
    const nativePath = provider?.toNativePath?.(entry.path)
    if (!nativePath) {
      setPhase('error')
      setMsg('无法定位本地文件')
      return
    }
    const r = await api.transcode(nativePath, kind)
    if (r.ok && r.outPath) {
      onReady('mxfile://localhost/' + encodeURIComponent(r.outPath))
    } else {
      setPhase('error')
      setMsg(r.msg || '转码失败')
    }
  }

  const cancel = () => {
    ;(window as unknown as { mxAPI?: { transcodeCancel(): void } }).mxAPI?.transcodeCancel()
    started.current = false
    setPhase('idle')
  }

  useEffect(() => {
    if (auto) void start()
    return () => {
      ;(window as unknown as { mxAPI?: { transcodeCancel(): void } }).mxAPI?.transcodeCancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path])

  const name = entry.name

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center text-txt">
      {phase === 'running' && (
        <>
          <Loader2 className="h-8 w-8 animate-spin text-acc" />
          <div className="text-sm">正在转码「{name}」…</div>
          <div className="max-w-sm text-xs leading-relaxed text-txt2">
            优先尝试秒级重封装;编码不受支持时进行完整转码,大文件耗时较长,请耐心等待
          </div>
          <button onClick={cancel} className="mt-1 flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-4 text-sm hover:bg-white/20">
            <X className="h-4 w-4" /> 取消
          </button>
        </>
      )}
      {phase === 'idle' && (
        <>
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <div className="text-sm">浏览器内核不支持「{name}」的编码</div>
          <button onClick={() => void start()} className="flex h-10 items-center gap-2 rounded-lg bg-acc px-5 text-sm text-white hover:opacity-90">
            <Play className="h-4.5 w-4.5" /> 转码并播放
          </button>
        </>
      )}
      {phase === 'error' && (
        <>
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <div className="text-sm">{msg}</div>
          <button onClick={() => void start()} className="flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-4 text-sm hover:bg-white/20">
            重试
          </button>
        </>
      )}
    </div>
  )
}
