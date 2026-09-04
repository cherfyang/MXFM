import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react'
import MarkdownIt from 'markdown-it'
import { Pencil, Columns2, Eye, Loader2 } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useUi } from '../stores/ui'
import { useCodeEditor } from './TextViewer'
import { IconBtn } from '../components/ui'
import { decodeSmart } from '../utils/format'

const MD_SIZE_LIMIT = 8 * 1024 * 1024

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

/** GFM 任务列表:- [ ] / - [x] 渲染为 checkbox */
function taskListPlugin(md: MarkdownIt) {
  md.core.ruler.after('inline', 'github-task-list', (state) => {
    const tokens = state.tokens
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open') continue
      const m = /^\[([ xX])\]\s+/.exec(tokens[i].content)
      if (!m) continue
      const checked = m[1] !== ' '
      tokens[i].content = tokens[i].content.slice(m[0].length)
      // 段落变列表项样式:注入 checkbox 前缀
      const box = new state.Token('html_inline', '', 0)
      box.content = `<input type="checkbox" disabled${checked ? ' checked' : ''} class="md-task"> `
      tokens[i].children?.unshift(box)
      tokens[i - 1].attrJoin('class', 'md-task-item')
    }
    return true
  })
}
md.use(taskListPlugin)

type Mode = 'split' | 'edit' | 'preview'

export function MarkdownViewer({ entry, readOnly, api }: ViewerProps) {
  // 复用 TextViewer 的加载与保存逻辑成本太高,这里独立实现(共享 useCodeEditor)
  const [doc, setDoc] = useState<string | null>(null)
  // 预览内容独立于 doc:doc 只在文件加载时变化(它是 useCodeEditor 的重建依赖),
  // 编辑内容走 previewSrc,避免每键销毁重建 CodeMirror(光标跳文首/IME 中断)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('split')
  const savedRef = useRef<string | null>(null)
  const getTextRef = useRef<() => string>(() => '')

  useEffect(() => {
    let alive = true
    setDoc(null)
    setError(null)
    setMode(readOnly ? 'preview' : 'split')
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (f.size > MD_SIZE_LIMIT) {
          if (alive) setError(`文件较大(${(f.size / 1024 / 1024).toFixed(1)} MB),超出 Markdown 预览上限`)
          return
        }
        const bytes = new Uint8Array(await f.arrayBuffer())
        const { text } = decodeSmart(bytes)
        if (!alive) return
        savedRef.current = text
        getTextRef.current = () => text
        setDoc(text)
        setPreviewSrc(text)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
      api.registerSave(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path, entry.size, readOnly])

  const hostRef = useCodeEditor({
    doc: doc ?? '',
    ext: entry.ext,
    readOnly,
    onChange: (text) => {
      getTextRef.current = () => text
      setPreviewSrc(text)
      api.setDirty(text !== savedRef.current)
    },
    onSave: () => void doSave(),
  })

  const doSave = async () => {
    try {
      const provider = useFs.getState().provider
      if (!provider) return
      await provider.writeText(entry.path, getTextRef.current())
      savedRef.current = getTextRef.current()
      api.setDirty(false)
      useUi.getState().toast('已保存', 'success')
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  useEffect(() => {
    if (readOnly || doc === null) {
      api.registerSave(null)
      return
    }
    api.registerSave(() => doSave())
    return () => api.registerSave(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path, readOnly, doc])

  // 击键防抖渲染:编辑时预览跟随 deferred 值,大文档不再每键全量重渲染
  const deferredSrc = useDeferredValue(previewSrc)
  const html = useMemo(() => md.render(deferredSrc ?? doc ?? ''), [deferredSrc, doc])

  if (error) return <div className="flex h-full items-center justify-center text-txt2">{error}</div>
  if (doc === null)
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
      </div>
    )

  const modeBtn = (m: Mode, icon: React.ReactNode, title: string) => (
    <IconBtn title={title} active={mode === m} onClick={() => setMode(m)}>
      {icon}
    </IconBtn>
  )

  return (
    <div className="flex h-full flex-col">
      {!readOnly && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-brd bg-panel px-2">
          {modeBtn('edit', <Pencil className="h-4 w-4" />, '仅编辑')}
          {modeBtn('split', <Columns2 className="h-4 w-4" />, '分屏预览')}
          {modeBtn('preview', <Eye className="h-4 w-4" />, '仅预览')}
          <span className="flex-1" />
          <span className="text-[11px] text-txt2">{doc.length} 字符</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* 编辑器常驻(避免切换模式时销毁),用 CSS 控制显隐 */}
        <div
          ref={hostRef}
          className={`cm-host min-w-0 flex-1 overflow-hidden ${mode === 'preview' ? 'hidden' : ''}`}
        />
        {mode !== 'edit' && (
          <div className={`min-h-0 overflow-auto px-6 py-4 ${mode === 'split' ? 'w-1/2 border-l border-brd' : 'w-full'}`}>
            <div className="md-body mx-auto max-w-3xl pb-16" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )}
      </div>
    </div>
  )
}
