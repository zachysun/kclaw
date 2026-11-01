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

/**
 * Fired after any successful skill mutation from the skills page (复用链接
 * 增删/批量、提案采纳/回退)：ChatPanel 跨 tab 保活不重挂，斜杠菜单的动态
 * 技能命令靠这个信号即时重拉 /skills——照 PROVIDERS_CHANGED 先例。CLI、
 * 磁盘编辑等页外增删改没有本页事件，与服务端"每次 run 现扫"的下一次交互
 * 边界语义一致。
 */
export const SKILLS_CHANGED = "kclaw:skills-changed"

export function emitSkillsChanged(): void {
  window.dispatchEvent(new CustomEvent(SKILLS_CHANGED))
}

/**
 * Fired from a tool card（fs_edit/fs_write）to open the in-chat change
 * drawer focused on that file：ChatPanel 收到即展开抽屉并选中该路径
 * （每次点击都是新事件对象，重复点击同一路径也会重新定位）。
 */
export const OPEN_CHANGES = "kclaw:open-changes"

export function emitOpenChanges(path: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_CHANGES, { detail: { path } }))
}
