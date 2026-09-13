/**
 * IconButton — a small icon-only button whose text label appears in a hover/
 * focus bubble instead of as permanent text (sidebar noise reduction).
 *
 * The bubble is a fixed-position sibling (a CSS pseudo element would be
 * clipped by the sidebar's scroll container). It shows on hover and keyboard
 * focus, and hides on leave, blur, mousedown (clicking must not leave a
 * stale bubble behind) and scroll — the parent lists dismiss it via
 * onScrollCapture.
 */
import { useState, type ReactNode } from "react"

export interface IconButtonProps {
  /** Bubble text and accessible name (the icon carries no text). */
  label: string
  icon: ReactNode
  testid?: string
  /** Hazard styling for destructive actions. */
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
}

export function IconButton({ label, icon, testid, danger = false, disabled = false, onClick }: IconButtonProps) {
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null)

  const show = (el: HTMLElement): void => {
    const rect = el.getBoundingClientRect()
    setTip({ top: rect.bottom + 4, left: rect.left + rect.width / 2 })
  }

  return (
    <>
      <button
        type="button"
        className={`icon-btn${danger ? " danger" : ""}`}
        data-testid={testid}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onMouseDown={() => setTip(null)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setTip(null)}
      >
        {icon}
      </button>
      {tip !== null && (
        <div className="icon-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          {label}
        </div>
      )}
    </>
  )
}
