/**
 * /goal 判定器（issue #47）：证据窗口构建 + 独立 LLM 调用 + 严格 JSON
 * 解析。与运行模型隔离——daemon 侧经 config.goals.judge 解析条目（默认
 * 回退会话模型），判定调用带 temperature 0 与宽松输出上限。解析失败在
 * 本函数内做一次有界重试（把错误回填给模型要求重出）；重试仍失败返回
 * parse 错误，由调用方计入熔断。不读磁盘、不发事件——纯计算，测试友好。
 */
import type { LlmClient } from "../provider/types.js"
import type { Message } from "../protocol/messages.js"
import type { Usage } from "../protocol/messages.js"
import { isBlockType } from "../protocol/blocks.js"
import { judgeMaxTokens, judgeSystemPrompt, judgeUserContent } from "./prompt.js"
import {
  GOAL_EVIDENCE_MAX_MESSAGES,
  GOAL_EVIDENCE_TEXT_CHARS,
  GOAL_EVIDENCE_WINDOW_CHARS,
} from "./limits.js"
import type { GoalGateOutcome, GoalJudgeError, GoalJudgeResult, GoalSnapshot } from "./types.js"

/** 单条内容块进入证据的渲染上限（超出截尾加标记）。 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…（截断，共 ${text.length} 字符）`
}

/** 一条消息渲染成证据行：文本/思考截断、工具调用只报名字与参数摘要、结果留尾部。 */
function renderMessage(message: Message): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (isBlockType("text", block)) {
      parts.push(clip(block.text, GOAL_EVIDENCE_TEXT_CHARS))
    } else if (isBlockType("tool_call", block)) {
      parts.push(`[工具调用 ${block.name} ${clip(block.argsJson, 200)}]`)
    } else if (isBlockType("tool_result", block)) {
      parts.push(`[工具结果 ${block.status}] ${clip(block.output, GOAL_EVIDENCE_TEXT_CHARS)}`)
    }
    // thinking/note/attachment 不进判定证据：判定只关心可观察行为与结论。
  }
  const body = parts.join("\n").trim()
  if (body === "") return ""
  return `[${message.role}] ${body}`
}

/**
 * 对话尾部证据窗：最多取最近 GOAL_EVIDENCE_MAX_MESSAGES 条有内容的
 * 消息，逐条截断后再受整窗字符上限约束（从窗口头部裁，保最新的），
 * 头部省略的消息条数如实标注。
 */
export function buildEvidenceWindow(messages: Message[]): string {
  const rendered: string[] = []
  for (let i = messages.length - 1; i >= 0 && rendered.length < GOAL_EVIDENCE_MAX_MESSAGES; i--) {
    const line = renderMessage(messages[i])
    if (line !== "") rendered.unshift(line)
  }
  // 被条数上限裁掉的头部消息数。
  const countedIn = rendered.length
  let window = rendered
  let charBudget = GOAL_EVIDENCE_WINDOW_CHARS
  for (let i = window.length - 1; i >= 0; i--) {
    charBudget -= window[i].length + 1
    if (charBudget < 0) {
      window = window.slice(i + 1)
      break
    }
  }
  const omittedByCount = messages.length - countedIn
  const omittedByChars = countedIn - window.length
  const head =
    omittedByCount > 0 || omittedByChars > 0
      ? `（更早的 ${omittedByCount + omittedByChars} 条消息已省略）\n`
      : ""
  return `${head}${window.join("\n---\n")}`
}

/** 从模型输出提取首个 JSON 对象并校验三值契约；非法返回 undefined。 */
function parseVerdict(raw: string): { verdict: GoalJudgeResult["verdict"]; reason: string; progress?: string } | undefined {
  const stripped = raw.replace(/```(?:json)?/g, "").trim()
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const obj = parsed as { verdict?: unknown; reason?: unknown; progress?: unknown }
  if (obj.verdict !== "not_met" && obj.verdict !== "met" && obj.verdict !== "impossible") return undefined
  if (typeof obj.reason !== "string" || obj.reason.trim() === "") return undefined
  return {
    verdict: obj.verdict,
    reason: obj.reason.trim(),
    ...(typeof obj.progress === "string" && obj.progress.trim() !== "" ? { progress: obj.progress.trim() } : {}),
  }
}

/** 收集一次流式调用的完整文本与用量。 */
async function streamOnce(llm: LlmClient, model: string, system: string, userContent: string): Promise<{ text: string; usage: Usage }> {
  let text = ""
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }
  for await (const event of llm.stream({
    model,
    system,
    messages: [{ role: "user", content: userContent }],
    tools: [],
    maxTokens: judgeMaxTokens,
    temperature: 0,
  })) {
    if (event.type === "text_delta") text += event.delta
    else if (event.type === "message_done") usage = event.usage
  }
  return { text, usage }
}

export interface JudgeGoalInput {
  llm: LlmClient
  model: string
  goal: GoalSnapshot
  /** 本轮验收输出（已过门才进判定器；空数组 = 无验收命令）。 */
  gates: GoalGateOutcome[]
  /** 会话消息流（窗口构建器自取尾部）。 */
  messages: Message[]
}

export type JudgeGoalOutput = { ok: true; result: GoalJudgeResult } | { ok: false; error: GoalJudgeError }

/**
 * 一次判定：构建证据窗、调 LLM、解析三值 JSON。解析失败重试一次（把
 * 原始输出与错误回填要求重出 JSON）；传输异常直接上抛由调用方归类
 * （本函数不做传输重试——provider 客户端自带 withRetry）。
 */
export async function judgeGoal(input: JudgeGoalInput): Promise<JudgeGoalOutput> {
  const system = judgeSystemPrompt()
  const evidence = buildEvidenceWindow(input.messages)
  let firstUsage: Usage = { inputTokens: 0, outputTokens: 0 }
  try {
    const first = await streamOnce(input.llm, input.model, system, judgeUserContent(input.goal, input.gates, evidence))
    firstUsage = first.usage
    const verdict = parseVerdict(first.text)
    if (verdict !== undefined) return { ok: true, result: { ...verdict, tokens: first.usage } }
    const retry = await streamOnce(
      input.llm,
      input.model,
      system,
      `${judgeUserContent(input.goal, input.gates, evidence)}\n\n你上一次的输出不是合法的裁决 JSON（${clip(first.text, 200)}）。重新输出，只输出契约里的 JSON 对象。`,
    )
    const verdict2 = parseVerdict(retry.text)
    if (verdict2 !== undefined) {
      return { ok: true, result: { ...verdict2, tokens: addUsage(firstUsage, retry.usage) } }
    }
    return {
      ok: false,
      error: { kind: "parse", message: `judge output is not valid verdict JSON: ${clip(retry.text, 200)}` },
    }
  } catch (err) {
    return { ok: false, error: { kind: "transport", message: err instanceof Error ? err.message : String(err) } }
  }
}

/** 用量相加（重试轮的两段合并计）。 */
function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
}
