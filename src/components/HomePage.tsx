import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  FileImage,
  Film,
  Music,
  FileText,
  FileArchive,
  BookOpen,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Home,
  Loader2,
  FolderOpen,
  Package,
  Play,
  Trash2,
  AlertTriangle,
} from 'lucide-react'
import { useScan, SCAN_GROUPS, type ScanGroup } from '../stores/scan'
import { useFs } from '../stores/fs'
import { useApps, type AppEntry } from '../stores/apps'
import { useUi } from '../stores/ui'
import { fmtBytes, fmtDate } from '../utils/format'
import { categoryOf } from '../utils/categories'
import { EntryIcon } from './Icons'
import { Btn } from './ui'
import { nativeAppMeta } from '../fs/electron'
import { parentOf } from '../utils/path'
import type { FileEntry } from '../fs/types'

const GROUP_STYLE: Record<ScanGroup, { icon: typeof FileImage; cls: string }> = {
  图片: { icon: FileImage, cls: 'text-emerald-500 bg-emerald-500/10' },
  视频: { icon: Film, cls: 'text-violet-400 bg-violet-400/10' },
  音频: { icon: Music, cls: 'text-pink-400 bg-pink-400/10' },
  文档: { icon: FileText, cls: 'text-sky-400 bg-sky-400/10' },
  压缩包: { icon: FileArchive, cls: 'text-amber-400 bg-amber-400/10' },
  电子书: { icon: BookOpen, cls: 'text-teal-400 bg-teal-400/10' },
}

/** 相对时间:主页与应用程序区块共用 */
function fmtTimeAgo(ts: number | null): string {
  if (!ts) return '从未扫描'
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return fmtDate(ts)
}

