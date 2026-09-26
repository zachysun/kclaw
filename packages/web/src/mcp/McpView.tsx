/**
 * McpView — MCP server management tab, grouped by ownership: one "全局"
 * group shared by every project, then one section per known project
 * workdir. Entries sit inside their group (the section header carries the
 * ownership), each with its connection state, last error, expandable tool
 * list and the management actions. The lazy daemon rests entries in
 * "未连接"; such entries (and failed ones) offer a manual 连接 probe.
 * Add/edit forms pick the target group from a dropdown — new entries
 * default to the selected session's workdir (fallback: the daemon's main
 * workspace), an edit can move the entry across groups (PATCH toGroup).
 * Fetch on entry, then poll every 2s while the tab is visible so
 * connection-state flips show up without user action; hidden tabs skip the
 * fetch, the poll fails quiet (no toast spam — only entry/manual/action-
 * triggered fetches surface errors), and the refresh button stays for an
 * explicit reload.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { MCP_STATE_LABELS, mcpGroupLabel } from "@kclaw/core/commands"
import type { McpGroupStatus, McpServerStatus } from "@kclaw/core/protocol"
import type { ApiClient } from "../api.js"
import type { NoticeFn } from "../toast.js"
import { McpForm, emptyForm, formFromStatus } from "./McpForm.js"
import type { McpFormState } from "./McpForm.js"

/** GET /mcp response: the grouped snapshot plus the fallback target. */
interface McpSnapshotResponse {
  groups: McpGroupStatus[]
  mainWorkspace: string
}

/** One-line config summary: the command for stdio, the URL for http. */
function configSummary(config: McpServerStatus["config"]): string {
  const c = config as Record<string, unknown>
  return typeof c.command === "string" ? c.command : typeof c.url === "string" ? c.url : ""
}

/**
 * Default creation target: the selected session's project, else the daemon
 * workspace, else global. The session workdir is preferred even when the
 * client snapshot predates its group — the daemon mounts the project as
 * soon as the session is created, so the POST resolves server-side; the
 * stale snapshot only means the dropdown is missing one option.
 */
function defaultGroup(snapshot: McpSnapshotResponse | null, sessionWorkdir?: string): string {
  if (sessionWorkdir !== undefined && sessionWorkdir !== "") return sessionWorkdir
  const ids = new Set(snapshot?.groups.map((g) => g.id) ?? [])
  const main = snapshot?.mainWorkspace ?? ""
  if (main !== "" && ids.has(main)) return main
  return "global"
}

