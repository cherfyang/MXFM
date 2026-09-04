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
  Subtitles,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import type { ViewerProps } from './registry'
import { useBlobUrl } from './registry'
import { fmtTime } from './playerUtil'
import { TranscodeOverlay, VIDEO_NEED_TRANSCODE, transcodeAvailable } from './TranscodeOverlay'
import { srtToVtt } from './subtitle'
import { parentOf } from '../utils/path'
import { useFs } from '../stores/fs'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const VOL_KEY = 'mx-vp-volume'
const SPEED_KEY = 'mx-vp-speed'

/**
 * 可拖动进度条:pointerdown 即拖即生效(setPointerCapture 后移出条外也持续跟踪),
 * 悬停显示时间气泡;带缓冲进度。点击(=按下即抬起)与拖动是同一条路径。
 */
function SeekBar({
  duration,
  time,
  buffered,
  onSeek,
}: {
  duration: number
  time: number
  buffered: number
  onSeek(t: number): void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [hoverPct, setHoverPct] = useState<number | null>(null)
  // 拖动期间 onSeek 会同步 setTime,所以进度直接读 time 即可,无需单独的拖动态时间
  const pct = duration > 0 ? (time / duration) * 100 : 0
  const bufPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0

  const timeAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || !duration) return 0
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration))
  }

  return (
    <div
      ref={barRef}
      className="group relative flex h-4 cursor-pointer items-center touch-none select-none"
      onPointerDown={(e) => {
        if (!duration) return
        // 捕获指针:按下后拖出进度条范围仍持续收到 move/up,实现真正的拖动
        e.currentTarget.setPointerCapture(e.pointerId)
        const t = timeAt(e.clientX)
        setDragging(true)
        onSeek(t)
        // 拖动期间挂实时跟踪:move 即 seek
        const onMove = (ev: PointerEvent) => onSeek(timeAt(ev.clientX))
        const onUp = () => {
          setDragging(false)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }}
      onPointerMove={(e) => {
        const rect = barRef.current?.getBoundingClientRect()
        if (rect && duration) setHoverPct((e.clientX - rect.left) / rect.width)
      }}
      onPointerLeave={() => setHoverPct(null)}
    >
      <div className="relative h-1 w-full rounded bg-white/20 transition-all group-hover:h-1.5">
        {/* 缓冲进度 */}
        <div className="absolute left-0 top-0 h-full rounded bg-white/25" style={{ width: `${bufPct}%` }} />
        {/* 播放进度 */}
        <div className="absolute left-0 top-0 h-full rounded bg-acc" style={{ width: `${pct}%` }} />
        {/* 拖动手柄:悬停/拖动时放大 */}
        <div
          className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${
            dragging ? 'scale-125' : 'scale-0 group-hover:scale-100'
          }`}
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
      {/* 悬停时间气泡 */}
      {hoverPct !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute bottom-5 -translate-x-1/2 rounded bg-black/85 px-1.5 py-0.5 text-[11px] tabular-nums text-white"
          style={{ left: `${Math.min(96, Math.max(4, hoverPct * 100))}%` }}
        >
          {fmtTime(hoverPct * duration)}
        </div>
      )}
    </div>
  )
}

export function VideoViewer({ entry, nav }: ViewerProps) {
  const url = useBlobUrl(entry)
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [vol, setVol] = useState(() => {
    const v = Number(localStorage.getItem(VOL_KEY))
    return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1
  })
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(() => {
    const v = Number(localStorage.getItem(SPEED_KEY))
    return SPEEDS.includes(v) ? v : 1
  })
  const [loop, setLoop] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const hideTimer = useRef<number | null>(null)
  const [overrideUrl, setOverrideUrl] = useState<string | null>(null)
  const [forcedTranscode, setForcedTranscode] = useState(false)
  // 外挂字幕:blob URL + 开关 + .ass 提示
  const [subUrl, setSubUrl] = useState<string | null>(null)
  const [subOn, setSubOn] = useState(true)
  const [assHint, setAssHint] = useState(false)

  const posKey = `mx-vp:${entry.path}`

  useEffect(() => {
    setReady(false)
    setErr(false)
    setTime(0)
    setDuration(0)
    setBuffered(0)
    setOverrideUrl(null)
    setForcedTranscode(false)
    setSubOn(true)
  }, [entry.path])

  // 同目录找外挂字幕:同名 .vtt > 同名 .srt > 目录内唯一的 .vtt/.srt
  useEffect(() => {
    let alive = true
    let blobUrl: string | null = null
    setSubUrl(null)
    setAssHint(false)
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const siblings = await provider.list(parentOf(entry.path))
        if (!alive) return
        const files = siblings.filter((e) => e.kind === 'file')
        const stem = entry.name.replace(/\.[^.]+$/, '').toLowerCase()
        const sameName = (ext: string) => files.find((f) => f.name.toLowerCase() === `${stem}.${ext}`)
        const onlyOne = (ext: string) => {
          const hits = files.filter((f) => f.name.toLowerCase().endsWith(`.${ext}`))
          return hits.length === 1 ? hits[0] : undefined
        }
        const pick = sameName('vtt') ?? sameName('srt') ?? onlyOne('vtt') ?? onlyOne('srt')
        if (pick) {
          const raw = await (await provider.getFile(pick.path)).text()
          if (!alive) return
          const vtt = pick.name.toLowerCase().endsWith('.vtt') ? raw.replace(/^\uFEFF/, '') : srtToVtt(raw)
          blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
          if (alive) setSubUrl(blobUrl)
        } else if (sameName('ass') || sameName('ssa')) {
          if (alive) setAssHint(true)
        }
      } catch {
        /* list 失败(权限等)静默跳过,不影响播放 */
      }
    })()
    return () => {
      alive = false
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
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

  // 自动播放 + 恢复进度 + 应用记忆的音量/倍速
  useEffect(() => {
    if (!url || !ready) return
    const v = videoRef.current
    if (!v) return
    v.volume = vol
    v.muted = muted
    v.playbackRate = speed
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

  // 挂载字幕 track:手动 createElement 追加(JSX 动态 <track> 在部分内核不触发加载,手动插入时机可控);
  // src 来源(原始 blob/流式 URL 或转码输出 URL)无关,video 元素出现即可挂
  useEffect(() => {
    const v = videoRef.current
    if (!v || !subUrl) return
    const el = document.createElement('track')
    el.kind = 'subtitles'
    el.label = '字幕'
    el.srclang = 'zh'
    el.default = true
    el.src = subUrl
    v.appendChild(el)
    const sync = () => {
      if (v.textTracks[0]) v.textTracks[0].mode = subOn ? 'showing' : 'hidden'
    }
    el.addEventListener('load', sync)
    sync()
    return () => {
      el.removeEventListener('load', sync)
      el.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subUrl, url, overrideUrl, subOn])

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
    if (Number.isFinite(t)) v.currentTime = t
    setTime(t)
  }

  const changeVol = (x: number) => {
    const v = videoRef.current
    if (!v) return
    v.volume = x
    v.muted = x === 0
    setVol(x)
    setMuted(x === 0)
    try {
      localStorage.setItem(VOL_KEY, String(x))
    } catch {
      /* ignore */
    }
  }

  const changeSpeed = (x: number) => {
    setSpeed(x)
    if (videoRef.current) videoRef.current.playbackRate = x
    try {
      localStorage.setItem(SPEED_KEY, String(x))
    } catch {
      /* ignore */
    }
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
            setErr(false) // 转码产物可播时必须清掉错误遮罩,否则盖住视频且按钮死循环
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
          onDoubleClick={() => void toggleFullscreen()}
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
          onProgress={(e) => {
            const v = e.currentTarget
            try {
              if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1))
            } catch {
              /* ignore */
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

      {assHint && (
        <div className="absolute right-3 top-3 z-10 rounded-md bg-black/60 px-2 py-1 text-xs text-white/85">
          检测到 .ass/.ssa 字幕,暂不支持
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
        <SeekBar duration={duration} time={time} buffered={buffered} onSeek={seek} />
        <div className="mt-1 flex items-center gap-2 text-white">
          <button onClick={togglePlay} className="rounded p-1 hover:bg-white/15" title="播放/暂停 (空格)">
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
          {nav && (
            <>
              <button onClick={() => nav.onNav(-1)} className="rounded p-1 hover:bg-white/15" title="上一个">
                <SkipBack className="h-4.5 w-4.5" />
              </button>
              <button onClick={() => nav.onNav(1)} className="rounded p-1 hover:bg-white/15" title="下一个">
                <SkipForward className="h-4.5 w-4.5" />
              </button>
            </>
          )}
          <span className="text-xs tabular-nums text-white/85">
            {fmtTime(time)} / {fmtTime(duration)}
          </span>
          <span className="flex-1" />
          <button onClick={() => setLoop((l) => !l)} className={`rounded p-1 hover:bg-white/15 ${loop ? 'text-acc' : ''}`} title="循环播放">
            <Repeat className="h-4.5 w-4.5" />
          </button>
          {subUrl && (
            <button
              onClick={() => setSubOn((s) => !s)}
              className={`rounded p-1 hover:bg-white/15 ${subOn ? 'text-acc' : 'text-white/50'}`}
              title="字幕开关"
            >
              <Subtitles className="h-4.5 w-4.5" />
            </button>
          )}
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
            onChange={(e) => changeSpeed(Number(e.target.value))}
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