export function HomePage() {
  const scan = useScan()
  const s = useFs()
  // 分类展开状态存 scan store(而非组件 useState):打开文件预览会卸载主页组件,
  // 关闭预览返回时靠 store 恢复到原来的分类列表
  const openGroup = scan.openGroup
  const setOpenGroup = scan.setOpenGroup

  // 启动自动更新:数据缺失或距上次扫描超过 30 分钟时自动重扫
  useEffect(() => {
    const stale = !scan.lastScanAt || Date.now() - scan.lastScanAt > 30 * 60 * 1000
    if (stale && !scan.running) void scan.scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recents = useMemo(() => {
    const all: FileEntry[] = []
    for (const g of Object.values(scan.groups)) all.push(...g.recent)
    return all.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).slice(0, 20)
  }, [scan.groups])

  const open = (e: FileEntry) => s.openEntry(e)

  if (openGroup) {
    return <GroupList group={openGroup} onBack={() => setOpenGroup(null)} onOpen={open} />
  }

  const totalFiles = Object.values(scan.groups).reduce((a, g) => a + g.count, 0)
  const pct = scan.running ? Math.min(95, Math.round((scan.scannedDirs / 300) * 100)) : 100

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        {/* 头部 */}
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-acc text-white">
            <Home className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold">主页</div>
            <div className="text-xs text-txt2">
              {scan.running
                ? `正在扫描本机文件… 已检查 ${scan.scannedDirs} 个文件夹`
                : `共发现 ${totalFiles.toLocaleString()} 个媒体/文档文件 · 上次扫描:${fmtTimeAgo(scan.lastScanAt)}`}
            </div>
          </div>
          <button
            onClick={() => void scan.scan()}
            disabled={scan.running}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-acc px-4 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {scan.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {scan.running ? '扫描中' : '重新扫描'}
          </button>
        </div>

        {scan.running && (
          <div className="mb-6 h-1.5 overflow-hidden rounded-full bg-panel2">
            <div className="h-full rounded-full bg-acc transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}

        {/* 分类卡片 */}
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {SCAN_GROUPS.map(({ name }) => {
            const g = scan.groups[name]
            const { icon: Icon, cls } = GROUP_STYLE[name]
            return (
              <button
                key={name}
                onClick={() => g.count > 0 && setOpenGroup(name)}
                className={`flex flex-col items-start gap-2 rounded-xl border border-brd bg-panel p-4 text-left transition-all ${
                  g.count > 0 ? 'hover:border-acc hover:shadow-md' : 'opacity-60'
                }`}
              >
                <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${cls}`}>
                  <Icon className="h-5.5 w-5.5" />
                </span>
                <span className="mt-1 w-full truncate text-xl font-semibold tabular-nums">{g.count.toLocaleString()}</span>
                <span className="flex w-full items-center justify-between text-xs text-txt2">
                  <span>{name}</span>
                  <span>{g.count > 0 ? fmtBytes(g.size) : '—'}</span>
                </span>
              </button>
            )
          })}
        </div>

        <AppSection />

        {/* 最近文件 */}
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium">最近文件</div>
          <div className="text-xs text-txt2">来自上次扫描,点击直接打开</div>
        </div>
        <div className="overflow-hidden rounded-xl border border-brd bg-panel">
          {recents.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-txt2">
              <FolderOpen className="h-8 w-8 opacity-40" />
              <div className="text-sm">{scan.running ? '扫描完成后显示' : '还没有扫描结果,点击右上角「重新扫描」'}</div>
            </div>
          ) : (
            recents.map((e, i) => (
              <div
                key={e.path}
                onClick={() => open(e)}
                className={`flex cursor-default items-center gap-3 px-4 py-2.5 hover:bg-hover ${i > 0 ? 'border-t border-brd' : ''}`}
                title={e.path}
              >
                <EntryIcon category={categoryOf(e)} className="h-5 w-5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{e.name}</span>
                  <span className="block truncate text-[11px] text-txt2">{parentOf(e.path)}</span>
                </span>
                <span className="shrink-0 text-xs text-txt2">{fmtBytes(e.size)}</span>
                <span className="w-[110px] shrink-0 text-right text-xs text-txt2">{fmtDate(e.modified)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ 应用程序分类 ------------------------------ */

/** 首屏最多渲染的应用数,超出显示「查看全部」 */
const APP_PAGE = 60

/**
 * 图标 dataURL 缓存(key = iconPath,value 为 null 表示取过但失败)。
 * 挂在模块级而非组件里:主页打开预览会卸载组件,回来时不该重新打一遍 IPC。
 */
const iconCache = new Map<string, string | null>()
/** 全局并发上限:上百个应用若不限流,会在挂载瞬间打出上百个 execIcon */
const ICON_CONCURRENCY = 6
const iconQueue: (() => void)[] = []
const iconInflight = new Map<string, Promise<string | null>>()
let iconActive = 0

function pumpIconQueue() {
  while (iconActive < ICON_CONCURRENCY) {
    const job = iconQueue.shift()
    if (!job) return
    iconActive++
    job()
  }
}

/** 取应用图标:命中缓存直接返回,否则排队(并发 6);失败记 null,不再重试 */
function loadAppIcon(path: string): Promise<string | null> {
  const cached = iconCache.get(path)
  if (cached !== undefined) return Promise.resolve(cached)
  const inflight = iconInflight.get(path)
  if (inflight) return inflight
  const p = new Promise<string | null>((resolve) => {
    iconQueue.push(() => {
      const done = (v: string | null) => {
        iconCache.set(path, v)
        iconInflight.delete(path)
        iconActive--
        pumpIconQueue()
        resolve(v)
      }
      const meta = nativeAppMeta()
      if (!meta) return done(null)
      meta.execIcon({ path, size: 'large' }).then((v) => done(v ?? null), () => done(null))
    })
  })
  iconInflight.set(path, p)
  pumpIconQueue()
  return p
}

/** 单个应用图标:加载中 / 取不到都用通用图标占位,避免卡片抖动 */
function AppIcon({ path }: { path?: string }) {
  const [url, setUrl] = useState<string | null>(() => (path ? iconCache.get(path) ?? null : null))
  useEffect(() => {
    if (!path) {
      setUrl(null)
      return
    }
    const cached = iconCache.get(path)
    if (cached !== undefined) {
      setUrl(cached)
      return
    }
    let alive = true
    setUrl(null)
    void loadAppIcon(path).then((v) => {
      if (alive) setUrl(v)
    })
    return () => {
      alive = false
    }
  }, [path])

  if (url) return <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-lg" />
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-acc/10 text-acc">
      <Package className="h-5 w-5" />
    </div>
  )
}

function AppCard({ app }: { app: AppEntry }) {
  // Windows 走主进程原生确认框,渲染层不画二次确认;mac 的「移到废纸篓」没有原生框,
  // 且是破坏性操作,必须由 UI 补一次确认
  const uninstall = () => {
    if (!app.uninstall) return
    if (app.uninstall === 'moveToTrash') {
      useUi.getState().showDialog({
        type: 'confirm',
        title: '移到废纸篓',
        message: `确定要将「${app.name}」移到废纸篓吗?\n\n这不会运行卸载程序,只是把整个应用移到废纸篓。移走后可从废纸篓还原,但清空废纸篓后不可恢复。`,
        danger: true,
        okText: '移到废纸篓',
        onOk: () => void useApps.getState().uninstall(app),
      })
      return
    }
    void useApps.getState().uninstall(app)
  }

  const sub = [app.version, app.publisher].filter(Boolean).join(' · ')
  const canUninstall = !!app.uninstall
  return (
    <div
      className="group flex flex-col gap-2 rounded-xl border border-brd bg-panel p-3 transition-all hover:border-acc hover:shadow-md"
      title={[app.name, app.version, app.publisher, app.installDate && `安装日期 ${app.installDate}`]
        .filter(Boolean)
        .join('\n')}
    >
      <div className="flex items-center gap-2.5">
        <AppIcon path={app.iconPath} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-tight">{app.name}</div>
          <div className="truncate text-[11px] leading-[15px] text-txt2">{sub}</div>
        </div>
      </div>
      {/* 悬浮/键盘聚焦才展开操作,避免误点启动程序 */}
      <div className="flex h-8 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Btn
          className="flex-1 px-2"
          disabled={!app.path}
          title={app.path ? `启动 ${app.name}` : '该程序未提供启动路径'}
          onClick={() => void useApps.getState().launch(app)}
        >
          <Play className="h-3.5 w-3.5" /> 启动
        </Btn>
        <Btn
          variant="danger"
          className="flex-1 px-2"
          disabled={!canUninstall}
          title={
            !canUninstall
              ? '该程序不支持卸载'
              : app.uninstall === 'moveToTrash'
                ? `将「${app.name}」移到废纸篓`
                : `卸载 ${app.name}`
          }
          onClick={uninstall}
        >
          <Trash2 className="h-3.5 w-3.5" /> 卸载
        </Btn>
      </div>
    </div>
  )
}

function AppSection() {
  const items = useApps((s) => s.items)
  const loading = useApps((s) => s.loading)
  const error = useApps((s) => s.error)
  const lastScanAt = useApps((s) => s.lastScanAt)
  const [showAll, setShowAll] = useState(false)

  // 首次挂载扫一次:不 force,5 分钟内的缓存直接复用
  useEffect(() => {
    void useApps.getState().scan()
  }, [])

  const rescan = () => void useApps.getState().scan(true)
  const shown = showAll ? items : items.slice(0, APP_PAGE)

  return (
    <div className="mb-8">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium">应用程序</span>
          <span className="truncate text-xs text-txt2">
            {loading && !items.length
              ? '正在读取已安装程序…'
              : items.length
                ? `${items.length} 个 · ${fmtTimeAgo(lastScanAt)}`
                : ''}
          </span>
        </div>
        <Btn onClick={rescan} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? '扫描中' : '重新扫描'}
        </Btn>
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-brd bg-panel py-8">
          <AlertTriangle className="h-8 w-8 text-amber-500 opacity-70" />
          <div className="max-w-[85%] text-center text-[13px] text-txt2">{error}</div>
          <Btn variant="primary" onClick={rescan} disabled={loading}>
            重试
          </Btn>
        </div>
      ) : loading && !items.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl border border-brd bg-panel p-3">
              <div className="flex items-center gap-2.5">
                <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-panel2" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-panel2" />
                  <div className="h-2.5 w-1/2 animate-pulse rounded bg-panel2" />
                </div>
              </div>
              <div className="h-8 animate-pulse rounded-md bg-panel2" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-brd bg-panel py-10 text-txt2">
          <Package className="h-8 w-8 opacity-40" />
          <div className="text-sm">未发现已安装程序(浏览器版不支持)</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {shown.map((a) => (
              <AppCard key={a.id} app={a} />
            ))}
          </div>
          {items.length > APP_PAGE && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg border border-brd bg-panel py-2 text-[13px] text-txt2 hover:bg-hover hover:text-txt"
            >
              {showAll ? (
                <>
                  <ChevronUp className="h-4 w-4" /> 收起
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4" /> 查看全部 {items.length} 个应用
                </>
              )}
            </button>
          )}
        </>
      )}
    </div>
  )
}

type GroupSort = 'time' | 'size' | 'name'

const GROUP_SORTS: { id: GroupSort; label: string }[] = [
  { id: 'time', label: '修改时间' },
  { id: 'size', label: '大小' },
  { id: 'name', label: '文件名' },
]

function GroupList({ group, onBack, onOpen }: { group: ScanGroup; onBack(): void; onOpen(e: FileEntry): void }) {
  const scan = useScan()
  const [sort, setSort] = useState<GroupSort>('time')
  const items = useMemo(() => {
    const list = [...scan.groups[group].recent]
    if (sort === 'time') list.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
    else if (sort === 'size') list.sort((a, b) => b.size - a.size)
    else list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    return list
  }, [scan.groups, group, sort])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 20,
  })
  const { icon: Icon, cls } = GROUP_STYLE[group]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-brd bg-panel px-3">
        <button onClick={onBack} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-txt2 hover:bg-hover hover:text-txt">
          <Home className="h-4 w-4" /> 主页
        </button>
        <ChevronRight className="h-4 w-4 text-txt2" />
        <span className={`flex h-7 w-7 items-center justify-center rounded-md ${cls}`}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">{group}</span>
        <span className="text-xs text-txt2">
          {scan.groups[group].count.toLocaleString()} 个 · {fmtBytes(scan.groups[group].size)} · 显示最近 {items.length} 个
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-xs text-txt2">排序</span>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as GroupSort)}
          className="h-7 rounded-md bg-panel2 px-1.5 text-xs outline-none [&>option]:text-black"
          title="列表排序"
        >
          {GROUP_SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => {
            const e = items[vi.index]
            return (
              <div
                key={e.path}
                onClick={() => onOpen(e)}
                className="absolute left-0 top-0 flex w-full cursor-default items-center gap-3 px-5 hover:bg-hover"
                style={{ height: 44, transform: `translateY(${vi.start}px)` }}
                title={e.path}
              >
                <EntryIcon category={categoryOf(e)} />
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{e.name}</span>
                <span className="hidden min-w-0 max-w-[45%] flex-1 truncate text-[11px] text-txt2 sm:block">
                  {parentOf(e.path)}
                </span>
                <span className="shrink-0 text-xs text-txt2">{fmtBytes(e.size)}</span>
                <span className="w-[100px] shrink-0 text-right text-xs text-txt2">{fmtDate(e.modified)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
