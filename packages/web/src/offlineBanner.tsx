/**
 * OfflineBanner — a slim offline indicator for the PWA shell: shows while
 * `navigator.onLine === false`, listens for the browser's online/offline
 * events. Pure presentation; the service worker does the actual offline
 * shell caching.
 */
import { useEffect, useState } from "react"

export function OfflineBanner(): React.JSX.Element | null {
  const [offline, setOffline] = useState<boolean>(() => typeof navigator !== "undefined" && navigator.onLine === false)

  useEffect(() => {
    const on = (): void => setOffline(false)
    const off = (): void => setOffline(true)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])

  if (!offline) return null
  return (
    <div className="offline-banner" data-testid="offline-banner" role="status">
      离线：当前显示缓存的界面，重连后自动恢复
    </div>
  )
}

/** Register the service worker (PWA shell caching); no-op where unsupported. */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // best-effort: the app works without a SW
  })
}
