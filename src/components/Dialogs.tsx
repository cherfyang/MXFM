import { useEffect, useRef, useState } from 'react'
import { useUi } from '../stores/ui'
import { useFs } from '../stores/fs'
import { thumbCacheStats } from './FileList'
import { Btn } from './ui'

export function Dialogs() {
  const dialog = useUi((s) => s.dialog)
  if (!dialog) return null

  if (dialog.type === 'confirm') return <ConfirmDialog {...dialog} />
  if (dialog.type === 'prompt') return <PromptDialog {...dialog} />
  if (dialog.type === 'memory') return <MemoryDialog />
  return <ConflictDialog {...dialog} />
}

function Shell({ children, title, onClose }: { children: React.ReactNode; title: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="mx-fade w-[min(400px,calc(100vw-24px))] rounded-xl border border-brd bg-panel p-5 shadow-2xl shadow-black/30">
        <div className="mb-3 text-[15px] font-semibold">{title}</div>
        {children}
      </div>
    </div>
  )
}

function ConfirmDialog(props: Extract<NonNullable<ReturnType<typeof useUi.getState>['dialog']>, { type: 'confirm' }>) {
  return (
    <Shell title={props.title} onClose={() => useUi.getState().closeDialog()}>
      <div className="mb-5 whitespace-pre-wrap text-sm text-txt2">{props.message}</div>
      <div className="flex justify-end gap-2">
        <Btn onClick={() => useUi.getState().closeDialog()}>取消</Btn>
        <Btn
          variant={props.danger ? 'danger' : 'primary'}
          onClick={() => {
            props.onOk()
          }}
        >
          {props.okText ?? '确定'}
        </Btn>
      </div>
    </Shell>
  )
}

function PromptDialog(props: Extract<NonNullable<ReturnType<typeof useUi.getState>['dialog']>, { type: 'prompt' }>) {
  const [value, setValue] = useState(props.initial)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const dot = props.initial.lastIndexOf('.')
    inputRef.current?.setSelectionRange(0, dot > 0 ? dot : props.initial.length)
  }, [props.initial])

  const submit = () => {
    if (props.validate) {
      const msg = props.validate(value)
      if (msg) {
        setErr(msg)
        return
      }
    }
    props.onOk(value)
  }

  return (
    <Shell title={props.title} onClose={() => useUi.getState().closeDialog()}>
      <div className="mb-5">
        <label className="mb-1.5 block text-sm text-txt2">{props.label}</label>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setErr(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          className="h-9 w-full rounded-md border border-brd bg-panel2 px-2.5 text-sm outline-none focus:border-acc"
        />
        {err && <div className="mt-1.5 text-xs text-danger">{err}</div>}
      </div>
      <div className="flex justify-end gap-2">
        <Btn onClick={() => useUi.getState().closeDialog()}>取消</Btn>
        <Btn variant="primary" onClick={submit}>
          {props.okText ?? '确定'}
        </Btn>
      </div>
    </Shell>
  )
}

function ConflictDialog(props: Extract<NonNullable<ReturnType<typeof useUi.getState>['dialog']>, { type: 'conflict' }>) {  const [mode, setMode] = useState<'overwrite' | 'skip' | 'keepBoth'>('keepBoth')
  const options = [
    { value: 'overwrite' as const, label: '覆盖', desc: '用源文件替换目标中的同名项目' },
    { value: 'skip' as const, label: '跳过', desc: '保留目标中的同名项目,不复制这些文件' },
    { value: 'keepBoth' as const, label: '保留两者', desc: '自动重命名为「名称 (2)」' },
  ]
  return (
    <Shell title="目标已存在同名项目" onClose={() => useUi.getState().closeDialog()}>
      <div className="mb-4 text-sm text-txt2">有 {props.count} 个同名项目,如何处理?</div>
      <div className="mb-5 space-y-1.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
              mode === o.value ? 'border-acc bg-sel/40' : 'border-brd hover:bg-hover'
            }`}
          >
            <input
              type="radio"
              name="conflict"
              checked={mode === o.value}
              onChange={() => setMode(o.value)}
              className="mt-0.5 accent-[var(--acc)]"
            />
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-txt2">{o.desc}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Btn onClick={() => useUi.getState().closeDialog()}>取消</Btn>
        <Btn variant="primary" onClick={() => props.onChoose(mode)}>
          应用到全部
        </Btn>
      </div>
    </Shell>
  )
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function MemoryDialog() {
  const [rows, setRows] = useState<[string, string][] | null>(null)

  const collect = async () => {
    const out: [string, string][] = []
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    if (mem) {
      out.push(['渲染进程 JS 堆(已用)', fmtMB(mem.usedJSHeapSize)])
      out.push(['渲染进程 JS 堆(已分配)', fmtMB(mem.totalJSHeapSize)])
      out.push(['JS 堆上限', fmtMB(mem.jsHeapSizeLimit)])
    } else {
      out.push(['渲染进程 JS 堆', '当前环境不支持读取'])
    }
    const s = useFs.getState()
    out.push([
      '文件系统类型',
      s.provider?.kind === 'native' ? '本地磁盘(Electron)' : s.provider?.kind === 'memory' ? '演示数据(内存)' : '浏览器授权',
    ])
    const st = thumbCacheStats()
    out.push(['缩略图缓存', `${st.count} 张(上限 ${st.cap},自动 LRU 淘汰)`])
    out.push(['撤销栈', `${s.undoStack.length} / 50 条`])
    out.push(['打开的标签页', `${s.tabs.length} 个`])
    if (s.provider?.kind === 'native') {
      try {
        const m = await (s.provider as unknown as { mainMemory(): Promise<{ rss: number }> }).mainMemory()
        out.push(['主进程内存(RSS)', fmtMB(m.rss)])
      } catch {
        /* ignore */
      }
    }
    setRows(out)
  }

  useEffect(() => {
    void collect()
  }, [])

  return (
    <Shell title="内存占用诊断" onClose={() => useUi.getState().closeDialog()}>
      {!rows ? (
        <div className="py-6 text-center text-sm text-txt2">收集中…</div>
      ) : (
        <>
          <div className="mb-4 divide-y divide-brd rounded-lg border border-brd">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-txt2">{k}</span>
                <span className="font-medium">{v}</span>
              </div>
            ))}
          </div>
          <div className="mb-4 text-xs leading-relaxed text-txt2">
            缩略图与 blob 地址都会自动 LRU 淘汰 / 释放;视频音频走流式播放,不整体载入内存。
          </div>
          <div className="flex justify-end">
            <Btn onClick={() => void collect()}>重新测量</Btn>
          </div>
        </>
      )}
    </Shell>
  )
}
