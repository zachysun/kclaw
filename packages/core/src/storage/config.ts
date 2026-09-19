import { existsSync, readFileSync, renameSync } from "node:fs"
import { parse } from "yaml"
import { writeFileAtomic } from "./atomic.js"
import { DEFAULT_LLM_TIMEOUT_MS } from "../provider/openai-compat.js"
import type { KclawPaths } from "./paths.js"
import type { NotifyChannel } from "../notify/notify.js"
import type { McpServerConfig } from "../mcp/manager.js"
import { isPermissionMode, type PermissionMode } from "../permissions/modes.js"
import { validateWaterlineConfig } from "../session/waterlines.js"

/**
 * Wire API format a provider entry speaks. "openai" is the OpenAI-compatible
 * chat-completions protocol (also what DeepSeek/Ollama speak); "anthropic" is
 * the Anthropic Messages protocol (x-api-key + anthropic-version headers).
 */
export type ProviderApiFormat = "openai" | "anthropic"

/** One provider entry: a reachable endpoint plus the single model it serves. */
export interface ProviderEntry {
  /** Absent in entries written before the field existed; reads as "openai". */
  format?: ProviderApiFormat
  baseUrl: string
  apiKey: string
  model: string
  /** 模型上下文窗口（token）。配置后压缩预算取 min(会话 contextTokens, 此值)；缺省不设上限。 */
  contextWindow?: number
  /** 单次回复的输出上限（token）。配置后随请求下发 max_tokens；缺省沿用供应商默认。 */
  maxOutput?: number
}

/** Entries may omit `format` (pre-field files); everything downstream reads through this. */
export function resolveProviderFormat(entry: ProviderEntry): ProviderApiFormat {
  return entry.format ?? "openai"
}

