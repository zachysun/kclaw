import { readFileSync } from "node:fs"
import { writeFileAtomic } from "./atomic.js"
import { DEFAULT_LLM_TIMEOUT_MS } from "../provider/http.js"
import type { KclawPaths } from "./paths.js"
import type { NotifyChannel } from "../notify/notify.js"
import { isPermissionMode, type PermissionMode } from "../permissions/modes.js"
import { DEFAULT_SENSITIVE_FILES } from "../permissions/sensitive-files.js"
import { validateWaterlineConfig } from "../session/waterlines.js"

/**
 * Wire API format a provider entry speaks. "openai" is the OpenAI-compatible
 * chat-completions protocol (also what DeepSeek/Ollama speak); "anthropic" is
 * the Anthropic Messages protocol (x-api-key + anthropic-version headers,
 * with the same key also sent as Authorization: Bearer for gateways that
 * only read Bearer).
 */
export type ProviderApiFormat = "openai" | "anthropic"

/** One provider entry: a reachable endpoint plus the single model it serves. */
export interface ProviderEntry {
  /** Omitted means "openai". */
  format?: ProviderApiFormat
  baseUrl: string
  apiKey: string
  model: string
  /** 模型上下文窗口（token）。配置后压缩预算取 min(会话 contextTokens, 此值)；不写则不设上限。 */
  contextWindow?: number
  /** 单次回复的输出上限（token）。配置后随请求下发 max_tokens；不写则沿用供应商默认。 */
  maxOutput?: number
  /**
   * Prompt-cache markers（"auto" | "off"，缺省 auto）。auto：请求带
   * promptCache 时适配器加缓存标记（Anthropic cache_control 断点 /
   * OpenAI prompt_cache_key）；off：即使请求带该字段也不加（可疑端点的
   * 显式退路，如对陌生字段回 400 的网关）。端点运行时回 400 还有适配器
   * 内的剥除重试与裁决记忆兜底，本配置是不等 400 的主动关闭。
   */
  promptCache?: "auto" | "off"
}

/** Entries may omit `format`; everything downstream reads through this. */
export function resolveProviderFormat(entry: ProviderEntry): ProviderApiFormat {
  return entry.format ?? "openai"
}

/** `sandbox:` section of the config file (daemon-level). */
export interface SandboxConfig {
  enabled: boolean
  /** Extra realpath write roots (e.g. the npm cache dir). */
  writeRoots: string[]
  /**
   * 沙箱内网络开关（`"allow" | "deny"`，默认 `"allow"`）。deny 时
   * exec 子进程不可建出站/入站连接（Seatbelt `deny network-outbound/inbound`、
   * bwrap `--unshare-net`）；web_search/web_fetch 在 daemon 进程内执行、不走
   * exec 子进程，不受此开关影响。
   */
  network?: "allow" | "deny"
}

