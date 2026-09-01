import { useEffect, useRef, useState } from 'react'
import { X, RotateCcw, Trash2, Loader2 } from 'lucide-react'
import { useUi } from '../stores/ui'
import { useFs } from '../stores/fs'
import { useTrash } from '../stores/trash'
import { fmtBytes, fmtDate } from '../utils/format'
import { thumbCacheStats } from './FileList'
import { Btn } from './ui'

export function Dialogs() {
  const dialog = useUi((s) => s.dialog)
  if (!dialog) return null

  if (dialog.type === 'confirm') return <ConfirmDialog {...dialog} />
  if (dialog.type === 'prompt') return <PromptDialog {...dialog} />
  if (dialog.type === 'memory') return <MemoryDialog />
  if (dialog.type === 'shortcuts') return <ShortcutsDialog />
  if (dialog.type === 'trash') return <TrashDialog />
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

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

/** 平台差异标注:两个值不同时按平台显示 */
const K = (win: string, mac: string) => (win === mac ? win : `${win} / ${mac}`)

const SHORTCUT_GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: '导航与定位',
    rows: [
      [K('Alt+← / Alt+→', '⌥← / ⌥→'), '后退 / 前进'],
      [K('Backspace', '⌘↑ 或 Backspace'), '上一级'],
      [K('Alt+Home', '⌘⇧H'), '回到主页'],
      [K('Ctrl+L', '⌘L / ⌘⇧G'), '编辑当前路径'],
      [K('Ctrl+F', '⌘F'), '搜索当前目录'],
      ['Esc', '后退:菜单 → 预览 → 查看器 → 清除选择'],
    ],
  },
  {
    title: '文件操作',
    rows: [
      [K('Ctrl+C / X / V', '⌘C / ⌘X / ⌘V'), '复制 / 剪切 / 粘贴'],
      [K('Ctrl+D', '⌘D'), '复制副本(原地生成「名称 (2)」)'],
      [K('Ctrl+Z', '⌘Z'), '撤销'],
      [K('Ctrl+Shift+Z 或 Ctrl+Y', '⌘⇧Z'), '重做'],
      ['F2', '重命名'],
      [K('Delete', 'Delete'), '删除(进回收站/废纸篓)'],
      [K('Shift+Delete', '⌘⌫'), '彻底删除(不进回收站)'],
      [K('Ctrl+Shift+N', '⌘⇧N'), '新建文件夹'],
      [K('Ctrl+N', '⌘N'), '新建文本文档'],
      ['Enter / Space', '打开 / 快速预览'],
      [K('Ctrl+O', '⌘O'), '用系统默认程序打开'],
      [K('Ctrl+Shift+R', '⌘⇧R'), '在资源管理器 / Finder 中显示'],
      [K('Ctrl+Shift+.', '⌘⇧.'), '显示 / 隐藏文件'],
      ['F5', '刷新(主页 = 重新扫描)'],
    ],
  },
  {
    title: '标签页与视图',
    rows: [
      [K('Alt+T', '⌥T'), '新建标签页'],
      [K('Ctrl+W', '⌘W'), '关闭当前标签页'],
      [K('Ctrl+Tab / Ctrl+Shift+Tab', '⌘⇧] / ⌘⇧['), '下一个 / 上一个标签页'],
      [K('Alt+1 ~ Alt+9', '⌘1 ~ ⌘9'), '跳转到第 N 个标签页'],
      [K('Ctrl+1 / Ctrl+2', '—'), '详细列表 / 大图标视图'],
      [K('Ctrl+,', '⌘,'), '更多选项菜单'],
    ],
  },
  {
    title: '查看器内',
    rows: [
      ['Space / ← / → / ↑ / ↓', '视频:播放暂停 / 快进快退 / 音量'],
      ['F / M', '视频:全屏 / 静音(Esc 退出全屏)'],
      ['← / →', '图片 / EPUB:切换或翻页'],
      ['+ / − / 0', '图片:放大 / 缩小 / 复位'],
      ['R / Shift+R', '图片:顺 / 逆时针旋转'],
      ['↑ / ↓', '音频:音量'],
      [K('Ctrl+S', '⌘S'), '保存正在编辑的文件'],
    ],
  },
]

