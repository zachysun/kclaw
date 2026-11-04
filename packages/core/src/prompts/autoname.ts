/**
 * 会话自动命名（autoname）的后台调用提示词（使用方：session/autoname.ts）。
 */

/** 标题生成的 system 提示词。 */
export const AUTONAME_SYSTEM_PROMPT = "你是标题生成助手，只输出一个不超过30字的会话标题。"

/** 标题生成的 user 文本：固定指令 + 首条消息原文。 */
export function autonameUserContent(firstText: string): string {
  return `给这段对话起一个不超过30字的标题：\n${firstText}`
}