/** `sandbox:` section of config.yaml (daemon-level). */
export interface SandboxConfig {
  enabled: boolean
  /** Extra realpath write roots (e.g. the npm cache dir). */
  writeRoots: string[]
  /**
   * 沙箱内网络开关（`"allow" | "deny"`，缺省 `"allow"` 保持既有行为）。deny 时
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
     * stream can never park a run forever. Optional only because older
     * config.yaml files predate it; defaults to 120s (defaultConfig).
     */
    timeoutMs?: number
  }
  permissions: { allow: string[]; deny: string[]; confirmTimeoutMs: number; sessionGrants: boolean; autoLearnThreshold?: number; /** 新会话的初始权限模式（创建时固化为 meta.mode）。缺省 "default"。 */ defaultMode?: PermissionMode }
  memory: {
    write: { immediate: boolean; manual: boolean; intervalMinutes: number; idleMinutes: number }
    /** 提取与内化用的模型；空 = 回落主对话模型。 */
    extractModel: string
    /** 线多少天无新情节转 inactive。 */
    threadInactiveDays: number
    /** 内化开关。 */
    consolidate: boolean
    /**
     * 夜间闲时内化的本地小时（0-23；负值 = 关闭）。调度器在本地时间过了该点后
     * 对每个项目做一次夜间内化（daemon 凌晨未开则开机后补跑）；仍受 consolidate
     * 总开关管。默认 3（凌晨 3 点）。
     */
    consolidateHour: number
    /** embedding 判定链：model 为空 = 向量路整体不启用。 */
    embedding: { provider: string; model: string }
    /** 每轮注入（认知常驻 + 情节检索）token 上限。 */
    injectTokenBudget: number
    /** @deprecated v1 字段（被四触发取代），仅容忍存在，读处一律忽略。 */
    autoExtract?: boolean
  }
  web: {
    tavilyApiKey: string
    /**
     * AbortSignal timeout applied to every web tool fetch (search + page
     * fetch), so a hung host can never park a run forever. Optional only
     * because older config files predate it; defaults to 20s
     * (defaultConfig).
     */
    timeoutMs?: number
    /**
     * Opt out of web_fetch's private/loopback target denial (SSRF guard):
     * true allows fetching e.g. http://127.0.0.1:11434 (a local Ollama
     * endpoint). Optional only because older config files predate it;
     * defaults to false (defaultConfig).
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
   * back to manual confirmation (fail-closed — never a bare run). Optional
   * only because older config files predate it; defaults to enabled with
   * no extra write roots (defaultConfig).
   */
  sandbox?: SandboxConfig
  /**
   * Hook 系统。可选仅因老配置文件早于它；
   * 缺省按读点的 ?? 默认值执行。
   */
  hooks?: { /** 单个 hook 处理器的时限（毫秒）；超时按失败处理（fail-open）。 */ timeoutMs?: number }
  sessions: {
    recycleBinTtlMs: number
    /** DEPRECATED (v1 compaction, inert): compact at N messages. */
    compactThreshold?: number
    /** DEPRECATED (v1 compaction, inert): keep newest N messages verbatim. */
    compactKeep?: number
    /** Context token budget. Default 128000 (resolveContextTokens applies it). */
    contextTokens?: number
    /** Compaction waterlines (ratios of the budget): defaults and the target < ahead < at < panic ordering are owned by the waterlines module, which also validates them at load time. */
    compactAtRatio?: number
    compactTargetRatio?: number
    compactPanicRatio?: number
    compactAheadRatio?: number
    compactPackRatio?: number
    /** Tool results kept verbatim in the provider view. Default 8 (read site applies it). */
    toolResultKeep?: number
    /** 工具死循环守卫：同一工具调用（同名同参数）连续执行 N 次后，向该次结果附加换策略提醒。0 = 关闭；缺省 5（读取处兜底）。 */
    toolLoopMaxRepeats?: number
    /** 不带 disposition 的 send_message 取"会话覆盖 ?? 此默认"。缺省 "steer"。 */
    defaultDisposition?: "steer" | "wait" | "interrupt"
    /** ask_user_questions 的等待上限（毫秒）。缺省 600000（10 分钟）。 */
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
   * Optional only because older config files predate it; empty map =
   * tokens shown, cost 0.
   */
  usage?: { prices?: Record<string, { inputPerM?: number; outputPerM?: number }> }
  /**
   * External MCP servers. Optional only because older config.yaml files
   * predate it; defaults to an empty server map (defaultConfig).
   */
  mcp?: { servers?: Record<string, McpServerConfig> }
  /**
   * Subagent delegation (issue #16). Optional only because older config.yaml
   * files predate it; defaults to maxConcurrent 4 (defaultConfig).
   */
  subagents?: {
    /** Live subagents allowed per parent run at once; an over-cap spawn returns an immediate error result. */
    maxConcurrent?: number
    /** Live BACKGROUND subagents allowed per parent session (issue #22), counted separately from maxConcurrent. Default 4. */
    maxBackground?: number
  }
  /**
   * Agent team. Optional only because
   * older config files predate it; defaults in defaultConfig. Invalid values
   * fall back per-field with one warning (parseConfig).
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
   * Daemon server. Optional only because older config files predate it;
   * an absent port keeps the historical behavior (an OS-assigned ephemeral
   * port per launch). Invalid values fall back per-field with one warning
   * (parseConfig).
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
  permissions: { allow: [], deny: ["exec:sudo*", "exec:rm -rf*"], confirmTimeoutMs: 120_000, sessionGrants: true, defaultMode: "default" },
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
  mcp: { servers: {} },
  subagents: { maxConcurrent: 4, maxBackground: 4 },
  team: {
    maxMembers: 8,
    maxActive: 4,
    mailbox: { maxUnreadPerTarget: 64, maxMessageBytes: 65536 },
    taskBoard: { maxTasks: 64 },
  },
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
 * Load the config file, deep-merged over defaults. config.json is the
 * config file; while it is absent, the pre-json config.yaml is read so an
 * upgraded home keeps working until the first write lands in config.json.
 * A missing or empty file yields the defaults; an unparseable file throws
 * (silently falling back could drop the user's permission rules).
 *
 * The returned config never shares references with defaultConfig:
 * the merge starts from a clone, so callers may mutate the result freely.
 */
export function loadConfig(paths: KclawPaths): KclawConfig {
  const json = readIfPresent(paths.configJson)
  if (json !== undefined) return parseConfig(json, paths.configJson, "json")
  const legacy = readIfPresent(paths.config)
  if (legacy !== undefined) return parseConfig(legacy, paths.config, "yaml")
  return structuredClone(defaultConfig)
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function parseConfig(raw: string, path: string, format: "json" | "yaml"): KclawConfig {
  let file: unknown
  try {
    if (format === "json") {
      file = raw.trim() === "" ? null : JSON.parse(raw)
    } else {
      file = parse(raw)
    }
  } catch (err) {
    throw new Error(`invalid ${format} in ${path}: ${(err as Error).message}`)
  }
  if (file === null || file === undefined) return structuredClone(defaultConfig)
  if (!isPlainObject(file)) {
    throw new Error(`invalid config in ${path}: expected a ${format} mapping`)
  }
  // 首次读到 v1 遗留字段记日志说明已忽略（不改字段、不改行为，只提示）。
  const legacyAutoExtract = (file as { memory?: { autoExtract?: unknown } }).memory?.autoExtract
  if (legacyAutoExtract !== undefined) {
    console.warn("kclaw config: memory.autoExtract is deprecated (v1) and ignored; use memory.write.* instead")
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
  validateTeamConfig(merged)
  validateServerConfig(merged)
  return merged
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
 * Serialize config to config.json (atomic whole-file rewrite; 0600 — holds
 * apiKey plaintext). The first write retires a still-present config.yaml by
 * renaming it to config.yaml.bak: from then on config.json is authoritative
 * and the stale yaml must not read as a live second source.
 *
 * The legacy `mcp` section is stripped before serializing: MCP servers live
 * in ~/.kclaw/mcp.json (the managed source), the config section survives
 * only as a read-compat input at load time and must never be written back
 * (a save could otherwise resurrect deleted servers).
 */
export function saveConfig(paths: KclawPaths, config: KclawConfig): void {
  const firstJsonWrite = !existsSync(paths.configJson)
  const { mcp: _legacyMcp, ...persisted } = config
  writeFileAtomic(paths.configJson, JSON.stringify(persisted, null, 2) + "\n", 0o600)
  if (firstJsonWrite) retireLegacyYaml(paths)
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

function retireLegacyYaml(paths: KclawPaths): void {
  try {
    renameSync(paths.config, `${paths.config}.bak`)
    console.error("kclaw config: legacy config.yaml retired as config.yaml.bak (config.json is the config file now)")
  } catch {
    // No legacy file (or the rename failed) — config.json is authoritative either way.
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
