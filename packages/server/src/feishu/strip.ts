/**
 * Outbound stripper: nothing written for the model's eyes may leak to the IM
 * surface. The injection marker (<system-reminder …>) is the one construct
 * that carries internal machinery text — notes and thinking never reach the
 * outbound path by construction (only assistant text blocks are rendered).
 */

const OPEN = /<system-reminder\b[^>]*>/g
const PAIR = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g

/** Remove every system-reminder block; a dangling opener strips to the end. */
export function stripOutboundText(text: string): string {
  let out = text.replace(PAIR, "")
  const dangling = out.search(OPEN)
  if (dangling >= 0) out = out.slice(0, dangling)
  return out
}
