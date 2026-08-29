import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, SkipBack, SkipForward, Loader2, Music } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useBlobUrl } from './registry'
import { fmtTime } from './playerUtil'

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

  useEffect(() => {
    setTime(0)
    setErr(false)
  }, [entry.path])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  const pct = duration > 0 ? (time / duration) * 100 : 0

  return (
    <div className="flex h-full items-center justify-center bg-app p-6">
      {url && <audio ref={audioRef} src={url} onEnded={() => nav?.onNav(1)} onError={() => setErr(true)}
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
              {err ? '无法解码该音频格式' : duration > 0 ? fmtTime(duration) : '准备中…'}
            </div>
          </div>
        </div>

        <div
          className="mb-2 h-1.5 cursor-pointer rounded bg-panel2"
          onClick={(e) => {
            const rect = (e.target as HTMLElement).getBoundingClientRect()
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
          <button
            onClick={toggle}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-acc text-white shadow hover:opacity-90"
            title="播放/暂停"
          >
            {playing ? <Pause className="h-6 w-6" /> : <Play className="ml-0.5 h-6 w-6" />}
          </button>
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