export function McpView({ api, notice, sessionWorkdir }: {
  api: ApiClient
  notice: NoticeFn
  /** The selected session's workdir — the default target for new entries. */
  sessionWorkdir?: string
}) {
  // notice goes through a ref: App passes an inline arrow that is a fresh
  // reference each render; depending on `notice` would refetch on every parent
  // re-render (same guard as PermissionsView).
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })
  const sessionWorkdirRef = useRef(sessionWorkdir)
  sessionWorkdirRef.current = sessionWorkdir

  const [snapshot, setSnapshot] = useState<McpSnapshotResponse | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [formSeed, setFormSeed] = useState<McpFormState | null>(null)

  /** Quiet=true skips the failure toast — background polls must not spam. */
  const reload = useCallback((opts?: { quiet?: boolean }): Promise<void> => {
    return api
      .get<McpSnapshotResponse>("/mcp")
      .then((r) => setSnapshot(r))
      .catch((e) => {
        if (opts?.quiet !== true) noticeRef.current(`加载 MCP 状态失败: ${String(e)}`, "error")
      })
  }, [api])

  useEffect(() => {
    void reload()
    // Poll while mounted so daemon-side state flips reach the page without a
    // manual refresh; a hidden tab skips the fetch (no wasted requests while
    // the user is looking elsewhere).
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload({ quiet: true })
    }, 2000)
    return () => clearInterval(timer)
  }, [reload])

  const toggleFold = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleExpand = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Run one action endpoint, then re-fetch; failures surface in the notice. */
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      await reload()
    } catch (e) {
      noticeRef.current(`操作失败: ${String(e)}`, "error")
    }
  }

  const setEnabled = (group: string, name: string, enabled: boolean): Promise<void> =>
    act(() => api.post(`/mcp/servers/${encodeURIComponent(name)}/enable`, { group, enabled }))
  const connectProbe = (group: string, name: string): Promise<void> =>
    act(() => api.post(`/mcp/servers/${encodeURIComponent(name)}/connect`, { group }))
  const remove = (group: string, name: string): Promise<void> =>
    act(() => api.del(`/mcp/servers/${encodeURIComponent(name)}?group=${encodeURIComponent(group)}`))

  const groups = snapshot?.groups ?? []
  // Offer the selected session's workdir even when the client snapshot
  // predates its group (the daemon mounts it on session.created; the next
  // poll adds it to the list).
  const sessionDir = sessionWorkdirRef.current
  const groupIds =
    sessionDir !== undefined && sessionDir !== "" && !groups.some((g) => g.id === sessionDir)
      ? [...groups.map((g) => g.id), sessionDir]
      : groups.map((g) => g.id)

  return (
    <div className="mcp-view" data-testid="mcp-view">
      <div className="mcp-head">
        <button
          type="button"
          data-testid="mcp-add"
          onClick={() => setFormSeed(emptyForm(defaultGroup(snapshot, sessionWorkdirRef.current)))}
        >
          添加服务器
        </button>
        <button type="button" className="mcp-refresh" data-testid="mcp-refresh" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      {formSeed !== null && (
        <McpForm
          api={api}
          groupIds={groupIds}
          initial={formSeed}
          onSaved={() => {
            setFormSeed(null)
            void reload()
          }}
          onCancel={() => setFormSeed(null)}
        />
      )}
      {snapshot === null ? (
        <p className="muted">加载中…</p>
      ) : groups.every((g) => g.servers.length === 0) ? (
        <p className="muted" data-testid="mcp-empty">
          还没有接入任何 MCP 服务器。
        </p>
      ) : (
        groups.map((g) => {
          const isFolded = collapsed.has(g.id)
          return (
            <section key={g.id} className="mcp-group" data-testid={`mcp-group-${g.id}`}>
              <button type="button" className="mcp-group-head" data-testid={`mcp-fold-${g.id}`} onClick={() => toggleFold(g.id)}>
                <span className="mcp-fold-mark">{isFolded ? "▸" : "▾"}</span>
                <span className="mcp-group-label">{mcpGroupLabel(g.id)}</span>
                <span className="mcp-group-count">{g.servers.length} 个条目</span>
              </button>
              {!isFolded && g.servers.length > 0 && (
                <ul className="mcp-servers">
                  {g.servers.map((s) => {
                    const key = `${g.id}\u0000${s.name}`
                    return (
                      <li key={s.name} className="mcp-server" data-testid={`mcp-server-${s.name}`}>
                        <div className="mcp-server-head">
                          <span className="mcp-name">{s.name}</span>
                          <span className={`mcp-state ${s.state}`} data-testid={`mcp-state-${s.name}`}>
                            {MCP_STATE_LABELS[s.state] ?? s.state}
                          </span>
                          {s.lastError !== undefined && (
                            <span className="mcp-error" data-testid={`mcp-error-${s.name}`} title={s.lastError}>
                              {s.lastError}
                            </span>
                          )}
                          <span className="mcp-actions">
                            {(s.state === "disconnected" || s.state === "failed") && (
                              <button type="button" data-testid={`mcp-connect-${s.name}`} onClick={() => void connectProbe(g.id, s.name)}>
                                {s.state === "failed" ? "重试" : "连接"}
                              </button>
                            )}
                            <button
                              type="button"
                              data-testid={`mcp-toggle-${s.name}`}
                              onClick={() => void setEnabled(g.id, s.name, s.config.enabled === false)}
                            >
                              {s.config.enabled === false ? "启用" : "禁用"}
                            </button>
                            <button type="button" data-testid={`mcp-edit-${s.name}`} onClick={() => setFormSeed(formFromStatus(s))}>
                              编辑
                            </button>
                            <button type="button" data-testid={`mcp-delete-${s.name}`} onClick={() => void remove(g.id, s.name)}>
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
                              onClick={() => toggleExpand(key)}
                            >
                              {expanded.has(key) ? "收起工具" : `工具（${s.tools.length}）`}
                            </button>
                          )}
                        </div>
                        {expanded.has(key) && (
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
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
