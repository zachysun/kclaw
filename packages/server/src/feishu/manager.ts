/**
 * The Feishu channel manager: owns the channel's lifecycle so the admin page
 * can save config and hot-restart the channel without touching the daemon
 * (the McpManager pattern — routes drive a manager, the manager owns
 * start/stop). This is the batch's single new seam: the transport factory,
 * the credential verifier and the daemon wiring hook are all injected, so
 * every decision here is testable with fakes.
 *
 * Status is manager-level: "running" means the last start succeeded and the
 * channel was not disabled since; the SDK's internal reconnect states are
 * not observable through the transport seam.
 *
 * Mutating operations (save / allowAdd / start / stop) run serialized on an
 * internal promise chain — two overlapping saves must never interleave a
 * stop and a start of the same transport.
 */
import type { EventBus, SessionStore } from "@kclaw/core"
import type { RunManager } from "../run.js"
import type { FeishuConfig, PendingSender } from "./config.js"
import { loadFeishuConfig, loadFeishuState, saveFeishuConfig, saveFeishuState } from "./config.js"
import { createFeishuChannel, type FeishuChannel } from "./channel.js"
import type { FeishuTransport } from "./transport.js"
import { verifyFeishuCredentials, type CredentialCheck } from "./verify.js"

export interface FeishuChannelStatus {
  state: "disabled" | "running" | "error"
  error?: string
}

/** Draft from the admin page; an empty/absent appSecret keeps the stored one. */
export interface FeishuDraft {
  enabled: boolean
  appId: string
  appSecret?: string
  allowlist: string[]
  primaryOpenId?: string
}

export interface FeishuSnapshot {
  config: {
    enabled: boolean
    appId: string
    appSecretSet: boolean
    allowlist: string[]
    primaryOpenId?: string
  }
  status: FeishuChannelStatus
  pendingSenders: PendingSender[]
}

export interface FeishuManagerDeps {
  /** ~/.kclaw — hosts feishu.json and feishu-state.json. */
  home: string
  run: RunManager
  sessions: SessionStore
  bus: EventBus
  /** Defaults to the real SDK transport (lazy dynamic import). */
  createTransport?: (config: FeishuConfig) => FeishuTransport
  /** Defaults to the real token-exchange probe. */
  verifyCredentials?: (appId: string, appSecret: string) => Promise<CredentialCheck>
  /** Called on every channel swap so the daemon can re-wire its forwarders. */
  wireChannel?: (channel: FeishuChannel | undefined) => void
  log?: (line: string) => void
  /** Handshake deadline for starts and hot restarts. */
  startTimeoutMs?: number
}

export interface FeishuManager {
  start(): Promise<void>
  stop(): Promise<void>
  /** Validate → persist → hot restart. Throws with a user-facing message. */
  save(draft: FeishuDraft): Promise<FeishuSnapshot>
  /** Idempotent allowlist add → same save/restart path → clear the pending entry. */
  allowAdd(openId: string): Promise<FeishuSnapshot>
  testCredentials(appId: string, appSecret?: string): Promise<CredentialCheck>
  status(): FeishuChannelStatus
  snapshot(): FeishuSnapshot
}