function ShortcutsDialog() {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useUi.getState().closeDialog()
      }}
    >
      <div className="mx-fade flex max-h-[85vh] w-[min(560px,calc(100vw-24px))] flex-col rounded-xl border border-brd bg-panel p-5 shadow-2xl shadow-black/30">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[15px] font-semibold">键盘快捷键</span>
          <span className="text-xs text-txt2">{isMac ? 'macOS' : 'Windows'} 键位</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title} className="mb-4">
              <div className="mb-1.5 text-xs font-medium text-txt2">{g.title}</div>
              <div className="divide-y divide-brd overflow-hidden rounded-lg border border-brd">
                {g.rows.map(([keys, desc]) => (
                  <div key={desc} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="text-sm">{desc}</span>
                    <span className="shrink-0 font-mono text-[11px] text-txt2">{keys}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <Btn variant="primary" onClick={() => useUi.getState().closeDialog()}>
            关闭
          </Btn>
        </div>
      </div>
    </div>
  )
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

/**
 * 回收站对话框(仅桌面版入口可见;浏览器/演示版打开时由 store 返回错误文案)。
 * 清空确认采用「按钮二次确认态」而非 ConfirmDialog:
 * ui store 的 dialog 是单一槽位(非队列),弹 confirm 会顶掉 trash 自身,确认后无法回到列表。
 */
function TrashDialog() {
  const trash = useTrash()
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  useEffect(() => {
    void useTrash.getState().load()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useUi.getState().closeDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 清空确认态 4 秒无操作自动退出,防误触
  useEffect(() => {
    if (!confirmEmpty) return
    const t = window.setTimeout(() => setConfirmEmpty(false), 4000)
    return () => window.clearTimeout(t)
  }, [confirmEmpty])

  const close = () => useUi.getState().closeDialog()

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const restorableOf = (ids: Iterable<string>) =>
    [...ids].filter((id) => trash.items.find((i) => i.id === id)?.restorable)

  const restoreIds = async (ids: string[]) => {
    const ok = restorableOf(ids)
    if (!ok.length) return
    await useTrash.getState().restore(ok) // store 内部 toast + load 刷新
    setChecked(new Set())
  }

  const doEmpty = async () => {
    await useTrash.getState().empty() // store 内部 toast + load 刷新
    setChecked(new Set())
    setConfirmEmpty(false)
  }

  const allChecked = trash.items.length > 0 && trash.items.every((i) => checked.has(i.id))
  const restorableChecked = restorableOf(checked)

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="mx-fade flex h-[min(420px,calc(100vh-48px))] w-[min(560px,calc(100vw-24px))] flex-col rounded-xl border border-brd bg-panel p-5 shadow-2xl shadow-black/30">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[15px] font-semibold">回收站</span>
          <button
            onClick={close}
            className="flex h-7 w-7 items-center justify-center rounded-md text-txt2 hover:bg-hover"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-txt2">
            <input
              type="checkbox"
              checked={allChecked}
              disabled={!trash.items.length}
              onChange={() => setChecked(allChecked ? new Set() : new Set(trash.items.map((i) => i.id)))}
              className="accent-[var(--acc)]"
            />
            全选
          </label>
          <span className="shrink-0 text-xs text-txt2">
            {checked.size ? `已选 ${checked.size} 项` : `共 ${trash.items.length} 项`}
          </span>
          <span className="flex-1" />
          <Btn disabled={!restorableChecked.length} onClick={() => void restoreIds(restorableChecked)}>
            <RotateCcw className="h-3.5 w-3.5" /> 还原选中
          </Btn>
          {confirmEmpty ? (
            <>
              <Btn onClick={() => setConfirmEmpty(false)}>取消</Btn>
              <Btn variant="danger" disabled={!trash.items.length} onClick={() => void doEmpty()}>
                确认清空?
              </Btn>
            </>
          ) : (
            <Btn variant="danger" disabled={!trash.items.length} onClick={() => setConfirmEmpty(true)}>
              <Trash2 className="h-3.5 w-3.5" /> 清空回收站
            </Btn>
          )}
        </div>

        <div
          className={`min-h-0 flex-1 divide-y divide-brd overflow-y-auto rounded-lg border border-brd ${
            trash.loading && trash.items.length ? 'opacity-50' : ''
          }`}
        >
          {trash.error ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-danger">
              {trash.error}
            </div>
          ) : trash.loading && !trash.items.length ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-txt2">
              <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : !trash.items.length ? (
            <div className="flex h-full items-center justify-center text-sm text-txt2">回收站是空的</div>
          ) : (
            trash.items.map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 px-3 py-2">
                <input
                  type="checkbox"
                  checked={checked.has(t.id)}
                  onChange={() => toggle(t.id)}
                  className="mt-0.5 shrink-0 accent-[var(--acc)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  {t.originalPath !== null && (
                    <div className="truncate text-xs text-txt2" title={t.originalPath}>
                      {t.originalPath}
                    </div>
                  )}
                  <div className="text-[11px] text-txt2">
                    {fmtBytes(t.size)} · 删除于 {fmtDate(t.deletedAt)}
                  </div>
                </div>
                <Btn
                  className="shrink-0"
                  disabled={!t.restorable}
                  title={t.restorable ? undefined : '原位置已不存在或不可写,无法还原'}
                  onClick={() => void restoreIds([t.id])}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> 还原
                </Btn>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
