/**
 * 技能 curator 调度器：每日一次的闲时扫描宿主。
 *
 * 本地时间过了 skills.curator.hour（默认凌晨 4 点）且今天未跑过则执行
 * curateGlobalSkills（stale 标记 + 归档移动，只动 AI 自建技能）；daemon
 * 凌晨未开时开机后首个 sweep 补跑。上次运行日期存
 * <skillsDir>/.curator/lastRun（本地日期判重，与 memory-scheduler 同口径）。
 * 定时器骨架（首扫 + interval + 进行中记录 + 停机等待）在 host-kit。
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { KclawConfig } from "@kclaw/core"
import { curateGlobalSkills, type CuratorConfig, type CuratorReport } from "@kclaw/core"
import { dailyGateDue, localDate, startIntervalHost } from "./host-kit.js"

const DEFAULT_SCAN_MS = 60_000

function lastRunDate(skillsDir: string): string | undefined {
  try {
    return readFileSync(join(skillsDir, ".curator", "lastRun"), "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

function markLastRun(skillsDir: string, date: string): void {
  try {
    mkdirSync(join(skillsDir, ".curator"), { recursive: true })
    writeFileSync(join(skillsDir, ".curator", "lastRun"), `${date}\n`, "utf8")
  } catch {
    // 防重入标记写失败最坏情况 = 同日再扫一次（幂等），不致命
  }
}

export interface SkillCuratorHandle { stop(): Promise<void> }

export function startSkillCurator(deps: {
  config: KclawConfig
  /** 全局技能目录（<home>/skills）：curator 只管全局作用域。 */
  skillsDir: string
  /** 扫描节拍，默认 60s。 */
  intervalMs?: number
  now?: () => Date
  log?: (m: string) => void
}): SkillCuratorHandle {
  const log = deps.log ?? ((m) => console.error(m))
  const now = deps.now ?? (() => new Date())
  const handle = startIntervalHost({
    label: "skill curator",
    intervalMs: deps.intervalMs ?? DEFAULT_SCAN_MS,
    onError: (err) => log(`kclaw skill curator sweep failed: ${String(err)}`),
    async sweep() {
      const curator = resolveCuratorConfig(deps.config)
      if (!curator.enabled) return
      const t = now()
      // 每日一次判定在 host-kit（dailyGateDue）：时刻判定 + 本地日期判重单源。
      if (!dailyGateDue(t, curator.hour, lastRunDate(deps.skillsDir))) return
      markLastRun(deps.skillsDir, localDate(t))
      const report: CuratorReport = curateGlobalSkills(deps.skillsDir, curator, t)
      if (report.stale.length > 0) {
        log(`kclaw skill curator: marked stale (≥${curator.staleDays}d idle): ${report.stale.join(", ")}`)
      }
      if (report.archived.length > 0) {
        log(`kclaw skill curator: archived to .archive/ (≥${curator.archiveDays}d idle): ${report.archived.join(", ")}${report.linksRemoved.length > 0 ? `; removed dangling links: ${report.linksRemoved.join(", ")}` : ""}`)
      }
    },
  })
  return { stop: () => handle.stop() }
}

/** config 节的读取与保底（默认值来自 defaultConfig；缺字段回退同款）。 */
function resolveCuratorConfig(config: KclawConfig): CuratorConfig {
  const c = config.skills?.curator
  return {
    enabled: c?.enabled ?? true,
    staleDays: c?.staleDays ?? 14,
    archiveDays: c?.archiveDays ?? 30,
    hour: c?.hour ?? 4,
  }
}
