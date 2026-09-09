import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Well-known on-disk locations under the kclaw home directory. */
export interface KclawPaths {
  /** Root data directory. Resolution order: explicit param > KCLAW_HOME env > ~/.kclaw */
  home: string
  /** ~/.kclaw/config.yaml — provider/permissions/memory settings */
  config: string
  /** ~/.kclaw/AGENTS.md — agent persona injected into the system prompt */
  agentsMd: string
  /** ~/.kclaw/skills/<skill-name>/SKILL.md — global skill packages */
  skillsDir: string
  /** ~/.kclaw/hooks/<name>.js|.mjs|.ts — user hook files (flat, self-declared position) */
  hooksDir: string
  /** ~/.kclaw/memory */
  memoryDir: string
  /** ~/.kclaw/memory/notes — one markdown file per memory note */
  memoryNotesDir: string
  /** ~/.kclaw/memory/index.db — SQLite FTS5 index, rebuildable from notes */
  memoryIndexDb: string
  /** ~/.kclaw/sessions/<session-id>/ */
  sessionsDir: string
  /** ~/.kclaw/jobs.db — scheduled job state */
  jobsDb: string
  /** Per-run token usage ledger (<home>/usage.db). */
  usageDb: string
  /** ~/.kclaw/attachments/<session-id>/ — large attachment spillover */
  attachmentsDir: string
  /** ~/.kclaw/spill — full tool output kept readable when the model view truncates */
  spillDir: string
  /** ~/.kclaw/logs */
  logsDir: string
}

/**
 * KCLAW_HOME env value, with empty/whitespace-only strings treated as unset:
 * a blank-but-present env must not be adopted (with `??` it made every path
 * relative to cwd instead of falling through to ~/.kclaw).
 */
function envHome(): string | undefined {
  const v = process.env.KCLAW_HOME
  return v !== undefined && v.trim() !== "" ? v : undefined
}

/**
 * Resolve the kclaw directory layout and create the directory tree.
 * Parent dirs are created with mkdirSync(recursive); files (config.yaml,
 * jobs.db, ...) are only path strings and are not created here.
 */
export function resolvePaths(home?: string): KclawPaths {
  const root = home ?? envHome() ?? join(homedir(), ".kclaw")
  const paths: KclawPaths = {
    home: root,
    config: join(root, "config.yaml"),
    agentsMd: join(root, "AGENTS.md"),
    skillsDir: join(root, "skills"),
    hooksDir: join(root, "hooks"),
    memoryDir: join(root, "memory"),
    memoryNotesDir: join(root, "memory", "notes"),
    memoryIndexDb: join(root, "memory", "index.db"),
    sessionsDir: join(root, "sessions"),
    jobsDb: join(root, "jobs.db"),
    usageDb: join(root, "usage.db"),
    attachmentsDir: join(root, "attachments"),
    spillDir: join(root, "spill"),
    logsDir: join(root, "logs"),
  }
  for (const dir of [paths.memoryNotesDir, paths.sessionsDir, paths.attachmentsDir, paths.spillDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true })
  }
  return paths
}
