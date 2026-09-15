/**
 * Global toast stack — the one place transient feedback lands (sidebar action
 * results, management-tab confirmations, load failures). Toasts appear
 * top-right over the content area (near where the triggering control lives),
 * auto-dismiss after a few seconds, and can be clicked away early; errors
 * linger longer and carry a distinct tone. Replaces the old bottom-of-sidebar
 * notice bar, which piled every notice into one hard-to-notice spot.
 */
import { useCallback, useEffect, useRef, useState } from "react"

/** Tone of a toast: plain info (default) or error (redder, longer-lived). */
export type ToastTone = "info" | "error"

/** The callback shape every management view takes as its `notice` prop. */
export type NoticeFn = (text: string, tone?: ToastTone) => void

export interface ToastItem {
  id: number
  text: string
  tone: ToastTone
}

/** Auto-dismiss delay per tone: errors stay up longer, both are click-可消. */
const DISMISS_MS: Record<ToastTone, number> = { info: 6000, error: 9000 }

/** At most this many toasts visible; pushing a newer one drops the oldest. */
const MAX_TOASTS = 4

export function useToasts(): {
  toasts: ToastItem[]
  notify: NoticeFn
  dismiss: (id: number) => void
} {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)
  // Stable identity (functional setState only) — views hold this callback in
  // refs and must never observe it changing.
  const notify = useCallback<NoticeFn>((text, tone = "info") => {
    const id = ++nextId.current
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, text, tone }])
  }, [])
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])
  return { toasts, notify, dismiss }
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }): React.ReactElement {
  // One timer per toast, owned by its own component: mount starts it, the
  // dismiss (auto or click) unmounts and clears it.
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), DISMISS_MS[item.tone])
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the item is fixed for this component's lifetime
  }, [item.id])
  return (
    <button
      type="button"
      className={`toast ${item.tone}`}
      data-testid={`toast-${item.id}`}
      onClick={() => onDismiss(item.id)}
    >
      {item.text}
    </button>
  )
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }): React.ReactElement | null {
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" data-testid="toast-stack" role="status">
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
