import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { Loader2, AlertTriangle } from 'lucide-react'
import type { ViewerProps } from './registry'
import { useFs } from '../stores/fs'
import { fmtBytes } from '../utils/format'

/** docx-preview 全量渲染进 DOM:给个上限,避免超大文档冻结标签页 */
const DOCX_SIZE_LIMIT = 50 * 1024 * 1024

export function DocxViewer({ entry }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const renderRunRef = useRef(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    let alive = true
    const runId = ++renderRunRef.current
    setStatus('loading')
    ;(async () => {
      try {
        const provider = useFs.getState().provider
        if (!provider) return
        const f = await provider.getFile(entry.path)
        if (f.size > DOCX_SIZE_LIMIT) {
          if (alive && runId === renderRunRef.current) {
            setStatus('error')
            setErrMsg(`文件较大(${fmtBytes(f.size)}),超出内置预览上限 ${fmtBytes(DOCX_SIZE_LIMIT)}`)
          }
          return
        }
        const buf = await f.arrayBuffer()
        if (!alive || !hostRef.current) return
        hostRef.current.innerHTML = ''
        await renderAsync(buf, hostRef.current, undefined, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          useBase64URL: true,
        })
        // renderAsync 期间已切换到别的文件:清掉本次写入的旧内容,避免两份文档叠加
        if (runId !== renderRunRef.current) {
          hostRef.current.innerHTML = ''
          return
        }
        if (alive) setStatus('ready')
      } catch (e) {
        if (alive && runId === renderRunRef.current) {
          setStatus('error')
          setErrMsg(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [entry.path])

  // 宿主必须始终挂载(renderAsync 需要真实 DOM 节点),状态用浮层表达
  return (
    <div className="relative h-full">
      {status === 'error' ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-txt2">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <div className="text-sm">文档渲染失败:{errMsg}</div>
          <div className="text-xs opacity-70">仅支持 .docx 格式(旧版 .doc 不支持)</div>
        </div>
      ) : (
        <div
          className="h-full overflow-auto bg-panel2 py-6"
          style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }}
        >
          <div ref={hostRef} className="mx-auto w-fit [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0" />
        </div>
      )}
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-panel2">
          <span className="flex items-center text-txt2">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 渲染文档…
          </span>
        </div>
      )}
    </div>
  )
}
