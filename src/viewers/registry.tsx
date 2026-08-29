import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Save, ExternalLink } from 'lucide-react'
import { useFs, registerSaveFn, type ViewedFile } from '../stores/fs'
import { categoryOf, EDITABLE_CATEGORIES, type Category } from '../utils/categories'
import { looksLikeText, fmtBytes } from '../utils/format'
import { EntryIcon } from '../components/Icons'
import { IconBtn } from '../components/ui'
import type { FileEntry } from '../fs/types'
import { TextViewer } from './TextViewer'
import { MarkdownViewer } from './MarkdownViewer'
import { ImageViewer } from './ImageViewer'
import { VideoViewer } from './VideoViewer'
import { AudioViewer } from './AudioViewer'
import { PdfViewer } from './PdfViewer'
import { CsvViewer } from './CsvViewer'
import { XlsxViewer } from './XlsxViewer'
import { DocxViewer } from './DocxViewer'
import { ZipViewer } from './ZipViewer'
import { HexViewer } from './HexViewer'

export interface ViewerApi {
  setDirty(dirty: boolean): void
  registerSave(fn: (() => Promise<void>) | null): void
}

export interface NavInfo {
  index: number
  total: number
  onNav(delta: number): void
}

export interface ViewerProps {
  entry: FileEntry
  readOnly: boolean
  api: ViewerApi
  nav?: NavInfo
}

/** 扩展名 + 二进制嗅探双重判断(改了扩展名也能正确打开) */
export async function resolveCategory(entry: FileEntry): Promise<Category> {
  const cat = categoryOf(entry)
  if (cat !== 'binary' || entry.kind !== 'file') return cat
  try {
    const provider = useFs.getState().provider
    if (!provider) return 'binary'
    const bytes = await provider.readBytes(entry.path, 0, 4096)
    return looksLikeText(bytes) ? 'text' : 'binary'
  } catch {
    return 'binary'
  }
}

const VIEWERS: Record<Category, React.ComponentType<ViewerProps>> = {
  folder: TextViewer,
  image: ImageViewer,
  video: VideoViewer,
  audio: AudioViewer,
  markdown: MarkdownViewer,
  pdf: PdfViewer,
  csv: CsvViewer,
  excel: XlsxViewer,
  word: DocxViewer,
  ppt: UnsupportedViewer,
  legacy: UnsupportedViewer,
  zip: ZipViewer,
  code: TextViewer,
  text: TextViewer,
  binary: HexViewer,
}

const CAT_LABEL: Record<Category, string> = {
  folder: '文件夹',
  image: '图片',
  video: '视频',
  audio: '音频',
  markdown: 'Markdown',
  pdf: 'PDF',
  csv: 'CSV',
  excel: 'Excel',
  word: 'Word',
  ppt: 'PowerPoint',
  legacy: '旧版 Office',
  zip: '压缩包',
  code: '代码',
  text: '文本',
  binary: '二进制',
}

function UnsupportedViewer({ entry }: ViewerProps) {
  const s = useFs()
  const native = s.provider?.kind === 'native'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-txt2">
      <div className="text-sm">{CAT_LABEL['legacy']}暂不支持内置预览</div>
      <div className="max-w-sm text-center text-xs leading-relaxed opacity-70">
        旧版二进制 Office 格式(.doc / .ppt 等)需要借助本机 Office / WPS 才能渲染
      </div>
      {native && (
        <button
          onClick={() => {
            s.provider!.openInSystem!(entry.path).catch((e) =>
              import('../stores/ui').then(({ useUi }) => useUi.getState().toast(e.message, 'error'))
            )
          }}
          className="mt-1 flex h-9 items-center gap-2 rounded-lg bg-acc px-4 text-sm text-white hover:opacity-90"
        >
          用系统默认程序打开
        </button>
      )}
    </div>
  )
}

