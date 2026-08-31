import { useEffect, useRef, useState } from 'react'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  PictureInPicture2,
  Camera,
  Repeat,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import type { ViewerProps } from './registry'
import { useBlobUrl } from './registry'
import { fmtTime } from './playerUtil'
import { TranscodeOverlay, VIDEO_NEED_TRANSCODE, transcodeAvailable } from './TranscodeOverlay'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

export function VideoViewer({ entry, nav }: ViewerProps) {
  const url = useBlobUrl(entry)
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [vol, setVol] = useState(1)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimer = useRef<number | null>(null)
  const [overrideUrl, setOverrideUrl] = useState<string | null>(null)
  const [forcedTranscode, setForcedTranscode] = useState(false)

  const posKey = `mx-vp:${entry.path}`

  useEffect(() => {
    setReady(false)
    setErr(false)
    setTime(0)
    setDuration(0)
    setOverrideUrl(null)
    setForcedTranscode(false)
  }, [entry.path])

  useEffect(() => {
    return () => {
      // 卸载时保存进度
      const v = videoRef.current
      if (v && v.currentTime > 3 && v.duration && v.currentTime < v.duration - 5) {
        try {
          localStorage.setItem(posKey, String(v.currentTime))
        } catch {
          /* ignore */
        }
      }
    }
  }, [posKey])

  // 自动播放 + 恢复进度
  useEffect(() => {
    if (!url || !ready) return
    const v = videoRef.current
    if (!v) return
    let saved = 0
    try {
      saved = Number(localStorage.getItem(posKey) ?? 0)
    } catch {
      /* ignore */
    }
    if (saved > 0 && saved < v.duration - 5) v.currentTime = saved
    v.play().catch(() => {
      /* 自动播放被拦截时显示大按钮即可 */
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ready])

  const scheduleHide = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    setControlsVisible(true)
    hideTimer.current = window.setTimeout(() => {
      if (!videoRef.current?.paused) setControlsVisible(false)
    }, 2600)
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
    scheduleHide()
  }

  const seek = (t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = t
    setTime(t)
  }

  const changeVol = (x: number) => {
    const v = videoRef.current
    if (!v) return
    v.volume = x
    v.muted = x === 0
    setVol(x)
    setMuted(x === 0)
  }

  const screenshot = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')!.drawImage(v, 0, 0)
    c.toBlob((b) => {
      if (!b) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(b)
      a.download = `${entry.name.replace(/\.[^.]+$/, '')}-${fmtTime(v.currentTime).replace(/:/g, '-')}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }, 'image/png')
  }

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await wrapRef.current?.requestFullscreen().catch(() => {})
    } else {
      await document.exitFullscreen().catch(() => {})
    }
  }

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const v = videoRef.current
    if (!v) return
    switch (e.key) {
      case ' ':
        e.preventDefault()
        togglePlay()
        break
      case 'ArrowLeft':
        seek(Math.max(0, v.currentTime - 5))
        break
      case 'ArrowRight':
        seek(Math.min(v.duration || 0, v.currentTime + 5))
        break
      case 'ArrowUp':
        changeVol(Math.min(1, v.volume + 0.1))
        break
      case 'ArrowDown':
        changeVol(Math.max(0, v.volume - 0.1))
        break
      case 'f':
        void toggleFullscreen()
        break
      case 'm':
        v.muted = !v.muted
        setMuted(v.muted)
        break
    }
  }

  const pct = duration > 0 ? (time / duration) * 100 : 0

  const nativeNeedsTranscode = !overrideUrl && transcodeAvailable() && VIDEO_NEED_TRANSCODE.has(entry.ext)
  const showTranscode = nativeNeedsTranscode || forcedTranscode

  if (showTranscode) {
    return (
      <div className="relative h-full bg-black">
        <TranscodeOverlay
          entry={entry}
          kind="video"
          auto={nativeNeedsTranscode}
          onReady={(u) => {
            setOverrideUrl(u)
            setForcedTranscode(false)
          }}
        />
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={scheduleHide}
      className={`relative flex h-full items-center justify-center bg-black outline-none ${
        fullscreen ? '' : 'rounded-none'
      }`}
    >
      {(overrideUrl || url) && (
        <video
          key={overrideUrl ?? url}
          ref={videoRef}
          src={overrideUrl ?? url ?? undefined}
          loop={loop}
          className="h-full w-full object-contain"
          onClick={togglePlay}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0)
            setReady(true)
            scheduleHide()
          }}
          onTimeUpdate={(e) => {
            setTime(e.currentTarget.currentTime)
            // 每 3 秒存一次进度
            const t = e.currentTarget.currentTime
            if (Math.floor(t) % 3 === 0) {
              try {
                localStorage.setItem(posKey, String(t))
              } catch {
                /* ignore */
              }
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false)
            setControlsVisible(true)
          }}
          onError={() => {
            // 桌面版遇到不认识的编码时,提供转码兜底
            setErr(true)
          }}
        />
      )}

      {!url && (
        <div className="flex h-full items-center justify-center text-txt2">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {err && !showTranscode && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-center text-txt">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <div className="text-sm">浏览器不支持该视频编码</div>
          {transcodeAvailable() ? (
            <button
              onClick={() => setForcedTranscode(true)}
              className="flex h-10 items-center gap-2 rounded-lg bg-acc px-5 text-sm text-white hover:opacity-90"
            >
              转码并播放
            </button>
          ) : (
            <div className="text-xs text-txt2">MP4(H.264)/ WebM / MKV 支持最好;HEVC 需要系统解码器</div>
          )}
        </div>
      )}

      {/* 中央播放按钮 */}
      {!playing && ready && !err && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 m-auto flex h-16 w-16 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition-transform hover:scale-105"
          title="播放 (空格)"
        >
          <Play className="ml-1 h-8 w-8" />
        </button>
      )}

      {/* 控制条 */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-3 pt-8 transition-opacity ${
          controlsVisible || !playing ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="relative mb-2 h-1.5 cursor-pointer rounded bg-white/20" onClick={(e) => {
          const rect = (e.target as HTMLElement).getBoundingClientRect()
          seek(((e.clientX - rect.left) / rect.width) * duration)
        }}>
          <div className="absolute left-0 top-0 h-full rounded bg-acc" style={{ width: `${pct}%` }} />
          <div
            className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow"
            style={{ left: `calc(${pct}% - 6px)` }}
          />
        </div>
        <div className="flex items-center gap-2 text-white">
          <button onClick={togglePlay} className="rounded p-1 hover:bg-white/15" title="播放/暂停 (空格)">
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
          <span className="text-xs tabular-nums text-white/85">
            {fmtTime(time)} / {fmtTime(duration)}
          </span>
          <span className="flex-1" />
          <button onClick={() => setLoop((l) => !l)} className={`rounded p-1 hover:bg-white/15 ${loop ? 'text-acc' : ''}`} title="循环播放">
            <Repeat className="h-4.5 w-4.5" />
          </button>
          <button
            onClick={() => {
              const v = videoRef.current
              if (!v) return
              v.muted = !v.muted
              setMuted(v.muted)
            }}
            className="rounded p-1 hover:bg-white/15"
            title="静音 (M)"
          >
            {muted || vol === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
          <input
            type="range"
            className="player w-20"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : vol}
            onChange={(e) => changeVol(Number(e.target.value))}
          />
          <select
            value={speed}
            onChange={(e) => {
              const x = Number(e.target.value)
              setSpeed(x)
              if (videoRef.current) videoRef.current.playbackRate = x
            }}
            className="rounded bg-white/10 px-1 py-0.5 text-xs outline-none [&>option]:text-black"
            title="倍速"
          >
            {SPEEDS.map((x) => (
              <option key={x} value={x}>
                {x}x
              </option>
            ))}
          </select>
          <button onClick={screenshot} className="rounded p-1 hover:bg-white/15" title="截图">
            <Camera className="h-4.5 w-4.5" />
          </button>
          {document.pictureInPictureEnabled && (
            <button
              onClick={() => {
                const v = videoRef.current
                if (document.pictureInPictureElement) void document.exitPictureInPicture()
                else void v?.requestPictureInPicture().catch(() => {})
              }}
              className="rounded p-1 hover:bg-white/15"
              title="画中画"
            >
              <PictureInPicture2 className="h-4.5 w-4.5" />
            </button>
          )}
          <button onClick={() => void toggleFullscreen()} className="rounded p-1 hover:bg-white/15" title="全屏 (F)">
            {fullscreen ? <Minimize className="h-4.5 w-4.5" /> : <Maximize className="h-4.5 w-4.5" />}
          </button>
        </div>
      </div>
    </div>
  )
}
