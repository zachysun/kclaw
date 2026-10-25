/**
 * spill 保留期清理：`sessions.spillRetentionDays`（默认 0 = 永不清理）。
 *
 * spill 文件（<home>/spill/*.txt，0600，可能含敏感输出）只按 mtime 判定——
 * 文件名不带会话归属。软删会话的到期清理是另一条路（scheduler-tick 调
 * SessionStore.purgeExpired，config sessions.recycleBinTtlMs，默认 30 天），
 * 互不相关。清理幂等（目录/文件不存在视为完成），失败只记日志。
 * 定时器骨架复用 host-kit 的 startIntervalHost（与 memory-scheduler 同款）。
 */
import { readdirSync, rmSync, statSync, utimesSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { startIntervalHost } from "./host-kit.js"

/** 一次扫描：删 mtime 早于 now - ttlMs 的文件。返回被删的文件名（日志用）。 */
export function sweepSpillDir(spillDir: string, ttlMs: number, now = Date.now()): string[] {
  if (ttlMs <= 0) return []
  let entries
  try {
    entries = readdirSync(spillDir, { withFileTypes: true })
  } catch {
    return [] // 目录不存在（从未 spill 过）视为无事发生
  }
  const removed: string[] = []
  for (const entry of entries) {
    const path = join(spillDir, entry.name)
    try {
      if (!entry.isFile()) continue
      const mtimeMs = statSync(path).mtimeMs
      if (now - mtimeMs >= ttlMs) {
        rmSync(path, { force: true })
        removed.push(entry.name)
      }
    } catch {
      // 单个文件判定/删除失败：跳过，下一扫再试
    }
  }
  return removed
}

/** 挂载到 daemon 的清理任务（每小时一扫；spillRetentionDays=0 时空转）。 */
export function startSpillRetention(opts: { spillDir: string; retentionDays: number; intervalMs?: number }) {
  const ttlMs = opts.retentionDays * 24 * 60 * 60 * 1000
  if (ttlMs <= 0) {
    // 保留 0 天 = 关闭：仍建目录（spill 写入路径免 mkdir 竞争），但不挂定时器
    try { mkdirSync(opts.spillDir, { recursive: true }) } catch { /* best-effort */ }
    return { stop: async () => {} }
  }
  return startIntervalHost({
    label: "spill retention",
    intervalMs: opts.intervalMs ?? 60 * 60 * 1000,
    sweep: () => {
      const removed = sweepSpillDir(opts.spillDir, ttlMs)
      if (removed.length > 0) console.log(`kclaw spill retention: removed ${removed.length} expired spill file(s)`)
    },
  })
}

// re-export for tests that want to plant old mtimes without touching real clocks
export { utimesSync }
