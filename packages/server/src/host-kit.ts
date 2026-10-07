/**
 * daemon 常驻宿主的共享骨架。定时宿主（定时任务 tick、记忆调度器、技能
 * 调度器）各自复制的"立即首扫 + setInterval + stopped 标志 + 在飞 Promise
 * 记账 + 停机等待"样板收在这里；无定时器的宿主（goal 循环挂在空闲边缘）
 * 只用在飞记账这一半（createTracker）。
 *
 * 单次 sweep 抛错被接住并交给 onError：节拍必须活过自己的失败，一个坏
 * sweep 不能终止宿主（此前记忆/技能调度器的裸 `void sweep()` 会把异常
 * 漏成 unhandled rejection）。
 *
 * followGateDue 是两个跟随检查调度器（记忆、技能进化）共用的空闲门禁
 * 纯函数，放在这里避免宿主之间横向 import。dailyGateDue 同理：skill
 * curator 与记忆夜间内化共用的"每日过点一次"门禁（时刻判定 + 本地日期
 * 判重），进度标记的落盘位置由各宿主自留（.curator/lastRun 与 state.json
 * 的 nightlyLastRun 是有意的两处存储）。
 */

/** 本地日期 YYYY-MM-DD（每日一次门禁的判重键；与触发判定同用本地时间）。 */
export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 每日过点门禁（纯函数）：本地时刻过了 hour 且今天（本地日期）未跑 → due。
 * hour < 0 = 该任务关闭。上次运行日期由调用方读取、触发发起后由调用方
 * 标记（标记时机各宿主自持：防重入优先于失败重试）。
 */
export function dailyGateDue(now: Date, hour: number, lastRunDate: string | undefined): boolean {
  if (hour < 0) return false
  if (now.getHours() < hour) return false
  return lastRunDate !== localDate(now)
}

/**
 * 跟随门禁判定（纯函数）：end_turn 之后 idleMinutes 内无新活动 → due。
 * 空活动记录（无会话）视作"end_turn 即最后活动"，保证重启后可补查。
 */
export function followGateDue(
  endTurnAt: string, nowISO: string,
  opts: { idleMinutes: number; lastActivityAt: string },
): boolean {
  const end = Date.parse(endTurnAt)
  const activity = opts.lastActivityAt === "" ? end : Date.parse(opts.lastActivityAt)
  return Date.parse(nowISO) - end >= opts.idleMinutes * 60_000 && activity <= end
}

/** 在飞 Promise 记账：track 登记并在落定后自移除；settleAll 等快照落定。 */
export interface Tracker {
  track(p: Promise<void>): void
  settleAll(): Promise<void>
}

export function createTracker(): Tracker {
  const inFlight = new Set<Promise<void>>()
  return {
    // catch 分支自吞：track 不改变 Promise 的处理状态，拒绝由任务自己的
    // .catch 或调用方的 await 负责；这里只负责记账与停机等待。
    track(p) {
      inFlight.add(p)
      void p.catch(() => undefined).finally(() => inFlight.delete(p))
    },
    async settleAll() {
      await Promise.allSettled([...inFlight])
    },
  }
}

/** 定时宿主句柄：sweep 循环用 stopped 在中途退出，track 登记 fire-and-forget 任务。 */
export interface IntervalHost {
  /** stop() 调用后为 true；进行中的 sweep 用它尽早收手。 */
  readonly stopped: boolean
  track(p: Promise<void>): void
  /** 清定时器并等待全部在飞任务落定（settle 后新任务仍可登记，快照语义）。 */
  stop(): Promise<void>
}

/**
 * 起一个定时宿主：立即首扫一次，之后每 intervalMs 一扫；sweep 抛错经
 * onError 记日志后丢弃，节拍继续。宿主句柄上的 stopped/track 传入 sweep，
 * 供循环中途退出与登记 fire-and-forget 任务。
 */
export function startIntervalHost(opts: {
  /** 失败日志与默认 onError 的标签。 */
  label: string
  intervalMs: number
  sweep: (host: IntervalHost) => Promise<void> | void
  /** sweep 整体抛错的去向；缺省 console.error（带 label）。 */
  onError?: (err: unknown) => void
}): IntervalHost {
  const onError = opts.onError ?? ((err) => console.error(`kclaw ${opts.label} sweep failed:`, err))
  const tracker = createTracker()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined
  const host: IntervalHost = {
    get stopped() {
      return stopped
    },
    track: (p) => tracker.track(p),
    async stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      await tracker.settleAll()
    },
  }
  async function runSweep(): Promise<void> {
    if (stopped) return
    try {
      await opts.sweep(host)
    } catch (err) {
      onError(err)
    }
  }
  void runSweep()
  timer = setInterval(() => void runSweep(), opts.intervalMs)
  return host
}
