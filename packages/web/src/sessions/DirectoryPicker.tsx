/**
 * DirectoryPicker — pure presentational modal behind the sidebar's 浏览
 * button. A browser page cannot enumerate the daemon's filesystem, so the
 * owning component (SessionList) fetches each listing through its onBrowse
 * prop and hands the result down here; navigation/pick/close escape through
 * callbacks. No I/O of its own.
 */
import type { FsBrowseResult } from "../types.js"

export interface DirectoryPickerProps {
  /** The current listing, null while the first fetch is in flight. */
  listing: FsBrowseResult | null
  /** True while a navigation fetch is running (rows stay visible but inert). */
  loading: boolean
  /** Last fetch error (a missing/unreadable path), null when healthy. */
  error: string | null
  /** Escape a navigation request for an absolute path. */
  onNavigate: (path: string) => void
  /** Escape the pick: the current listing's path becomes the workdir. */
  onPick: () => void
  /** Escape a close-without-picking request. */
  onClose: () => void
}

/** Join a child name onto a posix absolute path (daemon side is posix). */
export function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`
}

export function DirectoryPicker({ listing, loading, error, onNavigate, onPick, onClose }: DirectoryPickerProps) {
  return (
    <div className="picker-overlay" data-testid="picker-overlay" onClick={onClose}>
      <div className="picker-panel" data-testid="picker-panel" onClick={(event) => event.stopPropagation()}>
        <div className="picker-title">选择工作目录</div>
        <div className="picker-current" data-testid="picker-current" title={listing?.path ?? ""}>
          {listing === null ? "加载中…" : listing.path}
        </div>
        {error !== null && (
          <p className="picker-error" data-testid="picker-error" role="alert">
            {error}
          </p>
        )}
        <div className="picker-nav">
          <button
            type="button"
            data-testid="picker-up"
            disabled={loading || listing?.parent == null}
            onClick={() => listing?.parent != null && onNavigate(listing.parent)}
          >
            上一级
          </button>
        </div>
        <ul className="picker-list" data-testid="picker-list">
          {listing !== null && listing.dirs.length === 0 && <li className="picker-empty muted">（没有子目录）</li>}
          {listing?.dirs.map((name) => (
            <li key={name}>
              <button
                type="button"
                className="picker-item"
                data-testid={`picker-item-${name}`}
                disabled={loading}
                onClick={() => onNavigate(joinPath(listing.path, name))}
              >
                {name}/
              </button>
            </li>
          ))}
        </ul>
        <div className="picker-actions">
          <button type="button" data-testid="picker-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="picker-confirm"
            data-testid="picker-confirm"
            disabled={loading || listing === null}
            onClick={onPick}
          >
            选择此目录
          </button>
        </div>
      </div>
    </div>
  )
}
