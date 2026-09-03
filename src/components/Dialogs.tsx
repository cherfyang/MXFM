import { useEffect, useRef, useState } from 'react'
import { X, RotateCcw, Trash2, Loader2, ExternalLink, Monitor, AppWindow } from 'lucide-react'
import { useUi } from '../stores/ui'
import { useFs } from '../stores/fs'
import { useTrash } from '../stores/trash'
import { useSettings, normalizeExt, type OpenWithTarget } from '../stores/settings'
import { OPEN_WITH_CATEGORIES } from '../utils/categories'
import { fmtBytes, fmtDate } from '../utils/format'
import { thumbCacheStats } from './FileList'
import { Btn } from './ui'
import { GlobalSearchDialog } from './GlobalSearchDialog'

export function Dialogs() {
  const dialog = useUi((s) => s.dialog)
  if (!dialog) return null

  if (dialog.type === 'confirm') return <ConfirmDialog {...dialog} />
  if (dialog.type === 'prompt') return <PromptDialog {...dialog} />
  if (dialog.type === 'memory') return <MemoryDialog />
  if (dialog.type === 'shortcuts') return <ShortcutsDialog />
  if (dialog.type === 'trash') return <TrashDialog />
  if (dialog.type === 'execPolicy') return <ExecPolicyDialog />
  if (dialog.type === 'openWith') return <OpenWithDialog />
  if (dialog.type === 'globalSearch') return <GlobalSearchDialog />
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

/** 默认打开方式管理:按扩展名/按类型(视频、图片…)指定用内置查看器/系统默认/指定应用打开 */
function OpenWithDialog() {
  const st = useSettings()
  const fs = useFs()
  const [ext, setExt] = useState('')
  const close = () => useUi.getState().closeDialog()
  const provider = fs.provider
  const canPick = provider?.kind === 'native' && typeof provider.pickOpenWithApp === 'function'

  const setTarget = async (apply: (t: OpenWithTarget) => void, target: OpenWithTarget) => {
    if (target.kind === 'app') {
      if (!canPick) {
        useUi.getState().toast('当前环境不支持选择应用', 'error')
        return
      }
      try {
        const appPath = await provider.pickOpenWithApp!()
        if (!appPath) return
        const appName = appPath.replace(/\\/g, '/').split('/').pop() || appPath
        apply({ kind: 'app', appPath, appName })
      } catch (e) {
        useUi.getState().toast(String((e as Error).message || e), 'error')
      }
      return
    }
    apply(target)
  }

  const labelOf = (t: OpenWithTarget) => {
    if (t.kind === 'internal') return '内置查看器'
    if (t.kind === 'system') return '系统默认应用'
    return t.appName || t.appPath
  }

  const extEntries = Object.entries(st.openWith).sort(([a], [b]) => a.localeCompare(b))
  const catEntries = OPEN_WITH_CATEGORIES.map((g) => ({ ...g, target: st.openWithCategory[g.id] }))

  /** 按输入框里的扩展名添加;为空时提示 */
  const addByExt = (target: OpenWithTarget) => {
    const key = normalizeExt(ext)
    if (!key) {
      useUi.getState().toast('请输入有效的扩展名', 'error')
      return
    }
    void setTarget((t) => st.setOpenWith(key, t), target)
    setExt('')
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="mx-fade flex w-[min(560px,calc(100vw-24px))] flex-col rounded-xl border border-brd bg-panel shadow-2xl shadow-black/30"
        style={{ maxHeight: '76vh' }}
      >
        <div className="flex h-11 shrink-0 items-center border-b border-brd px-4">
          <span className="text-[15px] font-semibold">默认打开方式</span>
          <span className="flex-1" />
          <button onClick={close} className="rounded p-1.5 text-txt2 hover:bg-hover hover:text-txt" title="关闭 (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {/* 按类型:视频、图片等整体指定打开应用 */}
          <div className="mb-1.5 text-xs font-medium text-txt2">按类型配置(如:视频都用某个播放器打开)</div>
          {catEntries.map(({ id, label, target }) => (
            <TargetRow
              key={id}
              title={label}
              target={target}
              labelOf={labelOf}
              canPick={canPick}
              onSet={(t) => void setTarget((tt) => st.setOpenWithCategory(id, tt), t)}
              onReset={() => st.setOpenWithCategory(id, null)}
            />
          ))}

          {/* 按扩展名:精确到单个格式 */}
          <div className="mb-1.5 mt-4 text-xs font-medium text-txt2">按扩展名配置(优先级高于类型配置)</div>
          {extEntries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-brd py-6 text-center text-sm text-txt2">
              还没有按扩展名的自定义配置
              <br />
              <span className="text-xs opacity-70">右键文件 → 打开方式,可快速设置</span>
            </div>
          ) : (
            extEntries.map(([key, t]) => (
              <TargetRow
                key={key}
                title={key || '(无扩展名)'}
                mono
                target={t}
                labelOf={labelOf}
                canPick={canPick}
                onSet={(tt) => void setTarget((x) => st.setOpenWith(key, x), tt)}
                onReset={() => st.setOpenWith(key, null)}
              />
            ))
          )}
        </div>
        <div className="shrink-0 space-y-2 border-t border-brd p-3">
          <div className="flex items-center gap-2">
            <input
              value={ext}
              onChange={(e) => setExt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addByExt({ kind: 'system' })}
              placeholder=".txt"
              className="h-8 w-24 rounded-md border border-brd bg-panel2 px-2.5 text-sm outline-none focus:border-acc"
            />
            <span className="text-xs text-txt2">未配置的扩展名跟随类型配置,都没有则用内置查看器</span>
          </div>
          <div className="flex items-center gap-2">
            <Btn onClick={() => addByExt({ kind: 'internal' })}>添加为内置</Btn>
            <Btn onClick={() => addByExt({ kind: 'system' })}>添加为系统默认</Btn>
            <Btn onClick={() => addByExt({ kind: 'app', appPath: '', appName: '' })} disabled={!canPick}>
              添加为其他应用
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 一行「打开方式」配置:标题 + 当前目标 + 内置/系统/其他应用三按钮 + 删除 */
function TargetRow(props: {
  title: string
  mono?: boolean
  target: OpenWithTarget | undefined
  labelOf(t: OpenWithTarget): string
  canPick: boolean
  onSet(t: OpenWithTarget): void
  onReset(): void
}) {
  const { title, mono, target, labelOf, onSet, onReset } = props
  const t: OpenWithTarget = target ?? { kind: 'internal' }
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-brd px-3 py-2">
      <span className={`w-[132px] shrink-0 truncate text-sm ${mono ? 'font-mono' : ''}`} title={title}>
        {title}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium" title={labelOf(t)}>
          {target ? labelOf(t) : <span className="text-txt2">内置查看器(默认)</span>}
        </div>
        {t.kind === 'app' && target && (
          <div className="truncate text-[11px] text-txt2" title={t.appPath}>
            {t.appPath}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          title="内置查看器"
          onClick={() => onSet({ kind: 'internal' })}
          className={`flex h-7 w-7 items-center justify-center rounded-md ${
            target && t.kind === 'internal' ? 'bg-sel text-acc' : 'text-txt2 hover:bg-hover'
          }`}
        >
          <AppWindow className="h-4 w-4" />
        </button>
        <button
          title="系统默认应用"
          onClick={() => onSet({ kind: 'system' })}
          className={`flex h-7 w-7 items-center justify-center rounded-md ${
            target && t.kind === 'system' ? 'bg-sel text-acc' : 'text-txt2 hover:bg-hover'
          }`}
        >
          <Monitor className="h-4 w-4" />
        </button>
        <button
          title="选择其他应用…"
          onClick={() => onSet({ kind: 'app', appPath: '', appName: '' })}
          className={`flex h-7 w-7 items-center justify-center rounded-md ${
            target && t.kind === 'app' ? 'bg-sel text-acc' : 'text-txt2 hover:bg-hover'
          }`}
        >
          <ExternalLink className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-brd" />
        <button
          title="删除(恢复默认)"
          onClick={onReset}
          disabled={!target}
          className="flex h-7 w-7 items-center justify-center rounded-md text-txt2 hover:bg-hover hover:text-danger disabled:opacity-30"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/** 「已记住的可运行程序」管理对话框:列出 exec-policy,可逐条撤销 */
function ExecPolicyDialog() {
  const [items, setItems] = useState<{ path: string; allow: boolean; at: number }[] | null>(null)
  const close = () => useUi.getState().closeDialog()

  const reload = async () => {
    try {
      const { nativeLaunch } = await import('../fs/electron')
      const launch = nativeLaunch()
      if (!launch) {
        setItems([])
        return
      }
      setItems(await launch.execPolicyList())
    } catch {
      setItems([])
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const remove = async (path: string) => {
    try {
      const { nativeLaunch } = await import('../fs/electron')
      nativeLaunch()?.execPolicyReset(path)
    } finally {
      void reload()
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="mx-fade flex w-[min(560px,calc(100vw-24px))] flex-col rounded-xl border border-brd bg-panel shadow-2xl shadow-black/30" style={{ maxHeight: '70vh' }}>
        <div className="flex h-11 shrink-0 items-center border-b border-brd px-4">
          <span className="text-[15px] font-semibold">已记住的可运行程序</span>
          <span className="flex-1" />
          <button onClick={close} className="rounded p-1.5 text-txt2 hover:bg-hover hover:text-txt" title="关闭 (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {items === null ? (
            <div className="flex h-32 items-center justify-center text-txt2">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 读取中…
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-sm text-txt2">暂无记录 —— 运行程序时勾选「始终允许」后会出现在这里</div>
          ) : (
            items.map((p) => (
              <div key={p.path} className="mb-2 flex items-center gap-3 rounded-lg border border-brd px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[13px] ${p.allow ? '' : 'line-through opacity-60'}`} title={p.path}>
                    {p.path.split(/[\\/]/).pop()}
                  </div>
                  <div className="truncate font-mono text-[11px] text-txt2" title={p.path}>
                    {p.path}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-txt2">{fmtDate(p.at)}</span>
                <Btn className="shrink-0" onClick={() => void remove(p.path)}>
                  撤销
                </Btn>
              </div>
            ))
          )}
        </div>
        <div className="flex h-11 shrink-0 items-center justify-between border-t border-brd px-4">
          <span className="text-[11px] text-txt2">撤销后,下次运行该程序会重新弹确认框</span>
          {items !== null && items.length > 0 && (
            <Btn
              variant="danger"
              onClick={async () => {
                const { nativeLaunch } = await import('../fs/electron')
                nativeLaunch()?.execPolicyReset()
                void reload()
              }}
            >
              清空全部
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
}
