/**
 * The add/edit form for one MCP entry. Owns the field state and the
 * submit/error surface; the parent supplies the entry to prefill (or an
 * empty form with a default target group) plus the target-group options.
 * Saving an edit with a changed target group moves the entry across groups
 * (PATCH toGroup — the manager applies it atomically). env/headers echo
 * back in plaintext by design (local single-user product behind token auth).
 */
import { useState } from "react"
import { mcpGroupLabel } from "@kclaw/core/commands"
import type { McpServerStatus } from "@kclaw/core/protocol"
import type { ApiClient } from "../api.js"

interface Pair {
  key: string
  value: string
}

export interface McpFormState {
  /** Server name being edited; null = a new entry. */
  editing: string | null
  /** The edited entry's owning group (fixes the action target for edits). */
  editGroup: string | null
  name: string
  type: "stdio" | "http"
  /** Target group for the save: "global" or a workdir. */
  group: string
  command: string
  /** One argument per line. */
  argsText: string
  envPairs: Pair[]
  url: string
  headerPairs: Pair[]
  /**
   * Carried through from the entry being edited (the toggle lives on the
   * card, not in the form) — without this, saving an edit to a disabled
   * server would silently re-enable it.
   */
  enabled: boolean
}

export function emptyForm(group: string): McpFormState {
  return { editing: null, editGroup: null, name: "", type: "stdio", group, command: "", argsText: "", envPairs: [], url: "", headerPairs: [], enabled: true }
}

/** Prefill from an existing snapshot entry (plaintext echo of env/headers). */
export function formFromStatus(s: McpServerStatus): McpFormState {
  const c = s.config as Record<string, unknown>
  const pairs = (rec: unknown): Pair[] =>
    rec !== undefined && typeof rec === "object" && !Array.isArray(rec)
      ? Object.entries(rec as Record<string, string>).map(([key, value]) => ({ key, value }))
      : []
  return {
    editing: s.name,
    editGroup: s.group,
    name: s.name,
    type: c.type === "http" ? "http" : "stdio",
    group: s.group,
    command: typeof c.command === "string" ? c.command : "",
    argsText: Array.isArray(c.args) ? (c.args as string[]).join("\n") : "",
    envPairs: pairs(c.env),
    url: typeof c.url === "string" ? c.url : "",
    headerPairs: pairs(c.headers),
    enabled: s.config.enabled !== false,
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

export function McpForm({ api, groupIds, initial, onSaved, onCancel }: {
  api: ApiClient
  /** Offered target groups ("global" first, project workdirs after). */
  groupIds: string[]
  initial: McpFormState
  /** Called after a successful save (the parent closes the form and reloads). */
  onSaved: () => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<McpFormState>(initial)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const args = form.argsText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
    const env = pairsToRecord(form.envPairs)
    const headers = pairsToRecord(form.headerPairs)
    const enabled = form.enabled ? {} : { enabled: false }
    const config =
      form.type === "stdio"
        ? {
            type: "stdio" as const,
            command: form.command,
            ...(args.length > 0 ? { args } : {}),
            ...(env !== undefined ? { env } : {}),
            ...enabled,
          }
        : {
            type: "http" as const,
            url: form.url,
            ...(headers !== undefined ? { headers } : {}),
            ...enabled,
          }
    try {
      if (form.editing === null) {
        await api.post("/mcp/servers", { name: form.name.trim(), config, group: form.group })
      } else {
        const moved = form.editGroup !== null && form.group !== form.editGroup
        await api.patch(
          `/mcp/servers/${encodeURIComponent(form.editing)}`,
          moved
            ? { group: form.editGroup, toGroup: form.group, config }
            : { group: form.editGroup ?? form.group, config },
        )
      }
      onSaved()
    } catch (e) {
      setFormError(String(e))
    }
  }

  return (
    <form
      className="mcp-form"
      data-testid="mcp-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
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
        <label>
          目标
          <select
            data-testid="mcp-form-group"
            value={form.group}
            onChange={(e) => setForm({ ...form, group: e.target.value })}
          >
            {groupIds.map((id) => (
              <option key={id} value={id}>
                {mcpGroupLabel(id)}
              </option>
            ))}
          </select>
        </label>
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
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}
