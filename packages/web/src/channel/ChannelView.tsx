/**
 * ChannelView — the IM Channel tab: Feishu connection config (enabled,
 * app_id, app_secret, allowlist, push recipient) with save-and-apply (the
 * daemon hot-restarts the channel — no daemon restart needed), a connection
 * status badge, a test-connection button, the pending-sender list
 * (non-allowlisted senders stay silent externally; they appear here for
 * one-click allowlisting) and the built-in onboarding guide. Fetch-on-entry
 * with a manual refresh — no polling, same as Mcp/Model. The secret never
 * echoes back: the field starts empty and "leave empty" keeps the stored one.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import type { ApiClient } from "../api.js"
import type { NoticeFn } from "../toast.js"

interface ChannelSnapshot {
  config: {
    enabled: boolean
    appId: string
    appSecretSet: boolean
    allowlist: string[]
    primaryOpenId?: string
  }
  status: { state: "disabled" | "running" | "error"; error?: string }
  pendingSenders: Array<{ openId: string; count: number; lastSeen: number }>
}

interface CredentialCheck {
  ok: boolean
  error?: string
}

const STATE_LABELS: Record<ChannelSnapshot["status"]["state"], string> = {
  running: "运行中",
  disabled: "未启用",
  error: "出错",
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ChannelView({ api, notice }: {
  api: ApiClient
  notice: NoticeFn
}) {
  // notice goes through a ref: App passes an inline arrow that is a fresh
  // reference each render (same guard as McpView/ModelView).
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })

  const [snap, setSnap] = useState<ChannelSnapshot | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [allowlist, setAllowlist] = useState<string[]>([])
  const [allowlistInput, setAllowlistInput] = useState("")
  const [primaryOpenId, setPrimaryOpenId] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<CredentialCheck | null>(null)
  const [addingOpenId, setAddingOpenId] = useState<string | null>(null)

  const applySnapshot = useCallback((s: ChannelSnapshot): void => {
    setSnap(s)
    setEnabled(s.config.enabled)
    setAppId(s.config.appId)
    setAppSecret("")
    setAllowlist(s.config.allowlist)
    setPrimaryOpenId(s.config.primaryOpenId ?? "")
    setFormError(null)
    setTestResult(null)
  }, [])

  const reload = useCallback((): Promise<void> => {
    return api
      .get<ChannelSnapshot>("/channel")
      .then(applySnapshot)
      .catch((e) => noticeRef.current(`加载 IM Channel 状态失败: ${String(e)}`, "error"))
  }, [api, applySnapshot])

  useEffect(() => {
    void reload()
  }, [reload])

  const addToAllowlist = (): void => {
    const id = allowlistInput.trim()
    if (id === "") return
    if (!allowlist.includes(id)) setAllowlist([...allowlist, id])
    setAllowlistInput("")
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const next = await api.post<ChannelSnapshot>("/channel/config", {
        enabled,
        appId: appId.trim(),
        ...(appSecret !== "" ? { appSecret } : {}),
        allowlist,
        ...(primaryOpenId !== "" ? { primaryOpenId } : {}),
      })
      applySnapshot(next)
      noticeRef.current("已保存，通道已按新配置重启。", "info")
    } catch (e) {
      setFormError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.post<CredentialCheck>("/channel/test", {
        appId: appId.trim(),
        ...(appSecret !== "" ? { appSecret } : {}),
      })
      setTestResult(result)
    } catch (e) {
      setTestResult({ ok: false, error: String(e) })
    } finally {
      setTesting(false)
    }
  }

  const allowSender = async (openId: string): Promise<void> => {
    if (addingOpenId !== null) return
    setAddingOpenId(openId)
    try {
      const next = await api.post<ChannelSnapshot>(`/channel/allowlist/${encodeURIComponent(openId)}`)
      // 只更新快照（pending 列表与 allowlist 标签随后跟上），不回填表单——
      // 用户未保存的草稿编辑（含刚粘贴的 secret）不能被无声冲掉
      setSnap(next)
      noticeRef.current("已加入白名单。", "info")
    } catch (e) {
      noticeRef.current(`加白失败: ${String(e)}`, "error")
    } finally {
      setAddingOpenId(null)
    }
  }

  return (
    <div className="channel-view" data-testid="channel-view">
      <div className="channel-head">
        {snap !== null && (
          <span className={`channel-status channel-status-${snap.status.state}`} data-testid="channel-status">
            {STATE_LABELS[snap.status.state]}
            {snap.status.state === "error" && snap.status.error !== undefined ? `：${snap.status.error}` : ""}
          </span>
        )}
        <button type="button" className="channel-refresh" data-testid="channel-refresh" onClick={() => void reload()}>
          刷新
        </button>
      </div>

      <form
        className="channel-form"
        data-testid="channel-form"
        onSubmit={(e) => void submit(e)}
      >
        <label className="channel-toggle">
          <input
            type="checkbox"
            data-testid="channel-enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用飞书通道
        </label>

        <label>
          App ID
          <input
            data-testid="channel-app-id"
            value={appId}
            placeholder="cli_xxxx"
            onChange={(e) => setAppId(e.target.value)}
          />
        </label>

        <label>
          App Secret
          {snap?.config.appSecretSet === true && <span className="channel-secret-set">已设置</span>}
          <input
            type="password"
            data-testid="channel-app-secret"
            value={appSecret}
            placeholder={snap?.config.appSecretSet === true ? "留空保持已保存的 secret" : ""}
            autoComplete="new-password"
            onChange={(e) => setAppSecret(e.target.value)}
          />
        </label>

        <div className="channel-allowlist">
          <span className="channel-allowlist-label">白名单（open_id，一行一人，只有名单内的人能使用机器人）</span>
          <div className="channel-allowlist-tags" data-testid="channel-allowlist-tags">
            {allowlist.map((id) => (
              <span key={id} className="channel-tag">
                <code>{id}</code>
                <button
                  type="button"
                  aria-label={`移除 ${id}`}
                  data-testid={`channel-allowlist-remove-${id}`}
                  onClick={() => setAllowlist(allowlist.filter((x) => x !== id))}
                >
                  ×
                </button>
              </span>
            ))}
            {allowlist.length === 0 && <span className="muted">暂无成员</span>}
          </div>
          <div className="channel-allowlist-input">
            <input
              data-testid="channel-allowlist-input"
              value={allowlistInput}
              placeholder="ou_xxxx"
              onChange={(e) => setAllowlistInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addToAllowlist()
                }
              }}
            />
            <button type="button" data-testid="channel-allowlist-add" onClick={addToAllowlist}>
              添加
            </button>
          </div>
        </div>

        <label>
          推送接收人（定时任务结果、后台子代理完成推送；可选）
          <select
            data-testid="channel-primary"
            value={primaryOpenId}
            onChange={(e) => setPrimaryOpenId(e.target.value)}
          >
            <option value="">不推送</option>
            {allowlist.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>

        {formError !== null && (
          <p className="channel-form-error" data-testid="channel-form-error">{formError}</p>
        )}

        <div className="channel-form-actions">
          <button type="submit" data-testid="channel-save" disabled={saving}>
            {saving ? "保存中…" : "保存并生效"}
          </button>
          <button
            type="button"
            data-testid="channel-test"
            disabled={testing}
            onClick={() => void testConnection()}
          >
            {testing ? "验证中…" : "测试连接"}
          </button>
          {testResult !== null && (
            <span
              className={testResult.ok ? "channel-test-ok" : "channel-test-fail"}
              data-testid="channel-test-result"
            >
              {testResult.ok ? "凭据有效" : `验证失败：${testResult.error ?? "未知错误"}`}
            </span>
          )}
        </div>
      </form>

      <section className="channel-pending" data-testid="channel-pending">
        <h3>待加白发件人</h3>
        <p className="muted">
          白名单外的人给机器人发消息不会被回复（对方无感知），但会记录在这里，点击「加白」即可放行。
        </p>
        {snap === null || snap.pendingSenders.length === 0 ? (
          <p className="muted" data-testid="channel-pending-empty">暂无记录。</p>
        ) : (
          <ul className="channel-pending-list">
            {snap.pendingSenders.map((p) => (
              <li key={p.openId} data-testid={`channel-pending-${p.openId}`}>
                <code>{p.openId}</code>
                <span className="muted">{p.count} 次 · 最近 {formatTime(p.lastSeen)}</span>
                <button
                  type="button"
                  data-testid={`channel-allow-${p.openId}`}
                  disabled={addingOpenId !== null}
                  onClick={() => void allowSender(p.openId)}
                >
                  加白
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="channel-guide" data-testid="channel-guide">
        <summary>接入指引：从零到机器人可用</summary>
        <ol>
          <li>注册一个飞书组织（免费，个人手机号即可），在<a href="https://open.feishu.cn/" target="_blank" rel="noreferrer">开放平台</a>创建「企业自建应用」。</li>
          <li>在「权限管理」开通四项权限：收单聊消息 <code>im:message.p2p_msg:readonly</code>、发消息与卡片 <code>im:message:send_as_bot</code>、表情回执 <code>im:message.reactions:write_only</code>、卡片实体读写 <code>cardkit:card:write</code>（流式卡片必需，搜 <code>cardkit</code>）。</li>
          <li>在「事件与回调」里做两件事：把订阅方式切换为<b>长连接</b>（无需公网 IP、无需端口、无需验证令牌），并在「事件订阅设置」里<b>添加事件</b> <code>im.message.receive_v1</code>（接收消息 v2）——开权限不等于订阅事件，两个开关缺一不可。</li>
          <li>在「凭证与基础信息」拿到 App ID 与 App Secret，填到上面并保存。</li>
          <li>在飞书里给机器人发一条消息——它不会回复你，但你的 open_id 会出现在「待加白发件人」里，点「加白」即可开始使用。</li>
          <li>把「推送接收人」选成自己，定时任务与后台子代理完成时会推送卡片。</li>
        </ol>
      </details>
    </div>
  )
}
