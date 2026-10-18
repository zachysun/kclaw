/**
 * CronView — crons CRUD surface (scheduled crons). GET /cron renders the table
 * (name/cron/enabled/nextRunAt/lastStatus/lastRunAt); one form both creates
 * (POST /cron, enabled checkbox defaults true) and edits (PATCH /cron/:id);
 * a delete button with a native confirm, and a per-row enable/disable toggle
 * (PATCH {enabled}). Server validation errors (an invalid cron is a 400 with
 * `{error}`) surface as the ApiError message in the form error banner.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { type ApiClient } from "../api.js"
import { formatCompactStamp } from "../usage/format.js"
import type { Cron } from "../types.js"

interface CronForm {
  name: string
  cron: string
  prompt: string
  enabled: boolean
}

const EMPTY_FORM: CronForm = { name: "", cron: "", prompt: "", enabled: true }

export function CronView({ api }: { api: ApiClient }) {
  const [crons, setCrons] = useState<Cron[] | null>(null)
  const [form, setForm] = useState<CronForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setCrons(await api.get<Cron[]>("/cron"))
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载任务失败")
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = form.name.trim()
    const cron = form.cron.trim()
    const prompt = form.prompt.trim()
    if (name === "" || cron === "" || prompt === "") {
      setError("name / cron / prompt 均为必填")
      return
    }
    setError(null)
    setBusy(true)
    try {
      if (editingId === null) {
        const created = await api.post<Cron>("/cron", { name, cron, prompt })
        setCrons((prev) => (prev === null ? [created] : [created, ...prev]))
        resetForm()
      } else {
        const updated = await api.patch<Cron>(`/cron/${editingId}`, {
          name,
          cron,
          prompt,
          enabled: form.enabled,
        })
        setCrons((prev) => (prev === null ? prev : prev.map((j) => (j.id === editingId ? updated : j))))
        resetForm()
      }
    } catch (err) {
      // A 400 (e.g. invalid cron) carries the server's {error} message.
      setError(err instanceof Error ? err.message : "保存任务失败")
    } finally {
      setBusy(false)
    }
  }

  const resetForm = (): void => {
    setForm(EMPTY_FORM)
    setEditingId(null)
  }

  const startEdit = (cron: Cron): void => {
    setEditingId(cron.id)
    setForm({ name: cron.name, cron: cron.cron, prompt: cron.prompt, enabled: cron.enabled })
    setError(null)
  }

  const toggleEnabled = async (cron: Cron): Promise<void> => {
    setError(null)
    try {
      const updated = await api.patch<Cron>(`/cron/${cron.id}`, { enabled: !cron.enabled })
      setCrons((prev) => (prev === null ? prev : prev.map((j) => (j.id === cron.id ? updated : j))))
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新任务失败")
    }
  }

  const remove = async (cron: Cron): Promise<void> => {
    if (!window.confirm(`删除任务 "${cron.name}"？`)) return
    setError(null)
    try {
      await api.del(`/cron/${cron.id}`)
      setCrons((prev) => (prev === null ? prev : prev.filter((j) => j.id !== cron.id)))
      if (editingId === cron.id) resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除任务失败")
    }
  }

  return (
    <div className="cron-view" data-testid="cron-view">
      <h2 className="view-title">任务</h2>
      {error !== null && (
        <div className="form-error" data-testid="cron-error" role="alert">
          {error}
        </div>
      )}
      <form className="cron-form" data-testid="cron-form" onSubmit={submit}>
        <h3 className="form-title">{editingId === null ? "新建任务" : "编辑任务"}</h3>
        <div className="form-grid">
          <label>
            任务名
            <input
              data-testid="cron-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="早报"
            />
          </label>
          <label>
            cron 表达式
            <input
              data-testid="cron-cron"
              value={form.cron}
              onChange={(e) => setForm({ ...form, cron: e.target.value })}
              placeholder="0 9 * * *"
            />
          </label>
          <label className="form-full">
            提示词
            <textarea
              data-testid="cron-prompt"
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="给我今日早报"
            />
          </label>
          <label className="form-checkbox">
            <input
              type="checkbox"
              data-testid="cron-enabled"
              checked={form.enabled}
              disabled={editingId === null}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用
            {editingId === null && (
              <span className="form-hint" data-testid="cron-enabled-hint">
                新任务默认启用，创建后可切换
              </span>
            )}
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" data-testid="cron-submit" disabled={busy}>
            {editingId === null ? "创建" : "保存"}
          </button>
          {editingId !== null && (
            <button type="button" data-testid="cron-cancel" onClick={resetForm}>
              取消
            </button>
          )}
        </div>
      </form>
      {crons !== null && crons.length > 0 && (
        <table className="data-table" data-testid="cron-table">
          <thead>
            <tr>
              <th>任务名</th>
              <th>cron</th>
              <th>启用</th>
              <th>下次运行</th>
              <th>上次状态</th>
              <th>上次运行</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {crons.map((cron) => (
              <tr key={cron.id} data-testid={`cron-row-${cron.id}`}>
                <td>{cron.name}</td>
                <td><code>{cron.cron}</code></td>
                <td data-testid={`cron-enabled-${cron.id}`}>{cron.enabled ? "启用" : "禁用"}</td>
                <td>{stampOrDash(cron.nextRunAt)}</td>
                <td>{cron.lastStatus ?? "—"}</td>
                <td>{stampOrDash(cron.lastRunAt)}</td>
                <td className="row-actions">
                  <button type="button" data-testid={`cron-edit-${cron.id}`} onClick={() => startEdit(cron)}>
                    编辑
                  </button>
                  <button type="button" data-testid={`cron-toggle-${cron.id}`} onClick={() => void toggleEnabled(cron)}>
                    {cron.enabled ? "禁用" : "启用"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    data-testid={`cron-delete-${cron.id}`}
                    onClick={() => void remove(cron)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {crons !== null && crons.length === 0 && (
        <p className="muted table-empty" data-testid="cron-empty">
          还没有任务，在上方创建一个。
        </p>
      )}
    </div>
  )
}

/** 排期字段缺值显示 "—"，有值走全站统一的紧凑时间戳。 */
function stampOrDash(iso: string | null | undefined): string {
  return iso === null || iso === undefined || iso === "" ? "—" : formatCompactStamp(iso)
}