export interface KclawConfig {
  providers: {
    default: string
    entries: Record<string, ProviderEntry>
    /**
     * Per-request llm timeout the daemon passes to the provider client:
     * bounds the fetch AND the SSE body so a hung provider
     * stream can never park a run forever. Defaults to 120s (defaultConfig).
     */
    timeoutMs?: number
  }
  permissions: {
    allow: string[]
    deny: string[]
    confirmTimeoutMs: number
    sessionGrants: boolean
    autoLearnThreshold?: number
    /** 新会话的初始权限模式（创建时固化为 meta.mode）。默认 "default"。 */
    defaultMode?: PermissionMode
    /**
     * 敏感文件名模式（basename glob，如 ".env*"、"*.pem"）：fs 类工具命中
     * 这些文件时不吃 safe/acceptEdits 免审，一律走确认；显式 allow/learned
     * 规则与 run 内 once 批准仍可放行。设置即整体替换内置清单（内置清单见
     * permissions/engine.ts 的 DEFAULT_SENSITIVE_FILES）。
     */
    sensitiveFiles?: string[]
  }
  memory: {
    write: { immediate: boolean; manual: boolean; intervalMinutes: number; idleMinutes: number }
    /** 提取与沉淀用的模型；空 = 回退到主对话模型。 */
    extractModel: string
    /** 线多少天无新情节转 inactive。 */
    threadInactiveDays: number
    /** 沉淀开关。 */
    consolidate: boolean
    /**
     * 夜间闲时沉淀的本地小时（0-23；负值 = 关闭）。调度器在本地时间过了该点后
     * 对每个项目做一次夜间沉淀（daemon 凌晨未开则开机后补跑）；仍受 consolidate
     * 总开关管。默认 3（凌晨 3 点）。
     */
    consolidateHour: number
    /** embedding 判定链：model 为空 = 向量路整体不启用。 */
    embedding: { provider: string; model: string }
    /** 每轮注入（认知常驻 + 情节检索）token 上限。 */
    injectTokenBudget: number
  }
  web: {
    tavilyApiKey: string
    /**
     * AbortSignal timeout applied to every web tool fetch (search + page
     * fetch), so a hung host can never park a run forever. Defaults to
     * 20s (defaultConfig).
     */
    timeoutMs?: number
    /**
     * Opt out of web_fetch's private/loopback target denial (SSRF guard):
     * true allows fetching e.g. http://127.0.0.1:11434 (a local Ollama
     * endpoint). Defaults to false (defaultConfig).
     */
    allowPrivateNetworks?: boolean
  }
  exec: { timeoutMs: number; maxOutputBytes: number }
  /**
   * Exec OS sandbox (permission batch A). When enabled and the platform
   * sandbox (macOS sandbox-exec / Linux bubblewrap) is available, `default`
   * and `acceptEdits` modes auto-pass sandboxable exec commands (grantedBy
   * "sandboxed") and every exec runs inside the sandbox: workspace + tmp
   * writable, home read-only with ~/.kclaw masked. Unavailable sandbox falls
   * back to manual confirmation (fail-closed — never a bare run). Defaults
   * to enabled with no extra write roots (defaultConfig).
   */
  sandbox?: SandboxConfig
  /** Hook 系统。不写时各取读取处的 ?? 默认值。 */
  hooks?: { /** 单个 hook 处理器的时限（毫秒）；超时按失败处理（fail-open）。 */ timeoutMs?: number }
  sessions: {
    recycleBinTtlMs: number
    /** Context token budget. Default 128000 (resolveContextTokens applies it). */
    contextTokens?: number
    /** Compaction waterlines (ratios of the budget): defaults and the target < ahead < at < panic ordering are owned by the waterlines module, which also validates them at load time. */
    compactAtRatio?: number
    compactTargetRatio?: number
    compactPanicRatio?: number
    compactAheadRatio?: number
    compactPackRatio?: number
    /** Tool results kept verbatim in the provider view. 0 = no count-based eviction (default). */
    toolResultKeep?: number
    /** 工具死循环守卫：同一工具调用（同名同参数）连续执行 N 次后，向该次结果附加换策略提醒。0 = 关闭；默认 5（读取处保底）。 */
    toolLoopMaxRepeats?: number
    /** 不带 disposition 的 send_message 取"会话覆盖 ?? 此默认"。默认 "steer"。 */
    defaultDisposition?: "steer" | "wait" | "interrupt"
    /** ask_user_questions 的等待上限（毫秒）。默认 600000（10 分钟）。 */
    askTimeoutMs?: number
  }
  /**
   * Job-finish notifications. Delivery failures are only logged (onError),
   * never retried and never thrown. An empty channels list disables
   * notifications entirely (zero cost).
   */
  notify: { channels: NotifyChannel[]; timeoutMs?: number }
  /**
   * Token cost pricing (USD per 1M tokens per model) for the usage view.
   * An empty map = tokens shown, cost 0.
   */
  usage?: { prices?: Record<string, { inputPerM?: number; outputPerM?: number }> }
  /**
   * Subagent delegation (issue #16). Defaults to maxConcurrent 4
   * (defaultConfig).
   */
  subagents?: {
    /** Live subagents allowed per parent run at once; an over-cap spawn returns an immediate error result. */
    maxConcurrent?: number
    /** Live BACKGROUND subagents allowed per parent session (issue #22), counted separately from maxConcurrent. Default 4. */
    maxBackground?: number
  }
  /**
   * Agent team. Defaults in defaultConfig. Invalid values fall back
   * per-field with one warning (parseConfig).
   */
  team?: {
    /** Roster cap, failed spawns included. Default 8. */
    maxMembers?: number
    /** Concurrently running members (idle members are free). Default 4. */
    maxActive?: number
    mailbox?: {
      /** Unread entries allowed per inbox; over-cap sends fail loudly. Default 64. */
      maxUnreadPerTarget?: number
      /** Single-message byte cap. Default 65536. */
      maxMessageBytes?: number
    }
    taskBoard?: {
      /** Total tasks (terminal states included); over-cap creation fails loudly. Default 64. */
      maxTasks?: number
    }
  }
  /**
   * Skill packages (the same `<home>/skills` the run assembly scans).
   * Defaults in defaultConfig. Invalid values fall back per-field with
   * one warning (parseConfig, team style).
   */
  skills?: {
    /**
     * Skill evolution (proposal-based self-improvement). `enabled: false`
     * means the feature is fully inert: no follow checks are scheduled, the
     * scheduler consumes nothing, and the skill_create tool answers with a
     * fixed closed-message. Existing proposal files stay listable either
     * way.
     */
    evolution?: {
      /** Master switch. Default true. */
      enabled?: boolean
      /**
       * Idle window (minutes) after a run ends before the extraction check
       * may fire, independent of memory.write.idleMinutes. 0 disables the
       * delayed follow-up entirely (skill_create stays the only proposal
       * path). Negative/non-integer falls back to 10 with a warning.
       */
      idleMinutes?: number
    }
    /**
     * 技能 curator（学习循环的生命周期半场）：按使用遥测对"AI 自建"的全局
     * 技能做 stale 标记与归档。归档 = 整目录移入 <skillsDir>/.archive/
     * （移动不是删除，可随时移回）；用户手写技能、pin 技能与复用链接豁免。
     */
    curator?: {
      /** Master switch. Default true. */
      enabled?: boolean
      /** 连续未使用多少天后标记 stale。默认 14。 */
      staleDays?: number
      /** 连续未使用多少天后移入 .archive/。默认 30。 */
      archiveDays?: number
      /** 每日扫描的小时（本地时间，过了即扫、每日一次）。默认 4；负值关闭。 */
      hour?: number
    }
  }
  /**
   * /goal goal loop (issue #47). The ONLY knob is the judge's provider entry
   * key: empty = each goal session judges on its own session model. Loop
   * caps are code constants (goal/limits.ts), not config.
   */
  goals?: {
    /** Provider entry key for the goal judge; "" = the session's own model line. */
    judge?: string
  }
  /**
   * Daemon server. Defaults in defaultConfig; an absent port means an
   * OS-assigned ephemeral port per launch. Invalid values fall back
   * per-field with one warning (parseConfig).
   */
  server?: {
    /**
     * Fixed listen port for the daemon (1-65535). Pinning it keeps the
     * WebUI URL stable across daemon restarts; unset = an ephemeral port
     * per launch. An explicit --port flag on the server bin wins over this.
     */
    port?: number
  }
  workspace: string
}

