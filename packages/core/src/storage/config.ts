import { readFileSync } from "node:fs"
import { parse, stringify } from "yaml"
import { writeFileAtomic } from "./atomic.js"
import { DEFAULT_LLM_TIMEOUT_MS } from "../provider/openai-compat.js"
import type { KclawPaths } from "./paths.js"
import type { NotifyChannel } from "../notify/notify.js"
import type { McpServerConfig } from "../mcp/manager.js"

/** `sandbox:` section of config.yaml (daemon-level). */
export interface SandboxConfig {
  enabled: boolean
  /** Extra realpath write roots (e.g. the npm cache dir). */
  writeRoots: string[]
}

export interface KclawConfig {
  providers: {
    default: string
    entries: Record<string, { baseUrl: string; apiKey: string; model: string }>
    /**
     * Per-request llm timeout the daemon passes to the provider client:
     * bounds the fetch AND the SSE body so a hung provider
     * stream can never park a run forever. Optional only because older
     * config.yaml files predate it; defaults to 120s (defaultConfig).
     */
    timeoutMs?: number
  }
  permissions: { allow: string[]; deny: string[]; confirmTimeoutMs: number; sessionGrants: boolean }
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
     * because older config.yaml files predate it; defaults to 20s
     * (defaultConfig).
     */
    timeoutMs?: number
    /**
     * Opt out of web_fetch's private/loopback target denial (SSRF guard):
     * true allows fetching e.g. http://127.0.0.1:11434 (a local Ollama
     * endpoint). Optional only because older config.yaml files predate it;
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
   * only because older config.yaml files predate it; defaults to enabled with
   * no extra write roots (defaultConfig).
   */
  sandbox?: SandboxConfig
  /**
   * Hook 系统。可选仅因老 config.yaml 早于它；
   * 缺省按读点的 ?? 默认值执行。
   */
  hooks?: { /** 单个 hook 处理器的时限（毫秒）；超时按失败处理（fail-open）。 */ timeoutMs?: number }
  sessions: {
    recycleBinTtlMs: number
    /** DEPRECATED (v1 compaction, inert): compact at N messages. */
    compactThreshold?: number
    /** DEPRECATED (v1 compaction, inert): keep newest N messages verbatim. */
    compactKeep?: number
    /** v2: context token budget. Default 128000 (read site applies ?? default). */
    contextTokens?: number
    /** v2: compact when the estimate exceeds budget × ratio. Default 0.66. */
    compactAtRatio?: number
    /** v2: post-compaction target for the verbatim window (× budget). Default 0.33. */
    compactTargetRatio?: number
    /** v3: 运行中途检查线（红）。估算水位超过 budget × 此比例即在迭代边界触发中途压缩。缺省 0.85。 */
    compactPanicRatio?: number
    /** v2: tool results kept verbatim in the provider view. Default 8. */
    toolResultKeep?: number
    /** 不带 disposition 的 send_message 取"会话覆盖 ?? 此默认"。缺省 "steer"。 */
    defaultDisposition?: "steer" | "wait" | "interrupt"
  }
  /**
   * Job-finish notifications. Delivery failures are only logged (onError),
   * never retried and never thrown. An empty channels list disables
   * notifications entirely (zero cost).
   */
  notify: { channels: NotifyChannel[]; timeoutMs?: number }
  /**
   * Token cost pricing (USD per 1M tokens per model) for the usage view.
   * Optional only because older config.yaml files predate it; empty map =
   * tokens shown, cost 0.
   */
  usage?: { prices?: Record<string, { inputPerM?: number; outputPerM?: number }> }
  /**
   * External MCP servers. Optional only because older config.yaml files
   * predate it; defaults to an empty server map (defaultConfig).
   */
  mcp?: { servers?: Record<string, McpServerConfig> }
  workspace: string
}

export const defaultConfig: KclawConfig = {
  providers: { default: "", entries: {}, timeoutMs: DEFAULT_LLM_TIMEOUT_MS },
  permissions: { allow: [], deny: ["exec:sudo*", "exec:rm -rf*"], confirmTimeoutMs: 120_000, sessionGrants: true },
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
 * Load config.yaml under paths.home, deep-merged over defaults.
 * A missing or empty file yields the defaults; unparseable YAML throws
 * (silently falling back could drop the user's permission rules).
 *
 * The returned config never shares references with defaultConfig:
 * the merge starts from a clone, so callers may mutate the result freely.
 */
export function loadConfig(paths: KclawPaths): KclawConfig {
  let raw: string
  try {
    raw = readFileSync(paths.config, "utf8")
  } catch {
    return structuredClone(defaultConfig)
  }
  let file: unknown
  try {
    file = parse(raw)
  } catch (err) {
    throw new Error(`invalid yaml in ${paths.config}: ${(err as Error).message}`)
  }
  if (file === null || file === undefined) return structuredClone(defaultConfig)
  if (!isPlainObject(file)) {
    throw new Error(`invalid config in ${paths.config}: expected a yaml mapping`)
  }
  // 首次读到 v1 遗留字段记日志说明已忽略（不改字段、不改行为，只提示）。
  const legacyAutoExtract = (file as { memory?: { autoExtract?: unknown } }).memory?.autoExtract
  if (legacyAutoExtract !== undefined) {
    console.warn("kclaw config: memory.autoExtract is deprecated (v1) and ignored; use memory.write.* instead")
  }
  return deepMerge(structuredClone(defaultConfig), file)
}

/** Serialize config to config.yaml (atomic whole-file rewrite; 0600 — holds apiKey plaintext). */
export function saveConfig(paths: KclawPaths, config: KclawConfig): void {
  writeFileAtomic(paths.config, stringify(config), 0o600)
}
