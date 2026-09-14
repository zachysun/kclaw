/**
 * McpView — MCP server management tab: the daemon-wide status snapshot
 * (name, connection state, last error) with per-server expandable tool
 * lists, plus the management actions (enable/disable, reconnect, and the
 * add/edit/delete form). Fetch-on-entry with a manual refresh button —
 * no polling, no live updates. Data comes from GET /mcp; actions ride the
 * /mcp/servers family and re-fetch on completion. env/headers echo back in
 * plaintext by design (local single-user product behind token auth).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ApiClient } from "../api.js"

interface McpToolEntry {
  name: string
  originalName: string
  description: string
}

type McpState = "connected" | "connecting" | "disabled" | "failed"

interface McpServerStatus {
  name: string
  config: { type: "stdio" | "http"; enabled?: boolean }
  state: McpState
  tools: McpToolEntry[]
  lastError?: string
}

const STATE_LABELS: Record<McpState, string> = {
  connected: "已连接",
  connecting: "连接中",
  disabled: "已禁用",
  failed: "失败",
}

/** One-line config summary: the command for stdio, the URL for http. */
function configSummary(config: McpServerStatus["config"]): string {
  const c = config as Record<string, unknown>
  return typeof c.command === "string" ? c.command : typeof c.url === "string" ? c.url : ""
}

interface Pair {
  key: string
  value: string
}

interface FormState {
  /** Server name being edited; null = a new entry. */
  editing: string | null
  name: string
  type: "stdio" | "http"
  command: string
  /** One argument per line. */
  argsText: string
  envPairs: Pair[]
  url: string
  headerPairs: Pair[]
}

function emptyForm(): FormState {
  return { editing: null, name: "", type: "stdio", command: "", argsText: "", envPairs: [], url: "", headerPairs: [] }
}

/** Prefill from an existing snapshot entry (plaintext echo of env/headers). */
function formFromStatus(s: McpServerStatus): FormState {
  const c = s.config as Record<string, unknown>
  const pairs = (rec: unknown): Pair[] =>
    rec !== undefined && typeof rec === "object" && !Array.isArray(rec)
      ? Object.entries(rec as Record<string, string>).map(([key, value]) => ({ key, value }))
      : []
  return {
    editing: s.name,
    name: s.name,
    type: c.type === "http" ? "http" : "stdio",
    command: typeof c.command === "string" ? c.command : "",
    argsText: Array.isArray(c.args) ? (c.args as string[]).join("\n") : "",
    envPairs: pairs(c.env),
    url: typeof c.url === "string" ? c.url : "",
    headerPairs: pairs(c.headers),
  }
}

function pairsToRecord(pairs: Pair[]): Record<string, string> | undefined {
  const rec: Record<string, string> = {}
  for (const p of pairs) {
    if (p.key.trim() !== "") rec[p.key.trim()] = p.value
  }
  return Object.keys(rec).length > 0 ? rec : undefined
}

/** Key-value rows (env / headers): inline add, edit, remove. */
function KeyValueEditor({ pairs, keyTestid, valueTestid, addTestid, onChange }: {
  pairs: Pair[]
  keyTestid: string
  valueTestid: string
  addTestid: string
  onChange: (pairs: Pair[]) => void
}): React.ReactElement {
  return (
    <div className="mcp-kv">
      {pairs.map((p, i) => (
        <span key={i} className="mcp-kv-row">
          <input
            data-testid={`${keyTestid}-${i}`}
            value={p.key}
            placeholder="名称"
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
          />
          <input
            data-testid={`${valueTestid}-${i}`}
            value={p.value}
            placeholder="值"
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          <button type="button" aria-label="删除此行" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            ×
          </button>
        </span>
      ))}
      <button type="button" data-testid={addTestid} onClick={() => onChange([...pairs, { key: "", value: "" }])}>
        添加一行
      </button>
    </div>
  )
}