const DEFAULT_START_TIMEOUT_MS = 15_000

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Bounded await: a hanging websocket handshake must never park a save. */
const withDeadline = <T>(p: Promise<T>, timeoutMs: number, step: string): Promise<T> => {
  void p.catch(() => undefined) // a late failure of the losing side is not "unhandled"
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`feishu channel ${step} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export function createFeishuManager(deps: FeishuManagerDeps): FeishuManager {
  const log = deps.log ?? ((line: string) => console.error(line))
  const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS

  let current: FeishuConfig = { enabled: false, appId: "", appSecret: "", allowlist: [] }
  let channel: FeishuChannel | undefined
  let status: FeishuChannelStatus = { state: "disabled" }

  // Mutations run one at a time; a failed predecessor does not block the next.
  let tail: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }

  let realFactory: ((config: FeishuConfig) => FeishuTransport) | undefined
  const transportFor = async (config: FeishuConfig): Promise<FeishuTransport> => {
    if (deps.createTransport !== undefined) return deps.createTransport(config)
    if (realFactory === undefined) {
      realFactory = (await import("./real-transport.js")).createRealFeishuTransport
    }
    return realFactory(config)
  }

  const mergeDraft = (draft: FeishuDraft): FeishuConfig => {
    const appId = draft.appId.trim()
    const appSecret = draft.appSecret !== undefined && draft.appSecret !== "" ? draft.appSecret : current.appSecret
    const allowlist = [...new Set(draft.allowlist.map((s) => s.trim()).filter((s) => s !== ""))]
    const primaryOpenId = draft.primaryOpenId?.trim()
    return {
      enabled: draft.enabled === true,
      appId,
      appSecret,
      allowlist,
      ...(primaryOpenId !== undefined && primaryOpenId !== "" ? { primaryOpenId } : {}),
    }
  }

  const validate = (config: FeishuConfig): string | undefined => {
    if (config.enabled && (config.appId === "" || config.appSecret === "")) {
      return "启用飞书需要 app_id 与 app_secret"
    }
    if (config.primaryOpenId !== undefined && !config.allowlist.includes(config.primaryOpenId)) {
      return "推送接收人必须在白名单里"
    }
    return undefined
  }

  /** Stop the current channel (if any) and unwire it. Never throws. */
  const teardown = async (): Promise<void> => {
    const old = channel
    channel = undefined
    deps.wireChannel?.(undefined)
    if (old === undefined) return
    try {
      await withDeadline(old.stop(), startTimeoutMs, "stop")
    } catch (err) {
      log(`feishu: 旧通道停止失败：${message(err)}`)
    }
  }

  /** Bring the channel up (or down) to match `current`; records status. */
  const restart = async (): Promise<void> => {
    await teardown()
    if (!current.enabled) {
      status = { state: "disabled" }
      return
    }
    let next: FeishuChannel | undefined
    try {
      const transport = await transportFor(current)
      next = createFeishuChannel({
        transport,
        config: current,
        run: deps.run,
        sessions: deps.sessions,
        bus: deps.bus,
        home: deps.home,
        log,
      })
      await withDeadline(next.start(), startTimeoutMs, "start")
      channel = next
      status = { state: "running" }
      deps.wireChannel?.(next)
    } catch (err) {
      status = { state: "error", error: message(err) }
      log(`feishu channel 启动失败：${message(err)}`)
      // 半启动状态也要拆干净：总线订阅不清理会留下喂空转的僵尸，而
      // 真传输底下的 SDK 自动重连还可能把半启动的连接自己救活——
      // 那会变成两个活通道同时挂在总线上、消息被处理两遍。
      if (next !== undefined) {
        try {
          await withDeadline(next.stop(), startTimeoutMs, "cleanup")
        } catch (cleanupErr) {
          log(`feishu: 半启动通道清理失败：${message(cleanupErr)}`)
        }
      }
    }
  }

  const clearPending = (openId: string): void => {
    if (channel !== undefined) {
      channel.clearPendingSender(openId)
      return
    }
    // Channel down: nobody holds the in-memory view, patch the file directly.
    // Spread (not rebuild) so fields the channel owns — e.g. pendingApprovals —
    // survive this pendingSenders-only edit.
    const state = loadFeishuState(deps.home)
    const filtered = state.pendingSenders.filter((p) => p.openId !== openId)
    if (filtered.length !== state.pendingSenders.length) {
      saveFeishuState(deps.home, { ...state, pendingSenders: filtered })
    }
  }

  const snapshot = (): FeishuSnapshot => ({
    config: {
      enabled: current.enabled,
      appId: current.appId,
      appSecretSet: current.appSecret !== "",
      allowlist: [...current.allowlist],
      ...(current.primaryOpenId !== undefined ? { primaryOpenId: current.primaryOpenId } : {}),
    },
    status: { ...status },
    pendingSenders: channel !== undefined ? channel.pendingSenders() : loadFeishuState(deps.home).pendingSenders,
  })

  return {
    start: () =>
      enqueue(async () => {
        try {
          current = loadFeishuConfig(deps.home)
        } catch (err) {
          // A broken feishu.json never blocks the daemon: surface it on the page.
          current = { enabled: false, appId: "", appSecret: "", allowlist: [] }
          status = { state: "error", error: message(err) }
          log(`feishu: ${message(err)}`)
          return
        }
        await restart()
      }),

    stop: () => enqueue(teardown),

    save: (draft) =>
      enqueue(async () => {
        const next = mergeDraft(draft)
        const problem = validate(next)
        if (problem !== undefined) throw new Error(problem)
        saveFeishuConfig(deps.home, next)
        current = next
        await restart()
        return snapshot()
      }),

    allowAdd: (openId) =>
      enqueue(async () => {
        const id = openId.trim()
        if (id === "") throw new Error("openId is required")
        if (!current.allowlist.includes(id)) {
          const next = { ...current, allowlist: [...current.allowlist, id] }
          saveFeishuConfig(deps.home, next)
          current = next
          await restart()
        }
        clearPending(id)
        return snapshot()
      }),

    testCredentials: async (appId, appSecret) => {
      const id = appId.trim()
      const secret = appSecret !== undefined && appSecret !== "" ? appSecret : current.appSecret
      if (id === "" || secret === "") return { ok: false, error: "app_id 与 app_secret 不能为空" }
      const verify = deps.verifyCredentials ?? verifyFeishuCredentials
      return verify(id, secret)
    },

    status: () => ({ ...status }),
    snapshot,
  }
}