export const defaultConfig: KclawConfig = {
  providers: { default: "", entries: {}, timeoutMs: DEFAULT_LLM_TIMEOUT_MS },
  permissions: { allow: [], deny: ["exec:sudo*", "exec:rm -rf*"], confirmTimeoutMs: 120_000, sessionGrants: true, defaultMode: "default", sensitiveFiles: DEFAULT_SENSITIVE_FILES },
  memory: {
    write: { immediate: true, manual: true, intervalMinutes: 30, idleMinutes: 10 },
    extractModel: "",
    threadInactiveDays: 14,
    consolidate: true,
    consolidateHour: 3,
    embedding: { provider: "", model: "" },
    injectTokenBudget: 1000,
  },
  web: { tavilyApiKey: "", timeoutMs: 20_000, allowPrivateNetworks: false },
  exec: { timeoutMs: 60_000, maxOutputBytes: 100 * 1024 },
  sandbox: { enabled: true, writeRoots: [] },
  sessions: { recycleBinTtlMs: 30 * 24 * 60 * 60 * 1000, defaultDisposition: "steer" as const },
  notify: { channels: [], timeoutMs: 10_000 },
  usage: { prices: {} },
  subagents: { maxConcurrent: 4, maxBackground: 4 },
  team: {
    maxMembers: 8,
    maxActive: 4,
    mailbox: { maxUnreadPerTarget: 64, maxMessageBytes: 65536 },
    taskBoard: { maxTasks: 64 },
  },
  skills: { evolution: { enabled: true, idleMinutes: 10 }, curator: { enabled: true, staleDays: 14, archiveDays: 30, hour: 4 } },
  goals: { judge: "" },
  workspace: process.cwd(),
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge `override` onto `defaults`: plain objects recurse per key,
 * arrays and scalars replace wholesale. Neither input is mutated.
 */
function deepMerge<T>(defaults: T, override: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(override)) {
    return (override === undefined ? defaults : override) as T
  }
  const merged: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    merged[key] = deepMerge(merged[key], value)
  }
  return merged as T
}

