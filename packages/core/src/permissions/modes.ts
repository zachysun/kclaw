/**
 * Session permission modes, ordered from strictest to most permissive.
 * Batch 1 shipped the first three; `trusted` / `auto` joined in batch C —
 * the enum, storage and audit values were designed to grow without reshaping.
 */

/** Session permission modes, strict first. */
export const PERMISSION_MODES = ["readonly", "default", "acceptEdits", "trusted", "auto"] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Strict validation: unknown mode names are rejected, never silently mapped. */
export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v)
}

/** One-line confirmation copy a frontend prints after switching modes. */
export const PERMISSION_MODE_CONFIRMATIONS: Record<PermissionMode, string> = {
  readonly: "已切换为只读模式（写与 exec 将被拒绝）",
  default: "已切换为默认模式（越界操作逐次确认）",
  acceptEdits: "已切换为自动接受编辑（工作区内文件写入不再逐次确认）",
  trusted: "已切换为信任模式（沙箱与工作区内免确认，边界外直接拒绝）",
  auto: "已切换为自动学习模式（反复放行的操作自动沉淀为规则）",
}

