/**
 * 技能调度器（提案制技能进化的唯一消费端）：扫到到期的空闲检查，触发
 * core 提炼管线（triggerFollow）。骨架是 memory-scheduler 的跟随分支，两处
 * 有意差异（原型结论 #1）：
 * - 成功才清检查：记忆侧"先清后触发"靠 interval 定时兜扫补失败重试；技能
 *   侧没有兜扫，若先清，一次失败就丢掉该批增量。改为 triggerFollow 成功
 *   resolve 才 clearFollowCheck；失败保留检查，下个 sweep 重试同一范围。
 * - 同检查去重：先清语义下重复触发不存在；现在检查活到成功为止，连续两个
 *   sweep 会看到同一条检查——进行中的（项目, 会话）组合跳过，settle 后由
 *   重试计数管住无限失败。
 * - 重试上限：内存计数（daemon 重启归零，与唤醒预算同取舍），同一检查连败
 *   MAX_ATTEMPTS 次后清除并记日志——一个永久失败批次不该卡死该项目后续的
 *   检查消费（pendingFollowChecks 是逐条消费的，但账本条目无界增长没有意义）。
 *
 * 空闲门禁复用 followGateDue（记忆侧同一纯函数）：end_turn 后 idleMinutes
 * 内无新活动才触发；end_turn 后已有更新活动 → 清掉旧检查（新 run 收尾钩子
 * 的粗查按全项目增量重排，语义等价记忆侧 I-1）。
 */
import type { KclawConfig, SessionStore } from "@kclaw/core"
import type { SkillEvolutionScheduleBook, SkillEvolutionTriggers } from "@kclaw/core"
import { followGateDue } from "./memory-scheduler.js"

const DEFAULT_SCAN_MS = 60_000
/** 同一检查的连续失败上限；到顶清除该检查并记日志。 */
const MAX_ATTEMPTS = 3

export interface SkillSchedulerHandle { stop(): Promise<void> }

export function startSkillScheduler(deps: {
  system: SkillEvolutionScheduleBook & Pick<SkillEvolutionTriggers, "triggerFollow">
  sessions: SessionStore
  config: KclawConfig
  /** 项目 workdir 集合：与记忆调度器同源（daemon 维护的去重集合）。 */
  workdirs: () => string[]
  /** 扫描节拍，默认 60s。 */
  intervalMs?: number
  now?: () => Date
  log?: (m: string) => void
}): SkillSchedulerHandle {
  const log = deps.log ?? ((m) => console.error(m))
  const now = deps.now ?? (() => new Date())
  const intervalMs = deps.intervalMs ?? DEFAULT_SCAN_MS
  const inFlight = new Set<Promise<void>>()
  /** 进行中的检查（项目|会话）：不清检查语义下防同批重复触发。 */
  const busy = new Set<string>()
  /** 同一检查的连续失败计数；成功或放弃即清。 */
  const attempts = new Map<string, number>()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  async function sweep(): Promise<void> {
    const evo = deps.config.skills?.evolution
    if (evo?.enabled !== true || (evo.idleMinutes ?? 0) <= 0) return
    const idleMinutes = evo.idleMinutes ?? 0
    for (const workdir of deps.workdirs()) {
      if (stopped) return
      for (const check of deps.system.pendingFollowChecks(workdir)) {
        if (stopped) return
        const key = `${workdir}|${check.sessionId}`
        if (busy.has(key)) continue
        // 会话已删（meta 缺失）的挂起检查无条件清掉：归属会话没了，检查没有
        // 继续存在的意义，空跑一次提炼只剩噪音（判据同 memory 系统的先例）。
        if (deps.sessions.meta(check.sessionId) === undefined) {
          deps.system.clearFollowCheck(workdir, check.sessionId)
          continue
        }
        const activity = deps.system.lastActivity(workdir)
        if (activity !== "" && Date.parse(activity) > Date.parse(check.endTurnAt)) {
          // I-1：end_turn 后已有更新活动——旧锚点被取代；新 run 收尾的粗查
          // 若仍卷入会重排（clear-then-add），这里清旧即可。
          deps.system.clearFollowCheck(workdir, check.sessionId)
          continue
        }
        if (!followGateDue(check.endTurnAt, now().toISOString(), { idleMinutes, lastActivityAt: activity })) continue
        busy.add(key)
        const p = deps.system.triggerFollow(workdir, check.sessionId)
          .then(() => {
            attempts.delete(key)
            // 成功才清：失败批次的增量留在检查里，下个 sweep 重试同一范围。
            deps.system.clearFollowCheck(workdir, check.sessionId)
          })
          .catch((e) => {
            const n = (attempts.get(key) ?? 0) + 1
            attempts.set(key, n)
            if (n >= MAX_ATTEMPTS) {
              attempts.delete(key)
              deps.system.clearFollowCheck(workdir, check.sessionId)
              log(`kclaw skills follow failed ${n} times for ${check.sessionId}, check abandoned: ${String(e)}`)
            } else {
              log(`kclaw skills follow failed (attempt ${n}/${MAX_ATTEMPTS}, kept for retry): ${String(e)}`)
            }
          })
          .finally(() => { busy.delete(key) })
        inFlight.add(p); void p.finally(() => inFlight.delete(p))
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
