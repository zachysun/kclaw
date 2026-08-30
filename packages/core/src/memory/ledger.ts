import { existsSync, readFileSync } from "node:fs"
import { writeFileAtomic } from "../storage/atomic.js"

export type LedgerTrigger = "interval" | "follow"
export interface Watermark { sessionId: string; messageId: string }
export interface FollowCheck { sessionId: string; endTurnAt: string }

interface LedgerState {
  watermarks: { interval?: Watermark; follow?: Watermark }
  followChecks: FollowCheck[]
}

/** 每项目一本（<projectDir>/state.json，spec 4.1）：防重复提取与漏提取。 */
export class WriteLedger {
  readonly #path: string
  #state: LedgerState

  constructor(statePath: string) {
    this.#path = statePath
    this.#state = { watermarks: {}, followChecks: [] }
    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<LedgerState>
        this.#state = { watermarks: raw.watermarks ?? {}, followChecks: raw.followChecks ?? [] }
      } catch {
        // 损坏的账本视作空账本：全量重扫（重复提取由合并写兜底）
      }
    }
  }

  get(trigger: LedgerTrigger): Watermark | undefined {
    return this.#state.watermarks[trigger]
  }

  #flush(): void {
    writeFileAtomic(this.#path, JSON.stringify(this.#state))
  }

  advance(trigger: LedgerTrigger, wm: Watermark): void {
    this.#state.watermarks[trigger] = wm
    this.#flush()
  }

  /** 手动/立刻的范围覆盖到当前时刻：两种水位一并推进（spec 4.1）。 */
  advanceAll(wm: Watermark): void {
    this.#state.watermarks.interval = wm
    this.#state.watermarks.follow = wm
    this.#flush()
  }

  pendingFollowChecks(): FollowCheck[] {
    return [...this.#state.followChecks]
  }

  scheduleFollowCheck(sessionId: string, endTurnAt: string): void {
    this.clearFollowCheck(sessionId)
    this.#state.followChecks.push({ sessionId, endTurnAt })
    this.#flush()
  }

  clearFollowCheck(sessionId: string): void {
    this.#state.followChecks = this.#state.followChecks.filter((c) => c.sessionId !== sessionId)
    this.#flush()
  }

  /** 项目维度选范围：水位会话内其 messageId 之后 + 其后（createdAt 更晚）会话全部。 */
  static messagesSince(
    watermark: Watermark | undefined,
    sessions: Array<{ id: string; createdAt: string; messages: Array<{ id: string }> }>,
  ): Array<{ sessionId: string; messageId: string }> {
    if (watermark === undefined) {
      return sessions.flatMap((s) => s.messages.map((m) => ({ sessionId: s.id, messageId: m.id })))
    }
    const ordered = sessions.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    const out: Array<{ sessionId: string; messageId: string }> = []
    let passedWatermarkSession = false
    for (const s of ordered) {
      if (!passedWatermarkSession && s.id !== watermark.sessionId) continue
      if (s.id === watermark.sessionId) {
        const idx = s.messages.findIndex((m) => m.id === watermark.messageId)
        for (const m of s.messages.slice(idx + 1)) out.push({ sessionId: s.id, messageId: m.id })
        passedWatermarkSession = true
        continue
      }
      for (const m of s.messages) out.push({ sessionId: s.id, messageId: m.id })
    }
    // 水位会话被删（从未匹配）：全量返回，宁可重提取不可漏提取
    if (!passedWatermarkSession) {
      return WriteLedger.messagesSince(undefined, ordered)
    }
    return out
  }
}
