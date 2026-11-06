/**
 * Terminal window title (spec B13, codex terminal_title.rs 四件套照搬)：标题
 * 随运行状态变化（空闲/运行中，带会话标题），切到别的窗口也能看出忙闲；run 结束即更新。
 *
 * 标题内容含会话名与会话标题（可含模型输出），属不可信文本，写入 OSC 序列前
 * 必须消毒：剔除控制字符、剔除双向与不可见格式码点（Trojan Source 注入族）、
 * 空白归一、240 字上限；GNU Screen（STY 已设）对 OSC 标题按字节截断，Unicode
 * 会被截成控制字节，整体降级为可打印 ASCII。终端没有可移植的方式读取原标题，
 * 这里同样不读取、不恢复，只在退出时清除自己写过的标题。
 */

/** 控制字符与双向/不可见码点全剔，空白归一，240 字上限。带 u 标志的 \u{...} 形式——4 位 \u 转义写不下星体平面码位，\ue0100 会被解析成 \ue010 加字面 0，产生覆盖半个 BMP 的区间。 */
const INVISIBLE_CODEPOINTS = /[\u{00ad}\u{034f}\u{061c}\u{180e}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{fe00}-\u{fe0f}\u{feff}\u{fff9}-\u{fffb}\u{1bca0}-\u{1bca3}\u{e0100}-\u{e01ef}]/gu

export function sanitizeTitle(text: string): string {
  let cleaned = ""
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    // \t\n\r 归空白（随后的空白归一收拢），其余 C0/C1 控制字符剔除
    const isWhitespace = code === 0x09 || code === 0x0a || code === 0x0d
    const isControl = !isWhitespace && (code < 0x20 || (code >= 0x7f && code < 0xa0))
    if (isControl) continue
    cleaned += ch
  }
  cleaned = cleaned.replace(INVISIBLE_CODEPOINTS, "").replace(/\s+/g, " ").trim()
  return [...cleaned].slice(0, 240).join("")
}

/** GNU Screen 下整体降级可打印 ASCII（保留字母数字与常见标点，其余换空格）。 */
function screenSafe(text: string): string {
  return [...text].map((ch) => (ch.codePointAt(0)! >= 0x20 && ch.codePointAt(0)! < 0x7f ? ch : " ")).join("").replace(/ +/g, " ").trim()
}

let wrote = false

/** 写一条 OSC 0 标题；stdout 不是终端时（测试、管道）静默跳过。 */
export function writeTerminalTitle(raw: string): void {
  if (process.stdout.isTTY !== true) return
  const title = process.env.STY !== undefined ? screenSafe(sanitizeTitle(raw)) : sanitizeTitle(raw)
  process.stdout.write(`\x1b]0;${title}\x07`)
  wrote = true
}

/** 清除 kclaw 写过的标题（空载荷 = 终端恢复默认标题行为）。 */
export function clearTerminalTitle(): void {
  if (!wrote || process.stdout.isTTY !== true) return
  process.stdout.write("\x1b]0;\x07")
  wrote = false
}
