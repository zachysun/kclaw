/**
 * JobsView — jobs CRUD surface (scheduled jobs). GET /jobs renders the table
 * (name/cron/enabled/nextRunAt/lastStatus/lastRunAt); one form both creates
 * (POST /jobs, enabled checkbox defaults true) and edits (PATCH /jobs/:id);
 * a delete button with a native confirm, and a per-row enable/disable toggle
 * (PATCH {enabled}). Server validation errors (an invalid cron is a 400 with
 * `{error}`) surface as the ApiError message in the form error banner.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { type ApiClient } from "../api.js"
import type { Job } from "../types.js"

interface JobForm {
  name: string
  cron: string
  prompt: string
  enabled: boolean
}

const EMPTY_FORM: JobForm = { name: "", cron: "", prompt: "", enabled: true }

export function JobsView({ api }: { api: ApiClient }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [form, setForm] = useState<JobForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setJobs(await api.get<Job[]>("/jobs"))
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
        const job = await api.post<Job>("/jobs", { name, cron, prompt })
        setJobs((prev) => (prev === null ? [job] : [job, ...prev]))
        resetForm()
      } else {
        const job = await api.patch<Job>(`/jobs/${editingId}`, {
          name,
          cron,
          prompt,
          enabled: form.enabled,
        })
        setJobs((prev) => (prev === null ? prev : prev.map((j) => (j.id === editingId ? job : j))))
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

  const startEdit = (job: Job): void => {
    setEditingId(job.id)
    setForm({ name: job.name, cron: job.cron, prompt: job.prompt, enabled: job.enabled })
    setError(null)
  }

  const toggleEnabled = async (job: Job): Promise<void> => {
    setError(null)
    try {
      const updated = await api.patch<Job>(`/jobs/${job.id}`, { enabled: !job.enabled })
      setJobs((prev) => (prev === null ? prev : prev.map((j) => (j.id === job.id ? updated : j))))
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新任务失败")
    }
  }

  const remove = async (job: Job): Promise<void> => {
    if (!window.confirm(`删除任务 "${job.name}"？`)) return
    setError(null)
    try {
      await api.del(`/jobs/${job.id}`)
      setJobs((prev) => (prev === null ? prev : prev.filter((j) => j.id !== job.id)))
      if (editingId === job.id) resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除任务失败")
    }
  }

  return (
    <div className="jobs-view" data-testid="jobs-view">
      <h2 className="view-title">任务</h2>
      {error !== null && (
        <div className="form-error" data-testid="job-error" role="alert">
          {error}
        </div>
      )}
      <form className="job-form" data-testid="job-form" onSubmit={submit}>
        <h3 className="form-title">{editingId === null ? "新建任务" : "编辑任务"}</h3>
        <div className="form-grid">
          <label>
            name
            <input
              data-testid="job-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="早报"
            />
          </label>
          <label>
            cron
            <input
              data-testid="job-cron"
              value={form.cron}
              onChange={(e) => setForm({ ...form, cron: e.target.value })}
              placeholder="0 9 * * *"
            />
          </label>
          <label className="form-full">
            prompt
            <textarea
              data-testid="job-prompt"
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="给我今日早报"
            />
          </label>
          <label className="form-checkbox">
            <input
              type="checkbox"
              data-testid="job-enabled"
              checked={form.enabled}
              disabled={editingId === null}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            enabled
            {editingId === null && (
              <span className="form-hint" data-testid="job-enabled-hint">
                新任务默认启用，创建后可切换
              </span>
            )}
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" data-testid="job-submit" disabled={busy}>
            {editingId === null ? "创建" : "保存"}
          </button>
          {editingId !== null && (
            <button type="button" data-testid="job-cancel" onClick={resetForm}>
              取消
            </button>
          )}
        </div>
      </form>
      <table className="data-table" data-testid="jobs-table">
        <thead>
          <tr>
            <th>name</th>
            <th>cron</th>
            <th>enabled</th>
            <th>nextRunAt</th>
            <th>lastStatus</th>
            <th>lastRunAt</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs?.map((job) => (
            <tr key={job.id} data-testid={`job-row-${job.id}`}>
              <td>{job.name}</td>
              <td><code>{job.cron}</code></td>
              <td data-testid={`job-enabled-${job.id}`}>{job.enabled ? "启用" : "禁用"}</td>
              <td>{job.nextRunAt}</td>
              <td>{job.lastStatus ?? "—"}</td>
              <td>{job.lastRunAt ?? "—"}</td>
              <td className="row-actions">
                <button type="button" data-testid={`job-edit-${job.id}`} onClick={() => startEdit(job)}>
                  编辑
                </button>
                <button type="button" data-testid={`job-toggle-${job.id}`} onClick={() => void toggleEnabled(job)}>
                  {job.enabled ? "禁用" : "启用"}
                </button>
                <button
                  type="button"
                  className="danger"
                  data-testid={`job-delete-${job.id}`}
                  onClick={() => void remove(job)}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {jobs !== null && jobs.length === 0 && (
        <p className="muted table-empty" data-testid="jobs-empty">
          还没有任务，创建一个开始。
        </p>
      )}
    </div>
  )
}
