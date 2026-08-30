/**
 * 记忆调度器（Task 13，spec 4.2）：定时 + 跟随两种兜底触发的宿主。
 *
 * - 定时：每扫一次，对每个 workdir 判断距上次 interval 触发是否 ≥ intervalMinutes
 *   （上次时间存 <projectDir>/state.json 的 intervalLastRun；经 MemorySystem 直通读写）。
 * - 跟随：RunManager 在每个 run 结束（任何 stopReason）时调 system.scheduleFollowCheck
 *   （daemon 装配钩子，见 run.ts）；scheduler 扫到 due 的检查执行 triggerFollow 并 clear。
 *   挂起检查经 WriteLedger 落盘（spec 11），daemon 重启后由首次 sweep 补查。
 *
 * 手动/立刻不入此调度器（memory_save 工具与 /memory save 直接触发）。
 */
import type { KclawConfig, MemorySystem, SessionStore } from "@kclaw/core"

const DEFAULT_SCAN_MS = 60_000

/**
 * 跟随门禁判定（纯函数，spec 4.2）：end_turn 之后 idleMinutes 内无新活动 → due。
 * 空活动记录（无会话）视作"end_turn 即最后活动"，保证重启后可补查（spec 11）。
 */
export function followGateDue(
  endTurnAt: string, nowISO: string,
  opts: { idleMinutes: number; lastActivityAt: string },
): boolean {
  const end = Date.parse(endTurnAt)
  const activity = opts.lastActivityAt === "" ? end : Date.parse(opts.lastActivityAt)
  return Date.parse(nowISO) - end >= opts.idleMinutes * 60_000 && activity <= end
}

export interface MemorySchedulerHandle { stop(): Promise<void> }

export function startMemoryScheduler(deps: {
  system: MemorySystem
  /**
   * SessionStore（M-4：当前调度器不直接读会话——项目维度活动时间经
   * system.lastActivity 取；保留该字段与 brief 的宿主接口契约一致，供宿主/后续任务扩展）。
   */
  sessions: SessionStore
  config: KclawConfig
  /** 项目 workdir 集合：每个有记忆（或已有会话）的项目；由 daemon 维护的去重集合。 */
  workdirs: () => string[]
  /** 扫描节拍，默认 60s（内部判断各项目是否到 intervalMinutes）。 */
  intervalMs?: number
  now?: () => Date
  log?: (m: string) => void
}): MemorySchedulerHandle {
  const log = deps.log ?? ((m) => console.error(m))
  const now = deps.now ?? (() => new Date())
  const intervalMs = deps.intervalMs ?? DEFAULT_SCAN_MS
  const inFlight = new Set<Promise<void>>()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  async function sweep(): Promise<void> {
    const cfg = deps.config.memory
    for (const workdir of deps.workdirs()) {
      if (stopped) return
      // 定时（intervalMinutes=0 关闭）
      if (cfg.write.intervalMinutes > 0) {
        const last = deps.system.intervalLastRun(workdir)
        if (last === undefined || now().getTime() - Date.parse(last) >= cfg.write.intervalMinutes * 60_000) {
          const p = deps.system.triggerInterval(workdir).catch((e) => log(`kclaw memory interval failed: ${String(e)}`))
          inFlight.add(p); void p.finally(() => inFlight.delete(p))
          // markIntervalRun 在触发发起后立即推进（即便失败也推进，M-2 取舍）：interval
          // 语义是"至少每 intervalMinutes 兜底扫一次"，失败后下个整周期再试，避免同项目
          // 每次扫描都重试同一失败批次；防重入优先于失败重试。
          deps.system.markIntervalRun(workdir, now().toISOString())
        }
      }
      // 跟随（idleMinutes=0 关闭）：补查该项目的挂起检查（含 daemon 重启恢复，spec 11）
      if (cfg.write.idleMinutes > 0) {
        for (const check of deps.system.pendingFollowChecks(workdir)) {
          const activity = deps.system.lastActivity(workdir)
          if (followGateDue(check.endTurnAt, now().toISOString(), { idleMinutes: cfg.write.idleMinutes, lastActivityAt: activity })) {
            deps.system.clearFollowCheck(workdir, check.sessionId)
            const p = deps.system.triggerFollow(workdir).catch((e) => log(`kclaw memory follow failed: ${String(e)}`))
            inFlight.add(p); void p.finally(() => inFlight.delete(p))
          } else if (activity !== "" && Date.parse(activity) > Date.parse(check.endTurnAt)) {
            // I-1：门禁不过但 end_turn 之后已有更新活动（用户切到别的会话继续对话、
            // 或该项目又跑了一轮）——该检查的锚点已被新活动取代，语义上旧检查让位
            // （spec 4.2 "门禁不过则等下一个 end_turn 再判定"），直接清掉，防止
            // state.json 里 followChecks 无界增长。
            deps.system.clearFollowCheck(workdir, check.sessionId)
          }
        }
      }
    }
  }

  void sweep()
  timer = setInterval(() => void sweep(), intervalMs)
  return {
    async stop(): Promise<void> {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      await Promise.allSettled([...inFlight])
    },
  }
}
