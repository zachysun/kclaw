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
