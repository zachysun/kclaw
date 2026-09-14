/**
 * McpView — MCP server management tab: the daemon-wide status snapshot
 * (name, connection state, last error) with per-server expandable tool
 * lists, plus the management actions (enable/disable, reconnect, and the
 * add/edit/delete form). Fetch-on-entry with a manual refresh button —
 * no polling, no live updates. Data comes from GET /mcp; actions ride the
 * /mcp/servers family and re-fetch on completion.
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

  return (
    <div className="mcp-view" data-testid="mcp-view">
      <div className="mcp-head">
        <p className="muted mcp-intro">
          这些是 daemon 全局接入的 MCP 服务器（所有会话共享）。配置保存在 daemon 的
          <code>mcp.json</code>；config.yaml 里的旧 <code>mcp.servers</code> 节在首次保存后自动迁入。
          MCP 工具一律按敏感待遇处理（每次调用需确认），readonly 模式下不暴露给模型。
        </p>
        <button type="button" className="mcp-refresh" data-testid="mcp-refresh" onClick={() => void reload()}>
          刷新
        </button>
      </div>
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
