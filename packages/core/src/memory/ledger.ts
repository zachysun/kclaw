import { existsSync, readFileSync } from "node:fs"
import { writeFileAtomic } from "../storage/atomic.js"

export type LedgerTrigger = "interval" | "follow"
export interface FollowCheck { sessionId: string; endTurnAt: string }

/** 单会话水位：每个触发各记一条 messageId（该会话内最后一条已提取的消息）。 */
export interface SessionWatermarks { interval?: string; follow?: string }

interface LedgerState {
  /** 每会话一本水位：提取范围 = 触发会话自己的增量窗口，
   *  不做跨会话比较（项目级水位按会话创建序划界会永久漏掉老会话的新消息，
   *  2026-09-02 改名事故）。 */
  watermarks: Record<string, SessionWatermarks>
  followChecks: FollowCheck[]
  /** 最近一次定时触发的墙钟时间（ISO；scheduler 判节拍用）。 */
  intervalLastRun?: string
  /** 夜间内化判据基线（UTC YYYY-MM-DD，与线文件 updated 同源；pipeline 读写）。 */
  nightlyBaseline?: string
  /** 最近一次夜间内化触发的本地日期（YYYY-MM-DD，scheduler 防同日重跑）。 */
  nightlyLastRun?: string
}

/** 每项目一本（<projectDir>/state.json）：防重复提取与漏提取。 */
export class WriteLedger {
  readonly #path: string
  #state: LedgerState

  constructor(statePath: string) {
    this.#path = statePath
    this.#state = { watermarks: {}, followChecks: [] }
    if (existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<LedgerState>
        this.#state = {
          watermarks: raw.watermarks ?? {},
          followChecks: raw.followChecks ?? [],
          intervalLastRun: raw.intervalLastRun,
          nightlyBaseline: raw.nightlyBaseline,
          nightlyLastRun: raw.nightlyLastRun,
        }
      } catch {
        // 损坏的账本视作空账本：全量重扫（重复提取由合并写兜底）
      }
    }
  }

  get(sessionId: string, trigger: LedgerTrigger): string | undefined {
    return this.#state.watermarks[sessionId]?.[trigger]
  }

  #flush(): void {
    writeFileAtomic(this.#path, JSON.stringify(this.#state))
  }

  advance(sessionId: string, trigger: LedgerTrigger, messageId: string): void {
    const wm = this.#state.watermarks[sessionId] ?? {}
    wm[trigger] = messageId
    this.#state.watermarks[sessionId] = wm
    this.#flush()
  }

  /** 手动/立刻的范围覆盖到当前时刻：该会话两种水位一并推进。 */
  advanceAll(sessionId: string, messageId: string): void {
    this.advance(sessionId, "interval", messageId)
    this.advance(sessionId, "follow", messageId)
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

  /** 最近一次定时触发的墙钟时间（ISO）；从未触发过 → undefined（scheduler 据此立刻首跑）。 */
  getIntervalLastRun(): string | undefined {
    return this.#state.intervalLastRun
  }

  setIntervalLastRun(iso: string): void {
    this.#state.intervalLastRun = iso
    this.#flush()
  }

  /** 夜间内化判据基线（UTC 日期）；从未跑过 → undefined（首跑只内化当天线）。 */
  getNightlyBaseline(): string | undefined {
    return this.#state.nightlyBaseline
  }

  setNightlyBaseline(date: string): void {
    this.#state.nightlyBaseline = date
    this.#flush()
  }

  /** 最近一次夜间内化触发的本地日期（YYYY-MM-DD）；从未触发过 → undefined。 */
  getNightlyLastRun(): string | undefined {
    return this.#state.nightlyLastRun
  }

  setNightlyLastRun(date: string): void {
    this.#state.nightlyLastRun = date
    this.#flush()
  }

  /**
   * 单会话内两个水位谁更靠后：范围选取一律用最靠后的那个，任一触发
   * 先跑到哪，另一个触发都不再重复提取。水位指向的消息已不存在（被删/截断）时
   * 按"更旧"处理 —— since 退化为全量（宁可重提取不可漏提取）。
   */
  static later(messages: Array<{ id: string }>, a?: string, b?: string): string | undefined {
    if (a === undefined) return b
    if (b === undefined) return a
    const ia = messages.findIndex((m) => m.id === a)
    const ib = messages.findIndex((m) => m.id === b)
    if (ia === -1) return b
    if (ib === -1) return a
    return ia >= ib ? a : b
  }

  /** 会话内选范围：水位消息之后（不含）的全部消息；无水位 → 全量。 */
  static since<T extends { id: string }>(watermark: string | undefined, messages: T[]): T[] {
    if (watermark === undefined) return messages.slice()
    const idx = messages.findIndex((m) => m.id === watermark)
    if (idx === -1) return messages.slice()
    return messages.slice(idx + 1)
  }
}