/**
 * Load the config file, deep-merged over defaults. A missing or empty file
 * yields the defaults; an unparseable file throws (silently falling back
 * could drop the user's permission rules). credentials.json (0600) is then
 * merged OVER the result: provider apiKeys and the tavily key live there
 * since the credentials split; a key still present inline in config.json
 * (pre-migration) applies only when the credentials file has none.
 *
 * The returned config never shares references with defaultConfig:
 * the merge starts from a clone, so callers may mutate the result freely.
 */
export function loadConfig(paths: KclawPaths): KclawConfig {
  const json = readIfPresent(paths.configJson)
  const config = json !== undefined ? parseConfig(json, paths.configJson) : structuredClone(defaultConfig)
  return applyCredentials(config, readCredentials(paths))
}

/** credentials.json 的形状：provider 条目的 apiKey 与 web 检索的 tavily key。 */
export interface CredentialsFile {
  providers?: Record<string, { apiKey?: string }>
  web?: { tavilyApiKey?: string }
}

function readCredentials(paths: KclawPaths): CredentialsFile {
  const raw = readIfPresent(paths.credentialsJson)
  if (raw === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? (parsed as CredentialsFile) : {}
  } catch (err) {
    console.warn(`kclaw credentials: ignoring unparseable ${paths.credentialsJson}: ${(err as Error).message}`)
    return {}
  }
}

/**
 * 凭据字段位置声明——"哪些字段是凭据"的单一出处，读（credentials.json
 * 覆盖 config.json）与写（config.json 搬出并留空串占位）两侧共用。新增
 * 凭据字段 = 在这里加一个位置，两侧自动一致；漏一处曾经意味着密钥静默
 * 留在（或回到）config.json。
 */
interface CredentialLocation {
  /** 从凭据文档读覆盖值（undefined = 未设）。 */
  readCreds(f: CredentialsFile): string | undefined
  /** 非空凭据值写入 config（apply 侧；不存在的位置忽略）。 */
  writeConfig(c: KclawConfig, v: string): void
  /** 非空值搬进凭据文档并把 config 留成空串占位（save 侧）。 */
  collect(c: KclawConfig, f: CredentialsFile): void
}

const WEB_TAVILY_KEY: CredentialLocation = {
  readCreds: (f) => f.web?.tavilyApiKey,
  writeConfig: (c, v) => { c.web.tavilyApiKey = v },
  collect: (c, f) => {
    if (c.web.tavilyApiKey === "") return
    f.web ??= {}
    f.web.tavilyApiKey = c.web.tavilyApiKey
    c.web.tavilyApiKey = ""
  },
}

/** providers.entries[].apiKey：按条目名展开的映射位（两个方向共用同一模板）。 */
function providerEntryLocation(name: string): CredentialLocation {
  return {
    readCreds: (f) => f.providers?.[name]?.apiKey,
    writeConfig: (c, v) => {
      const entry = c.providers.entries[name]
      if (entry === undefined) return // 条目不存在的孤儿引用忽略
      entry.apiKey = v
    },
    collect: (c, f) => {
      const entry = c.providers.entries[name]
      if (entry === undefined || entry.apiKey === "") return
      f.providers ??= {}
      f.providers[name] = { apiKey: entry.apiKey }
      entry.apiKey = ""
    },
  }
}

