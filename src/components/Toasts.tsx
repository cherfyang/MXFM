import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { useUi } from '../stores/ui'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-10 right-4 z-[60] flex w-72 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="mx-fade flex items-start gap-2 rounded-lg border border-brd bg-panel px-3 py-2.5 text-[13px] shadow-lg shadow-black/20"
        >
          {t.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
          ) : t.kind === 'error' ? (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-acc" />
          )}
          <span className="break-all">{t.msg}</span>
        </div>
      ))}
    </div>
  )
}
