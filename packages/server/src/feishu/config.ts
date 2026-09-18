/**
 * ~/.kclaw/feishu.json — the Feishu channel's own config, deliberately NOT in
 * config.yaml: app_secret must not mix into the main config's backup/sync
 * paths. Read-only here (the file is hand-edited; no management UI in v1);
 * restart to apply. The loader tightens the file mode to 0600 best effort.
 */
import { readFileSync, writeFileSync, renameSync, statSync, chmodSync, existsSync } from "node:fs"
import { join } from "node:path"

export interface FeishuConfig {
  enabled: boolean
  appId: string
  appSecret: string
  /** open_id 白名单：白名单外的发件人被静默忽略。 */
  allowlist: string[]
  /** 主动推送（job 终态、后台子代理完成）的接收人。 */
  primaryOpenId?: string
}

export const FEISHU_CONFIG_FILE = "feishu.json"

export function loadFeishuConfig(home: string): FeishuConfig {
  const path = join(home, FEISHU_CONFIG_FILE)
  if (!existsSync(path)) {
    return { enabled: false, appId: "", appSecret: "", allowlist: [] }
  }
  // best-effort 私有化：密钥文件不该比 0600 更宽
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600)
  } catch {
    // 权限收紧失败不阻塞读取
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new Error(`feishu.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const enabled = o.enabled === true
  const appId = typeof o.app_id === "string" ? o.app_id : ""
  const appSecret = typeof o.app_secret === "string" ? o.app_secret : ""
  const allowlist = Array.isArray(o.allowlist) ? o.allowlist.filter((x): x is string => typeof x === "string") : []
  const primaryOpenId = typeof o.primaryOpenId === "string" && o.primaryOpenId !== "" ? o.primaryOpenId : undefined
  if (enabled && (appId === "" || appSecret === "")) {
    throw new Error("feishu.json: enabled=true 需要 app_id 与 app_secret")
  }
  return { enabled, appId, appSecret, allowlist, ...(primaryOpenId !== undefined ? { primaryOpenId } : {}) }
}

/** Bindings 状态文件（open_id → 常驻会话），由频道写入；与手编的 feishu.json 分开放。 */
export const FEISHU_STATE_FILE = "feishu-state.json"

export interface FeishuState {
  bindings: Record<string, string>
}

export function loadFeishuState(home: string): FeishuState {
  const path = join(home, FEISHU_STATE_FILE)
  if (!existsSync(path)) return { bindings: {} }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FeishuState>
    return { bindings: raw.bindings ?? {} }
  } catch {
    return { bindings: {} }
  }
}

/** Atomic write, 0600 — same discipline as the decided-rule files. */
export function saveFeishuState(home: string, state: FeishuState): void {
  const path = join(home, FEISHU_STATE_FILE)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}
