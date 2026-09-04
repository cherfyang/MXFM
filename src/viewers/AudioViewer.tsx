import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, SkipBack, SkipForward, Loader2, Music } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useBlobUrl } from './registry'
import { fmtTime } from './playerUtil'
import { TranscodeOverlay, AUDIO_NEED_TRANSCODE, transcodeAvailable } from './TranscodeOverlay'

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

export function AudioViewer({ entry, nav }: ViewerProps) {
  const url = useBlobUrl(entry)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [vol, setVol] = useState(1)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [err, setErr] = useState(false)
  const [overrideUrl, setOverrideUrl] = useState<string | null>(null)
  const [forced, setForced] = useState(false)

  useEffect(() => {
    setTime(0)
    setErr(false)
    setOverrideUrl(null)
    setForced(false)
  }, [entry.path])

  // 键盘 ↑↓ 调节音量
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const next = Math.min(1, Math.max(0, +(vol + (e.key === 'ArrowUp' ? 0.1 : -0.1)).toFixed(2)))
      setVol(next)
      if (audioRef.current) audioRef.current.volume = next
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [vol])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  const pct = duration > 0 ? (time / duration) * 100 : 0

  const nativeNeeds = !overrideUrl && transcodeAvailable() && AUDIO_NEED_TRANSCODE.has(entry.ext)
  if (nativeNeeds || forced) {
    return (
      <div className="relative h-full bg-app">
        <TranscodeOverlay
          entry={entry}
          kind="audio"
          auto={nativeNeeds}
          onReady={(u) => {
            setOverrideUrl(u)
            setForced(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center bg-app p-6">
      {url && <audio ref={audioRef} src={overrideUrl ?? url ?? undefined} onEnded={() => nav?.onNav(1)} onError={() => setErr(true)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />}

      <div className="w-full max-w-lg rounded-2xl border border-brd bg-panel p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-pink-400 to-violet-500 text-white">
            <Music className="h-8 w-8" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium">{entry.name}</div>
            <div className="text-xs text-txt2">
              {err && !transcodeAvailable() ? '无法解码该音频格式' : err && transcodeAvailable() ? '解码失败,可尝试转码' : duration > 0 ? fmtTime(duration) : '准备中…'}
            </div>
          </div>
        </div>

        <div
          className="mb-2 h-1.5 cursor-pointer rounded bg-panel2"
          onClick={(e) => {
            // currentTarget:内层已填充 div 也有命中面积,用 e.target 会取到部分宽度导致 seek 偏移
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            const t = ((e.clientX - rect.left) / rect.width) * duration
            if (audioRef.current) audioRef.current.currentTime = t
          }}
        >
          <div className="relative h-full rounded bg-acc" style={{ width: `${pct}%` }} />
        </div>
        <div className="mb-4 flex justify-between text-[11px] tabular-nums text-txt2">
          <span>{fmtTime(time)}</span>
          <span>{fmtTime(duration)}</span>
        </div>

        <div className="flex items-center justify-center gap-3">
          {nav && (
            <button onClick={() => nav.onNav(-1)} className="rounded-full p-2 text-txt hover:bg-hover" title="上一个">
              <SkipBack className="h-5 w-5" />
            </button>
          )}
          {err && transcodeAvailable() ? (
            <button
              onClick={() => setForced(true)}
              className="flex h-10 items-center gap-2 rounded-lg bg-acc px-4 text-sm text-white hover:opacity-90"
            >
              转码并播放
            </button>
          ) : (
            <button
              onClick={toggle}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-acc text-white shadow hover:opacity-90"
              title="播放/暂停"
            >
              {playing ? <Pause className="h-6 w-6" /> : <Play className="ml-0.5 h-6 w-6" />}
            </button>
          )}
          {nav && (
            <button onClick={() => nav.onNav(1)} className="rounded-full p-2 text-txt hover:bg-hover" title="下一个">
              <SkipForward className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="mt-5 flex items-center justify-center gap-3 text-txt2">
          <button
            onClick={() => {
              const a = audioRef.current
              if (!a) return
              a.muted = !a.muted
              setMuted(a.muted)
            }}
            className="rounded p-1 hover:bg-hover"
          >
            {muted || vol === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            className="player w-24"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : vol}
            onChange={(e) => {
              const x = Number(e.target.value)
              if (audioRef.current) {
                audioRef.current.volume = x
                audioRef.current.muted = x === 0
              }
              setVol(x)
              setMuted(x === 0)
            }}
          />
          <select
            value={speed}
            onChange={(e) => {
              const x = Number(e.target.value)
              setSpeed(x)
              if (audioRef.current) audioRef.current.playbackRate = x
            }}
            className="rounded bg-panel2 px-1 py-0.5 text-xs outline-none"
          >
            {SPEEDS.map((x) => (
              <option key={x} value={x}>
                {x}x
              </option>
            ))}
          </select>
        </div>
      </div>

      {!url && !err && (
        <div className="absolute inset-0 flex items-center justify-center bg-app/80">
          <Loader2 className="h-6 w-6 animate-spin text-txt2" />
        </div>
      )}
    </div>
  )
}