export function ViewerHost({
  entry,
  category: catProp,
  readOnly = false,
  embedded = false,
  onBack,
}: {
  entry: FileEntry
  category: Category
  readOnly?: boolean
  embedded?: boolean
  onBack?(): void
}) {
  const s = useFs()
  const [cat, setCat] = useState<Category>(catProp)
  useEffect(() => {
    let alive = true
    resolveCategory(entry).then((c) => {
      if (alive) setCat(c)
    })
    return () => {
      alive = false
    }
  }, [entry.path, entry.kind, entry.ext])

  // 同类文件前后导航
  const nav: NavInfo | undefined = useMemo(() => {
    if (embedded) return undefined
    const tab = s.tabs.find((t) => t.id === s.activeId)
    const listing = tab ? s.listings[tab.id] : undefined
    if (!listing) return undefined
    const siblings = listing.entries
      .filter((e) => e.kind === 'file' && categoryOf(e) === cat)
      .sort((a, b) => a.name.localeCompare(b.name))
    const index = siblings.findIndex((e) => e.path === entry.path)
    if (siblings.length < 2 || index === -1) return undefined
    return {
      index,
      total: siblings.length,
      onNav: (delta: number) => {
        const next = siblings[(index + delta + siblings.length) % siblings.length]
        s.openEntry(next)
      },
    }
  }, [entry.path, cat, embedded, s.tabs, s.listings, s.activeId])

  const Comp = VIEWERS[cat] ?? HexViewer
  const editable = !readOnly && EDITABLE_CATEGORIES.has(cat)

  const api: ViewerApi = useMemo(
    () => ({
      setDirty: (dirty) => s.setDirty(dirty),
      registerSave: (fn) => registerSaveFn(fn),
    }),
    [s]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      {!embedded && (
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-brd bg-panel px-2 md:h-10">
          <IconBtn title="返回 (Esc)" onClick={() => (onBack ? onBack() : s.requestCloseView())}>
            <ArrowLeft className="h-4.5 w-4.5" />
          </IconBtn>
          <EntryIcon category={cat} className="h-4 w-4" />
          <span className="max-w-[45%] truncate text-[13px] font-medium">{entry.name}</span>
          <span className="rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-txt2">{CAT_LABEL[cat]}</span>
          <span className="text-[11px] text-txt2">{fmtBytes(entry.size)}</span>
          <span className="flex-1" />
          {nav && (
            <>
              <span className="mr-1 text-[11px] text-txt2">
                {nav.index + 1} / {nav.total}
              </span>
              <IconBtn title="上一个" onClick={() => nav.onNav(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </IconBtn>
              <IconBtn title="下一个" onClick={() => nav.onNav(1)}>
                <ChevronRight className="h-4 w-4" />
              </IconBtn>
            </>
          )}
          {editable && (
            <SaveButton
              dirty={!!s.tabs.find((t) => t.id === s.activeId)?.view?.dirty}
              onSave={() => void s.saveView()}
            />
          )}
          {!embedded && s.provider?.kind === 'native' && (
            <IconBtn
              title="用系统默认程序打开"
              onClick={() => {
                s.provider!.openInSystem!(entry.path).catch((e) =>
                  import('../stores/ui').then(({ useUi }) => useUi.getState().toast(e.message, 'error'))
                )
              }}
            >
              <ExternalLink className="h-4 w-4" />
            </IconBtn>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Comp entry={entry} readOnly={readOnly || !editable} api={api} nav={nav} />
      </div>
    </div>
  )
}

function SaveButton({ dirty, onSave }: { dirty: boolean; onSave(): void }) {
  return (
    <button
      onClick={onSave}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${
        dirty ? 'bg-acc text-white hover:opacity-90' : 'bg-panel2 text-txt2'
      }`}
      title="保存 (Ctrl+S)"
    >
      <Save className="h-3.5 w-3.5" />
      保存{dirty ? ' •' : ''}
    </button>
  )
}

/** 给查看器用的:文件 → 播放地址(桌面版走流式协议,浏览器走 blob URL,自动 revoke) */
export function useBlobUrl(entry: FileEntry | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!entry) {
      setUrl(null)
      return
    }
    const provider = useFs.getState().provider
    // 桌面版:直接用自定义协议流式访问,大视频不占内存
    const media = provider?.mediaUrl?.(entry.path)
    if (media) {
      setUrl(media)
      return
    }
    let u: string | null = null
    let alive = true
    ;(async () => {
      try {
        if (!provider) return
        const f = await provider.getFile(entry.path)
        u = URL.createObjectURL(f)
        if (alive) setUrl(u)
      } catch {
        if (alive) setUrl(null)
      }
    })()
    return () => {
      alive = false
      if (u) URL.revokeObjectURL(u)
    }
  }, [entry?.path, entry?.size, entry?.modified])
  return url
}

export type { ViewedFile }
