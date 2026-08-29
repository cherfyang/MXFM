import { useEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { oneDark } from '@codemirror/theme-one-dark'
import type { LanguageSupport } from '@codemirror/language'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { useSettings, themeMeta } from '../stores/settings'
import { useUi } from '../stores/ui'
import { decodeSmart } from '../utils/format'

const TEXT_LIMIT = 12 * 1024 * 1024

// 语言包全部懒加载,主包保持苗条
const LANG_LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  jsonc: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  vue: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: () => import('@codemirror/lang-css').then((m) => m.css()),
  less: () => import('@codemirror/lang-css').then((m) => m.css()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  svg: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  h: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cc: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  go: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
}

async function loadLang(ext: string): Promise<LanguageSupport | null> {
  const loader = LANG_LOADERS[ext]
  if (!loader) return null
  try {
    return await loader()
  } catch {
    return null
  }
}

/** 创建 CodeMirror 实例;回调通过 ref 传递,避免重建编辑器 */
export function useCodeEditor(opts: {
  doc: string
  ext: string
  readOnly: boolean
  onChange(text: string): void
  onSave(): void
}) {
  const { doc, ext, readOnly } = opts
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(opts.onChange)
  const onSaveRef = useRef(opts.onSave)
  onChangeRef.current = opts.onChange
  onSaveRef.current = opts.onSave

  useEffect(() => {
    let view: EditorView | null = null
    let cancelled = false
    ;(async () => {
      const lang = await loadLang(ext)
      if (cancelled || !hostRef.current) return
      const theme = useSettings.getState().theme
      const extensions: any[] = [
        basicSetup,
        EditorView.theme({
          '&': { backgroundColor: 'transparent', height: '100%', fontSize: '13px' },
          '.cm-content': { paddingBottom: '40vh' },
        }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current()
                return true
              },
            },
            indentWithTab,
          ])
        ),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
      ]
      if (lang) extensions.push(lang)
      if (themeMeta(useSettings.getState().theme).dark) extensions.push(oneDark)
      view = new EditorView({
        state: EditorState.create({ doc, extensions }),
        parent: hostRef.current,
      })
    })()
    return () => {
      cancelled = true
      view?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, ext, readOnly])

  return hostRef
}

export function TextViewer({ entry, readOnly, api }: ViewerProps) {
  const [doc, setDoc] = useState<string | null>(null)
  const [encoding, setEncoding] = useState('')
  const [error, setError] = useState<string | null>(null)
  const savedTextRef = useRef<string | null>(null)
  const getTextRef = useRef<() => string>(() => '')
  const loading = doc === null && !error

  useEffect(() => {
    let alive = true
    setDoc(null)
    setError(null)
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (f.size > TEXT_LIMIT && !readOnly) {
          if (alive) setError(`文件较大(${(f.size / 1024 / 1024).toFixed(1)} MB),超出编辑上限,请使用专门的编辑器打开`)
          return
        }
        const bytes = new Uint8Array(await f.arrayBuffer())
        const { text, encoding: enc } = decodeSmart(bytes)
        if (!alive) return
        setEncoding(enc)
        savedTextRef.current = text
        getTextRef.current = () => text
        setDoc(text)
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
    readOnly: readOnly || doc === null,
    onChange: (text) => {
      const dirty = text !== savedTextRef.current
      getTextRef.current = () => text
      api.setDirty(dirty)
    },
    onSave: () => void doSave(),
  })

  const doSave = async () => {
    try {
      const provider = useFs.getState().provider
      if (!provider) return
      await provider.writeText(entry.path, getTextRef.current())
      savedTextRef.current = getTextRef.current()
      const f = await provider.getFile(entry.path)
      // 保存后刷新条目大小
      const s = useFs.getState()
      const tab = s.tabs.find((t) => t.id === s.activeId)
      if (tab) {
        const listing = s.listings[tab.id]
        if (listing) {
          useFs.setState({
            listings: {
              ...s.listings,
              [tab.id]: {
                ...listing,
                entries: listing.entries.map((e) =>
                  e.path === entry.path ? { ...e, size: f.size, modified: f.lastModified } : e
                ),
              },
            },
          })
        }
      }
      api.setDirty(false)
      useUi.getState().toast('已保存', 'success')
    } catch (e) {
      useUi.getState().toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  // 注册全局 Ctrl+S
  useEffect(() => {
    if (readOnly || doc === null) {
      api.registerSave(null)
      return
    }
    api.registerSave(() => doSave())
    return () => api.registerSave(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path, readOnly, doc])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <div className="text-sm">{error}</div>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-txt2">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
      </div>
    )
  }
  return (
    <div className="relative h-full">
      <div ref={hostRef} className="cm-host h-full overflow-hidden" />
      {encoding && encoding !== 'UTF-8' && (
        <span className="absolute bottom-2 right-3 rounded bg-panel2 px-1.5 py-0.5 text-[10px] text-txt2">
          检测到 {encoding} 编码,保存时将转为 UTF-8
        </span>
      )}
    </div>
  )
}
