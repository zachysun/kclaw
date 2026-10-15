/**
 * Cross-view window events: the WebUI keeps most tabs mounted across tab
 * switches, so a view that mutates shared daemon state signals the change
 * instead of relying on remount refetches.
 */

/** Fired after any successful provider mutation (create/rename/update/delete/set-default). */
export const PROVIDERS_CHANGED = "kclaw:providers-changed"

export function emitProvidersChanged(): void {
  window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED))
}

/**
 * Fired when a view mutates the session set outside the sidebar's own
 * handlers (TrashView 的恢复把会话送回列表)：App 收到即重拉 /sessions。
 * 其他客户端（CLI、IM channel）产生的变化没有本页事件，由可见时轮询接住。
 */
export const SESSIONS_CHANGED = "kclaw:sessions-changed"

export function emitSessionsChanged(): void {
  window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED))
}