function applyCredentials(config: KclawConfig, creds: CredentialsFile): KclawConfig {
  // 凭据文件优先：同一条目两边都有值时 credentials.json 赢——config.json
  // 里的内联 apiKey 只是首次保存前的迁移回落。条目不存在的孤儿引用忽略。
  const locations = [WEB_TAVILY_KEY, ...Object.keys(creds.providers ?? {}).map(providerEntryLocation)]
  for (const loc of locations) {
    const v = loc.readCreds(creds)
    if (typeof v === "string" && v !== "") loc.writeConfig(config, v)
  }
  return config
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function parseConfig(raw: string, path: string): KclawConfig {
  let file: unknown
  try {
    file = raw.trim() === "" ? null : JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid json in ${path}: ${(err as Error).message}`)
  }
  if (file === null || file === undefined) return structuredClone(defaultConfig)
  if (!isPlainObject(file)) {
    throw new Error(`invalid config in ${path}: expected a json mapping`)
  }
  const merged = deepMerge(structuredClone(defaultConfig), file)
  // permissions.defaultMode 会进事件流（session.created 的 mode 字段），必须严格校验；
  // 非法值（含 YAML 里 `permissions:` 空节解析为 null 的整节非对象）回落 "default" 并
  // 警告。整节非对象时按默认节整体回落（没有可保留的合法内容）；字段非法时只重置该字段，
  // 不碰用户已有的 allow/deny 等。
  const perms = merged.permissions
  if (!isPlainObject(perms)) {
    console.warn("kclaw config: permissions section is not a mapping; falling back to defaults")
    merged.permissions = { ...defaultConfig.permissions }
  } else if (!isPermissionMode(perms.defaultMode)) {
    console.warn(`kclaw config: permissions.defaultMode "${String(perms.defaultMode)}" is invalid; falling back to "default"`)
    merged.permissions.defaultMode = "default"
  }
  // Compaction waterlines: same style — values out of (0,1] or out of order
  // (target < ahead < at < panic) fall back to the module defaults with one
  // warning; the pack line is validated independently (decoupled by design).
  validateWaterlineConfig(merged.sessions)
  validateProviderEntries(merged)
  validateTeamConfig(merged)
  validateSkillsConfig(merged)
  validateServerConfig(merged)
  validateGoalsConfig(merged)
  return merged
}

/**
 * Provider entry promptCache validation (waterline style): a value outside
 * "auto" | "off" falls back to auto (delete = undefined) with one warning per
 * entry. Never throws; unknown keys stay untouched.
 */
function validateProviderEntries(merged: KclawConfig): void {
  for (const [name, entry] of Object.entries(merged.providers.entries)) {
    if (entry.promptCache !== undefined && entry.promptCache !== "auto" && entry.promptCache !== "off") {
      console.warn(`kclaw config: providers.entries.${name}.promptCache ${String(entry.promptCache)} is invalid; falling back to "auto"`)
      entry.promptCache = undefined
    }
  }
}

/**
 * Goals section validation (team style): a non-mapping section falls back
 * wholesale; a non-string judge resets to "" (judge on the session model),
 * each with one warning. Unknown entry keys are NOT rejected here — the
 * entry may be added later; resolution at judge time falls back to the
 * session model when the key matches nothing. Never throws.
 */
function validateGoalsConfig(merged: KclawConfig): void {
  const goals = merged.goals
  if (goals === undefined) return
  if (!isPlainObject(goals)) {
    console.warn("kclaw config: goals section is not a mapping; falling back to defaults")
    merged.goals = { judge: "" }
    return
  }
  if (goals.judge !== undefined && typeof goals.judge !== "string") {
    console.warn(`kclaw config: goals.judge ${String(goals.judge)} is invalid; falling back to the session model`)
    goals.judge = ""
  }
}

/**
 * Skills section validation (team style): a non-mapping section (or
 * evolution sub-section) falls back wholesale; a non-boolean enabled or a
 * negative/non-integer idleMinutes falls back per field, each with one
 * warning. idleMinutes 0 is MEANINGFUL (it disables the delayed follow-up
 * while keeping skill_create), so the validity window is >= 0 — only
 * negative and fractional values are invalid. Never throws.
 */
function validateSkillsConfig(merged: KclawConfig): void {
  const skills = merged.skills
  if (skills === undefined) return
  if (!isPlainObject(skills)) {
    console.warn("kclaw config: skills section is not a mapping; falling back to defaults")
    merged.skills = structuredClone(defaultConfig.skills)
    return
  }
  const evolution = skills.evolution
  if (evolution !== undefined) {
    if (!isPlainObject(evolution)) {
      console.warn("kclaw config: skills.evolution section is not a mapping; falling back to defaults")
      skills.evolution = { enabled: false, idleMinutes: 10 }
    } else {
      if (evolution.enabled !== undefined && typeof evolution.enabled !== "boolean") {
        console.warn(`kclaw config: skills.evolution.enabled ${String(evolution.enabled)} is invalid; falling back to false`)
        evolution.enabled = false
      }
      if (evolution.idleMinutes !== undefined && !(typeof evolution.idleMinutes === "number" && Number.isInteger(evolution.idleMinutes) && evolution.idleMinutes >= 0)) {
        console.warn(`kclaw config: skills.evolution.idleMinutes ${String(evolution.idleMinutes)} is invalid; falling back to 10`)
        evolution.idleMinutes = 10
      }
    }
  }
  const curator = skills.curator
  if (curator === undefined) return
  if (!isPlainObject(curator)) {
    console.warn("kclaw config: skills.curator section is not a mapping; falling back to defaults")
    skills.curator = structuredClone(defaultConfig.skills!.curator)
    return
  }
  if (curator.enabled !== undefined && typeof curator.enabled !== "boolean") {
    console.warn(`kclaw config: skills.curator.enabled ${String(curator.enabled)} is invalid; falling back to true`)
    curator.enabled = true
  }
  for (const key of ["staleDays", "archiveDays"] as const) {
    if (curator[key] !== undefined && !(typeof curator[key] === "number" && Number.isInteger(curator[key]) && (curator[key] as number) > 0)) {
      console.warn(`kclaw config: skills.curator.${key} ${String(curator[key])} is invalid; falling back to the default`)
      delete curator[key]
    }
  }
  if (curator.hour !== undefined && !(typeof curator.hour === "number" && Number.isInteger(curator.hour) && curator.hour >= 0 && curator.hour <= 23)) {
    // 负值 = 关闭是 memory.consolidateHour 的语义，这里取同款：非法整数才回默认
    if (typeof curator.hour === "number" && curator.hour < 0) {
      // 合法的关闭表达：保留
    } else {
      console.warn(`kclaw config: skills.curator.hour ${String(curator.hour)} is invalid; falling back to the default`)
      delete curator.hour
    }
  }
}

/**
 * Server section validation (team style): a non-mapping section falls back
 * wholesale; a port outside 1-65535 falls back to unset (the ephemeral-port
 * default), each with one warning. Never throws.
 */
function validateServerConfig(merged: KclawConfig): void {
  const server = merged.server
  if (server === undefined) return
  if (!isPlainObject(server)) {
    console.warn("kclaw config: server section is not a mapping; falling back to defaults")
    delete merged.server
    return
  }
  if (server.port !== undefined && !(typeof server.port === "number" && Number.isInteger(server.port) && server.port >= 1 && server.port <= 65535)) {
    console.warn(`kclaw config: server.port ${String(server.port)} is invalid; falling back to an ephemeral port`)
    delete server.port
  }
}

/**
 * Team section validation: a non-mapping section falls back wholesale; a
 * negative/zero number falls back per field, each with one warning (the
 * waterline style — never throw, never silently keep a value that would
 * break the team limits).
 */
function validateTeamConfig(merged: KclawConfig): void {
  const team = merged.team
  if (team === undefined) return
  const fallback = () => {
    console.warn("kclaw config: team section is not a mapping; falling back to defaults")
    merged.team = structuredClone(defaultConfig.team)
  }
  if (!isPlainObject(team)) {
    fallback()
    return
  }
  const positiveInt = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0
  for (const [label, value, reset] of [
    ["team.maxMembers", team.maxMembers, 8],
    ["team.maxActive", team.maxActive, 4],
  ] as const) {
    if (value !== undefined && !positiveInt(value)) {
      console.warn(`kclaw config: ${label} ${String(value)} is invalid; falling back to ${reset}`)
      ;(team as { maxMembers?: number; maxActive?: number })[label === "team.maxMembers" ? "maxMembers" : "maxActive"] = reset
    }
  }
  if (team.mailbox !== undefined) {
    if (!isPlainObject(team.mailbox)) {
      console.warn("kclaw config: team.mailbox is not a mapping; falling back to defaults")
      team.mailbox = { maxUnreadPerTarget: 64, maxMessageBytes: 65536 }
    } else {
      if (team.mailbox.maxUnreadPerTarget !== undefined && !positiveInt(team.mailbox.maxUnreadPerTarget)) {
        console.warn(`kclaw config: team.mailbox.maxUnreadPerTarget ${String(team.mailbox.maxUnreadPerTarget)} is invalid; falling back to 64`)
        team.mailbox.maxUnreadPerTarget = 64
      }
      if (team.mailbox.maxMessageBytes !== undefined && !positiveInt(team.mailbox.maxMessageBytes)) {
        console.warn(`kclaw config: team.mailbox.maxMessageBytes ${String(team.mailbox.maxMessageBytes)} is invalid; falling back to 65536`)
        team.mailbox.maxMessageBytes = 65536
      }
    }
  }
  if (team.taskBoard !== undefined) {
    if (!isPlainObject(team.taskBoard)) {
      console.warn("kclaw config: team.taskBoard is not a mapping; falling back to defaults")
      team.taskBoard = { maxTasks: 64 }
    } else if (team.taskBoard.maxTasks !== undefined && !positiveInt(team.taskBoard.maxTasks)) {
      console.warn(`kclaw config: team.taskBoard.maxTasks ${String(team.taskBoard.maxTasks)} is invalid; falling back to 64`)
      team.taskBoard.maxTasks = 64
    }
  }
}

/**
 * Serialize config to config.json (atomic whole-file rewrite; 0600) with the
 * credentials split: apiKeys and the tavily key go to credentials.json
 * (0600, written FIRST so a config.json failure can't orphan them), and the
 * corresponding config.json fields are persisted as empty strings. Reading
 * accepts both locations (credentials wins), so a pre-split config.json with
 * inline keys keeps working until the next save migrates it. MCP servers
 * live in ~/.kclaw/mcp.json and are never written here.
 */
export function saveConfig(paths: KclawPaths, config: KclawConfig): void {
  const persisted: KclawConfig = structuredClone(config)
  const credentials: CredentialsFile = {}
  // 字段位置与 applyCredentials 同源（CredentialLocation）：新增凭据字段两侧
  // 自动一致。
  const locations = [WEB_TAVILY_KEY, ...Object.keys(persisted.providers.entries).map(providerEntryLocation)]
  for (const loc of locations) loc.collect(persisted, credentials)
  // 始终重写凭据文件（含空对象）：provider 删除后其 key 必须同时离开磁盘，
  // 不能留上一份陈旧文件继续生效。
  writeFileAtomic(paths.credentialsJson, JSON.stringify(credentials, null, 2) + "\n", 0o600)
  writeFileAtomic(paths.configJson, JSON.stringify(persisted, null, 2) + "\n", 0o600)
}

/**
 * The config locations that can name a provider entry (rename and delete
 * must keep them consistent). Each reference is an accessor pair over the
 * config object; a reference whose current value is the old entry name is
 * rewritten to the new one, any other value (a bare model name, another
 * entry, empty) is left alone.
 */
export const PROVIDER_ENTRY_REFERENCES: ReadonlyArray<{
  get: (config: KclawConfig) => string | undefined
  set: (config: KclawConfig, name: string) => void
}> = [
  { get: (c) => c.providers.default, set: (c, name) => { c.providers.default = name } },
  { get: (c) => c.memory?.extractModel, set: (c, name) => { if (c.memory !== undefined) c.memory.extractModel = name } },
  { get: (c) => c.memory?.embedding?.provider, set: (c, name) => { if (c.memory?.embedding !== undefined) c.memory.embedding.provider = name } },
  { get: (c) => c.goals?.judge, set: (c, name) => { if (c.goals !== undefined) c.goals.judge = name } },
]

/**
 * Move the entry keyed `from` to `to` and rewrite every
 * {@link PROVIDER_ENTRY_REFERENCES} location pointing at it. Session-level
 * references (session meta, jobs, slash commands) keep the old name by
 * design — they fall back to the default entry on their next run, the same
 * semantics as deletion.
 */
export function renameProviderEntry(config: KclawConfig, from: string, to: string): void {
  if (from === to) return
  if (config.providers.entries[from] === undefined) throw new Error(`unknown provider entry: ${from}`)
  if (config.providers.entries[to] !== undefined) throw new Error(`provider entry "${to}" already exists`)
  const entry = config.providers.entries[from]
  delete config.providers.entries[from]
  config.providers.entries[to] = entry
  for (const ref of PROVIDER_ENTRY_REFERENCES) {
    if (ref.get(config) === from) ref.set(config, to)
  }
}

/**
 * Effective compaction/context budget in tokens: min(explicit session cap,
 * model window when the entry declares one), defaulting to 128k when neither
 * exists. `entryKey` is the config entry name a session/user model resolves
 * to (a raw wire model name that matches no entry falls back to the default
 * entry, then to no window). All budget readers — the compaction hooks, the
 * Compactor, the packing budget in run assembly — must resolve through this
 * one helper so a per-model window tightens every line together.
 */
export function resolveContextTokens(config: KclawConfig, entryKey?: string): number {
  const key = entryKey !== undefined && config.providers.entries[entryKey] !== undefined
    ? entryKey
    : config.providers.default
  const window = config.providers.entries[key]?.contextWindow
  const configured = config.sessions.contextTokens
  if (window === undefined || !Number.isFinite(window) || window <= 0) return configured ?? 128_000
  return Math.min(configured ?? Number.POSITIVE_INFINITY, window)
}

/**
 * Resolve a run's model line end to end: a session/user model may name a
 * provider ENTRY ("deepseek") whose wire model is the entry's `.model`
 * ("deepseek-v4-flash"); a name matching no entry is already a raw wire model
 * and passes through unchanged, with entry-key/budget resolution falling back
 * to the configured default entry. Output is everything the request assembly
 * and the manual compact path need: the wire model, the entry key, the
 * effective context budget (resolveContextTokens), and the entry's
 * max_tokens cap when declared. Both call sites resolve through this one
 * helper so the two paths can never disagree on budgets.
 */
export function resolveRunModel(
  config: KclawConfig,
  rawModel: string,
): { model: string; entryKey: string; budget: number; maxOutput?: number } {
  const entryKey = config.providers.entries[rawModel] !== undefined ? rawModel : config.providers.default
  const entry = config.providers.entries[entryKey]
  return {
    model: config.providers.entries[rawModel]?.model ?? rawModel,
    entryKey,
    budget: resolveContextTokens(config, entryKey),
    ...(entry?.maxOutput === undefined ? {} : { maxOutput: entry.maxOutput }),
  }
}

/**
 * A run's raw model with its full precedence: an explicit per-run model >
 * the session's model > the default entry's CURRENT model (Model-tab edits
 * hot-apply) > the launch-resolved model (backs env-only setups with no
 * configured entry) > "". Feeds resolveRunModel, so run assembly and the
 * manual compact path apply the same chain and can never disagree on the
 * raw model, entry key or budget.
 */
export function resolveRunModelLine(
  config: KclawConfig,
  overrides: { inputModel?: string; sessionModel?: string; launchModel?: string },
): { model: string; entryKey: string; budget: number; maxOutput?: number } {
  const fallback = config.providers.entries[config.providers.default]?.model || overrides.launchModel || ""
  return resolveRunModel(config, overrides.inputModel ?? overrides.sessionModel ?? fallback)
}
