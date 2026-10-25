/**
 * 事件流哈希链：每条事件行携带前一行原文的 SHA-256 摘要（`$prev` 字段，
 * 持久层私有，读取边界剥离），meta.json 记录链头与总行数做删尾锚定。
 *
 * 威胁模型与边界（spec：docs/superpowers/session-integrity-batch-spec.md）：
 * - 检出：改写、删除、插入、调换任意行；截尾（行数对不上）；整目录置换
 *   （创世绑定会话 id + meta.id 核对）；meta 链字段被改。
 * - 不防：持有写权限者重写整条链并同步改 meta（需外部锚定，明确不做）。
 * - 摘要按行**原文文本**计算，不做重新序列化——JSON.stringify 的键序是
 *   插入序，同一数据经不同构造路径可能得到不同序列化文本（原型 S12 证实），
 *   重序列化会造成假断裂。
 * - 崩溃窗口（事件已写、meta 未写）自愈：prev 恒以文件末行为准；meta
 *   链字段允许落后（文件比记录长时按文件链验证），下一次追加即对齐。
 */
import { createHash } from "node:crypto"

/** 摘要算法：SHA-256 十六进制。 */
export function lineDigest(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex")
}

/** 链创世：会话 id 进创世值，目录改名/文件置换可检出。 */
export function chainGenesis(sessionId: string): string {
  return lineDigest(`kclaw-chain-v1:${sessionId}`)
}

/** 校验结论。brokenAt = 第一个对不上的行（1-based）；suspect = 被改动嫌疑行（brokenAt-1）。 */
export interface ChainVerifyResult {
  status: "ok" | "partial" | "broken" | "not-chained" | "torn-tail"
  /** 起链行（1-based）；not-chained 时无。 */
  verifiedFrom?: number
  /** 验证覆盖的行数。 */
  checked: number
  brokenAt?: number
  suspect?: number
  reason?: string
}

/** verify 的 meta 锚定输入（磁盘 meta.json 原样读入；缺失/损坏传 null）。 */
export interface ChainMetaAnchor {
  id?: string
  chainHead?: string
  chainLength?: number
}

const parseOrNull = (line: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(line) as unknown
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 校验一条事件流。输入文件原文与 meta 锚，纯函数无 IO；SessionStore.verifyChain
 * 负责读取并调用。判定顺序：meta.id 核对 → 撕裂尾（崩溃痕迹，非篡改）→
 * 不可解析行 → 创世 → 逐行链 → meta 行数（只抓文件短于记录=删尾）→ meta
 * 链头（记录的摘要必须出现在行摘要集合中，否则视为 meta 被改或文件被换）。
 */
export function verifyEventChain(
  raw: string,
  meta: ChainMetaAnchor | null,
  sessionId: string,
): ChainVerifyResult {
  if (meta !== null && meta.id !== undefined && meta.id !== sessionId) {
    return { status: "broken", checked: 0, reason: `meta.id=${meta.id} 与会话 ${sessionId} 不符（目录内容被置换？）` }
  }
  let lines = raw.split("\n")
  const tornTail = lines[lines.length - 1] !== "" // 末行无换行符 = 写入中途崩溃
  if (lines[lines.length - 1] === "") lines.pop()
  const parsed = lines.map(parseOrNull)
  if (tornTail && parsed[lines.length - 1] === null) {
    return { status: "torn-tail", checked: lines.length, brokenAt: lines.length, reason: "末行不完整（崩溃痕迹，追加时自动修复）" }
  }
  const firstBad = parsed.indexOf(null)
  if (firstBad !== -1) {
    return { status: "broken", checked: lines.length, brokenAt: firstBad + 1, suspect: firstBad, reason: `第 ${firstBad + 1} 行不是合法 JSON` }
  }
  const start = parsed.findIndex((p) => p !== null && p.$prev !== undefined)
  if (start === -1) return { status: "not-chained", checked: 0, reason: "事件流未起链（功能上线前写入的会话）" }
  if (parsed[start]!.$prev !== chainGenesis(sessionId)) {
    return { status: "broken", checked: lines.length - start, brokenAt: start + 1, suspect: start, reason: `第 ${start + 1} 行链创世不符（来自其他会话的流？）` }
  }
  let prev = parsed[start]!.$prev as string
  for (let i = start; i < lines.length; i++) {
    const cur = parsed[i]!.$prev
    if (cur !== prev) {
      if (i === lines.length - 1 && tornTail) {
        return { status: "torn-tail", checked: lines.length, brokenAt: i + 1, reason: "末行不完整（崩溃痕迹，追加时自动修复）" }
      }
      return {
        status: "broken", checked: lines.length - start, brokenAt: i + 1, suspect: i,
        reason: `第 ${i + 1} 行与前行摘要不符（第 ${i} 行或第 ${i + 1} 行被改动）`,
      }
    }
    prev = lineDigest(lines[i]!)
  }
  if (meta !== null) {
    if (meta.chainLength !== undefined && lines.length < meta.chainLength) {
      return { status: "broken", checked: lines.length - start, reason: `文件比记录短：meta.chainLength=${meta.chainLength} 实际 ${lines.length} 行（删尾？）` }
    }
    if (meta.chainHead !== undefined) {
      // 允许落后（崩溃窗口）：记录的链头只要出现在行摘要集合中即可，下一次追加自愈
      const digests = new Set(lines.map((l) => lineDigest(l)))
      if (!digests.has(meta.chainHead)) {
        return { status: "broken", checked: lines.length - start, reason: "meta.chainHead 不在事件流摘要集合中（meta 被改或文件被换）" }
      }
    }
  }
  return { status: start > 0 ? "partial" : "ok", verifiedFrom: start + 1, checked: lines.length - start }
}

/** 读取边界剥离：`$prev` 只属于持久化层，不进领域模型（AGENTS.md 原则 3）。 */
export function stripChainField<T>(value: unknown): T {
  if (typeof value === "object" && value !== null && "$prev" in value) {
    const { $prev: _drop, ...rest } = value as Record<string, unknown>
    return rest as T
  }
  return value as T
}
