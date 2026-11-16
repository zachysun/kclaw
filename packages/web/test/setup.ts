/**
 * jsdom 环境缺口补齐。jsdom 不实现浏览器的 CSS 全局（含 CSS.escape），
 * 而定位滚动目标的选择器需要它（ChatView.locateCard）。用社区通行的
 * polyfill 实现补上，不改变任何被测行为。
 */
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
  const escape = (s: string): string => s.replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, "\\$&")
  const existing = typeof globalThis.CSS === "object" ? globalThis.CSS : {}
  Object.defineProperty(globalThis, "CSS", {
    value: { ...existing, escape },
    configurable: true,
    writable: true,
  })
}