export function McpView({ api, notice }: {
  api: ApiClient
  notice: (text: string) => void
}) {
  // notice goes through a ref: App passes an inline arrow that is a fresh
  // reference each render; depending on `notice` would refetch on every parent
  // re-render (same guard as PermissionsView).
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })

  const [servers, setServers] = useState<McpServerStatus[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const reload = useCallback((): Promise<void> => {
    return api
      .get<{ servers: McpServerStatus[] }>("/mcp")
      .then((r) => setServers(r.servers))
      .catch((e) => noticeRef.current(`加载 MCP 状态失败: ${String(e)}`))
  }, [api])

  useEffect(() => {
    void reload()
  }, [reload])

  const toggleExpand = (name: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  /** Run one action endpoint, then re-fetch; failures surface in the notice. */
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      await reload()
    } catch (e) {
      noticeRef.current(`操作失败: ${String(e)}`)
    }
  }

  const setEnabled = (name: string, enabled: boolean): Promise<void> =>
    act(() => api.post(`/mcp/servers/${encodeURIComponent(name)}/enable`, { enabled }))
  const reconnect = (name: string): Promise<void> =>
    act(() => api.post(`/mcp/servers/${encodeURIComponent(name)}/reconnect`))
  const remove = (name: string): Promise<void> =>
    act(() => api.del(`/mcp/servers/${encodeURIComponent(name)}`))

  const submitForm = async (): Promise<void> => {
    if (form === null) return
    const args = form.argsText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
    const config =
      form.type === "stdio"
        ? {
            type: "stdio" as const,
            command: form.command,
            ...(args.length > 0 ? { args } : {}),
            ...pairsToRecord(form.envPairs),
          }
        : {
            type: "http" as const,
            url: form.url,
            ...pairsToRecord(form.headerPairs),
          }
    try {
      if (form.editing === null) {
        await api.post("/mcp/servers", { name: form.name.trim(), config })
      } else {
        await api.patch(`/mcp/servers/${encodeURIComponent(form.editing)}`, { config })
      }
      setForm(null)
      setFormError(null)
      await reload()
    } catch (e) {
      setFormError(String(e))
    }
  }

  return (
    <div className="mcp-view" data-testid="mcp-view">
      <div className="mcp-head">
        <p className="muted mcp-intro">
          这些是 daemon 全局接入的 MCP 服务器（所有会话共享）。配置保存在 daemon 的
          <code>mcp.json</code>；config.yaml 里的旧 <code>mcp.servers</code> 节在首次保存后自动迁入。
          MCP 工具一律按敏感待遇处理（每次调用需确认），readonly 模式下不暴露给模型。
        </p>
        <button type="button" data-testid="mcp-add" onClick={() => { setFormError(null); setForm(emptyForm()) }}>
          添加服务器
        </button>
        <button type="button" className="mcp-refresh" data-testid="mcp-refresh" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      {form !== null && (
        <form
          className="mcp-form"
          data-testid="mcp-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submitForm()
          }}
        >
          <div className="mcp-form-row">
            <label>
              名称
              <input
                data-testid="mcp-form-name"
                value={form.name}
                disabled={form.editing !== null}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <span className="mcp-form-type">
              <button type="button" className={form.type === "stdio" ? "active" : ""} data-testid="mcp-form-type-stdio" onClick={() => setForm({ ...form, type: "stdio" })}>
                stdio
              </button>
              <button type="button" className={form.type === "http" ? "active" : ""} data-testid="mcp-form-type-http" onClick={() => setForm({ ...form, type: "http" })}>
                http
              </button>
            </span>
          </div>
          {form.type === "stdio" ? (
            <>
              <label>
                命令
                <input data-testid="mcp-form-command" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              </label>
              <label>
                参数（每行一个）
                <textarea data-testid="mcp-form-args" rows={2} value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value })} />
              </label>
              <KeyValueEditor
                pairs={form.envPairs}
                keyTestid="mcp-form-env-key"
                valueTestid="mcp-form-env-value"
                addTestid="mcp-form-env-add"
                onChange={(envPairs) => setForm({ ...form, envPairs })}
              />
            </>
          ) : (
            <>
              <label>
                URL
                <input data-testid="mcp-form-url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </label>
              <KeyValueEditor
                pairs={form.headerPairs}
                keyTestid="mcp-form-headers-key"
                valueTestid="mcp-form-headers-value"
                addTestid="mcp-form-headers-add"
                onChange={(headerPairs) => setForm({ ...form, headerPairs })}
              />
            </>
          )}
          {formError !== null && (
            <p className="mcp-form-error" data-testid="mcp-form-error">
              {formError}
            </p>
          )}
          <div className="mcp-form-actions">
            <button type="submit" data-testid="mcp-form-submit">
              保存
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(null)
                setFormError(null)
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {servers === null ? (
        <p className="muted">加载中…</p>
      ) : servers.length === 0 ? (
        <p className="muted" data-testid="mcp-empty">
          还没有接入任何 MCP 服务器。
        </p>
      ) : (
        <ul className="mcp-servers">
          {servers.map((s) => (
            <li key={s.name} className="mcp-server" data-testid={`mcp-server-${s.name}`}>
              <div className="mcp-server-head">
                <span className="mcp-name">{s.name}</span>
                <span className={`mcp-state ${s.state}`} data-testid={`mcp-state-${s.name}`}>
                  {STATE_LABELS[s.state]}
                </span>
                {s.lastError !== undefined && (
                  <span className="mcp-error" data-testid={`mcp-error-${s.name}`} title={s.lastError}>
                    {s.lastError}
                  </span>
                )}
                <span className="mcp-actions">
                  {s.state === "failed" && (
                    <button type="button" data-testid={`mcp-reconnect-${s.name}`} onClick={() => void reconnect(s.name)}>
                      重连
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`mcp-toggle-${s.name}`}
                    onClick={() => void setEnabled(s.name, s.config.enabled === false)}
                  >
                    {s.config.enabled === false ? "启用" : "禁用"}
                  </button>
                  <button type="button" data-testid={`mcp-edit-${s.name}`} onClick={() => { setFormError(null); setForm(formFromStatus(s)) }}>
                    编辑
                  </button>
                  <button type="button" data-testid={`mcp-delete-${s.name}`} onClick={() => void remove(s.name)}>
                    删除
                  </button>
                </span>
              </div>
              <div className="mcp-meta">
                <code>{configSummary(s.config)}</code>
                {s.tools.length > 0 && (
                  <button
                    type="button"
                    data-testid={`mcp-expand-${s.name}`}
                    onClick={() => toggleExpand(s.name)}
                  >
                    {expanded.has(s.name) ? "收起工具" : `工具（${s.tools.length}）`}
                  </button>
                )}
              </div>
              {expanded.has(s.name) && (
                <ul className="mcp-tools" data-testid={`mcp-tools-${s.name}`}>
                  {s.tools.map((t) => (
                    <li key={t.name}>
                      <code>{t.name}</code>
                      {t.description !== "" && <span className="mcp-tool-desc">{t.description}</span>}
                      <em className="mcp-sensitive" data-testid="mcp-sensitive">
                        sensitive
                      </em>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
