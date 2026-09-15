/**
 * ModelView — provider management tab: the daemon-wide provider snapshot
 * (name, wire format, endpoint, model, masked key) with per-entry actions
 * (verify, set default, edit, delete) plus the add/edit form. A form can
 * start from a built-in preset (URL and format prewritten — only the API
 * key is typed) or fully custom, and can pull the model list from the
 * endpoint (which doubles as the connection test). Fetch-on-entry with a
 * manual refresh button — no polling, no live updates. Data comes from
 * GET /providers; actions ride the /providers family and re-fetch on
 * completion. Keys echo back masked by design; a blank key field on save
 * means "keep the stored key" (honored server-side).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { ApiClient } from "../api.js"
import type { NoticeFn } from "../toast.js"

type ApiFormat = "openai" | "anthropic"

interface ProviderEntryView {
  format?: ApiFormat
  baseUrl: string
  apiKey: string
  model: string
  contextWindow?: number
  maxOutput?: number
}

interface ProviderPreset {
  id: string
  label: string
  format: ApiFormat
  baseUrl: string
  authOptional?: boolean
}

interface ProvidersSnapshot {
  default: string
  entries: Record<string, ProviderEntryView>
  presets: ProviderPreset[]
}

const FORMAT_LABELS: Record<ApiFormat, string> = { openai: "OpenAI 格式", anthropic: "Anthropic 格式" }

const entryFormat = (e: ProviderEntryView): ApiFormat => e.format ?? "openai"

interface FormState {
  /** Entry name being edited; null = a new entry. */
  editing: string | null
  /** Preset vs custom source picker (create only). */
  mode: "preset" | "custom"
  presetId: string
  name: string
  format: ApiFormat
  baseUrl: string
  apiKey: string
  model: string
  contextWindow: string
  maxOutput: string
  /** Fetched model ids; null = text input for the model id. */
  models: string[] | null
}

function emptyForm(): FormState {
  return { editing: null, mode: "preset", presetId: "", name: "", format: "openai", baseUrl: "", apiKey: "", model: "", contextWindow: "", maxOutput: "", models: null }
}

/** Prefill from an existing snapshot entry (masked key shows as placeholder). */
function formFromEntry(name: string, e: ProviderEntryView): FormState {
  return {
    editing: name,
    mode: "custom",
    presetId: "",
    name,
    format: entryFormat(e),
    baseUrl: e.baseUrl,
    apiKey: "",
    model: e.model,
    contextWindow: e.contextWindow !== undefined ? String(e.contextWindow) : "",
    maxOutput: e.maxOutput !== undefined ? String(e.maxOutput) : "",
    models: null,
  }
}

function applyPreset(form: FormState, presetId: string, presets: ProviderPreset[]): FormState {
  const preset = presets.find((p) => p.id === presetId)
  return {
    ...form,
    presetId,
    ...(preset === undefined ? {} : { format: preset.format, baseUrl: preset.baseUrl, name: form.name === "" || isPresetName(form.name, presets) ? preset.id : form.name }),
    models: null,
  }
}

function isPresetName(name: string, presets: ProviderPreset[]): boolean {
  return presets.some((p) => p.id === name)
}

export function ModelView({ api, notice }: {
  api: ApiClient
  notice: NoticeFn
}) {
  // notice goes through a ref: App passes an inline arrow that is a fresh
  // reference each render; depending on `notice` would refetch on every parent
  // re-render (same guard as McpView).
  const noticeRef = useRef(notice)
  useEffect(() => {
    noticeRef.current = notice
  })

  const [snap, setSnap] = useState<ProvidersSnapshot | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; usedBy: number; memoryRefs: boolean } | null>(null)

  const reload = useCallback((): Promise<void> => {
    return api
      .get<ProvidersSnapshot>("/providers")
      .then(setSnap)
      .catch((e) => noticeRef.current(`加载 provider 配置失败: ${String(e)}`, "error"))
  }, [api])

  useEffect(() => {
    void reload()
  }, [reload])

  /** Run one action endpoint, then re-fetch; failures surface in the notice. */
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      await reload()
    } catch (e) {
      noticeRef.current(`操作失败: ${String(e)}`, "error")
    }
  }

  /** Probe an endpoint for its model list; success is the connection test. */
  const probe = async (payload: Record<string, unknown>, probeKey: string): Promise<string[] | null> => {
    setProbing(probeKey)
    try {
      const r = await api.post<{ ok: boolean; models?: string[]; error?: string }>("/providers/models", payload)
      return r.models ?? []
    } catch (e) {
      noticeRef.current(`连接验证失败: ${String(e)}`, "error")
      return null
    } finally {
      setProbing(null)
    }
  }

  const verifyEntry = async (name: string): Promise<void> => {
    const models = await probe({ name }, `entry:${name}`)
    if (models !== null) noticeRef.current(`验证成功：${name} 可达，${models.length} 个模型可用`)
  }

  const fetchModels = async (f: FormState): Promise<void> => {
    const payload: Record<string, unknown> = { format: f.format, baseUrl: f.baseUrl.trim() }
    if (f.editing !== null) payload.name = f.editing
    if (f.apiKey !== "") payload.apiKey = f.apiKey
    const models = await probe(payload, "form")
    if (models === null) return
    if (models.length === 0) {
      noticeRef.current("连接成功，但该端点没有返回任何模型")
      return
    }
    setForm((prev) => (prev === null ? prev : { ...prev, models, model: models.includes(prev.model) ? prev.model : models[0]! }))
  }

  const remove = async (name: string): Promise<void> => {
    // Deletion is never blocked by usage. Sessions and memory references are
    // advisory: referencing sessions fall back to the default model on their
    // next run, and memory extraction/embedding degrade the same way.
    let usedBy = 0
    let memoryRefs = false
    try {
      const metas = await api.get<Array<{ model?: string }>>("/sessions")
      usedBy = metas.filter((m) => m.model === name).length
    } catch {
      // sessions listing is advisory only — proceed with the plain delete
    }
    try {
      const cfg = await api.get<{ memory?: { extractModel?: string; embedding?: { provider?: string } } }>("/config")
      memoryRefs = cfg.memory?.extractModel === name || cfg.memory?.embedding?.provider === name
    } catch {
      // config read is advisory too
    }
    if (usedBy > 0 || memoryRefs) {
      setConfirmDelete({ name, usedBy, memoryRefs })
      return
    }
    await act(() => api.del(`/providers/${encodeURIComponent(name)}`))
  }

  const confirmRemove = async (name: string): Promise<void> => {
    setConfirmDelete(null)
    await act(() => api.del(`/providers/${encodeURIComponent(name)}`))
  }

  const submitForm = async (): Promise<void> => {
    if (form === null) return
    // Presets with a mandatory key (everything except the authOptional ones,
    // i.e. Ollama) refuse a blank key at create time; custom entries stay
    // permissive — keyless self-hosted endpoints are a legitimate shape.
    const preset = (snap?.presets ?? []).find((p) => p.id === form.presetId)
    if (form.editing === null && form.mode === "preset" && preset !== undefined
      && preset.authOptional !== true && form.apiKey === "") {
      setFormError(`${preset.label} 需要 API Key`)
      return
    }
    const entry: Record<string, unknown> = {
      format: form.format,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey,
      model: form.model.trim(),
    }
    for (const key of ["contextWindow", "maxOutput"] as const) {
      const raw = form[key].trim()
      if (raw !== "") entry[key] = Number(raw)
    }
    try {
      if (form.editing === null) {
        await api.post("/providers", { name: form.name.trim(), entry })
      } else {
        await api.patch(`/providers/${encodeURIComponent(form.editing)}`, { entry })
      }
      setForm(null)
      setFormError(null)
      await reload()
    } catch (e) {
      setFormError(String(e))
    }
  }

  const presets = snap?.presets ?? []
  const activePreset = presets.find((p) => p.id === form?.presetId)

  return (
    <div className="model-view" data-testid="model-view">
      <div className="model-head">
        <p className="muted model-intro">
          这些是 daemon 全局的 LLM provider 条目：一个条目 = 一个端点 + 一个模型，每个条目独立建连，
          会话切到某条目即走它的端点与模型（对话页模型下拉里的名字就是这里的条目名）。
          配置保存在 daemon 的 <code>config.json</code>，改动对下一个回合生效。
        </p>
        <button type="button" data-testid="model-add" onClick={() => { setFormError(null); setForm(emptyForm()) }}>
          添加条目
        </button>
        <button type="button" className="model-refresh" data-testid="model-refresh" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      {form !== null && (
        <form
          className="model-form"
          data-testid="model-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submitForm()
          }}
        >
          {form.editing === null && (
            <div className="model-form-row">
              <span className="model-form-source">
                <button
                  type="button"
                  className={form.mode === "preset" ? "active" : ""}
                  data-testid="model-form-mode-preset"
                  onClick={() => setForm(applyPreset({ ...form, mode: "preset", baseUrl: "", presetId: "" }, "", presets))}
                >
                  预设
                </button>
                <button
                  type="button"
                  className={form.mode === "custom" ? "active" : ""}
                  data-testid="model-form-mode-custom"
                  onClick={() => setForm({ ...form, mode: "custom" })}
                >
                  自定义
                </button>
              </span>
              {form.mode === "preset" && (
                <label>
                  供应商
                  <select
                    data-testid="model-form-preset"
                    value={form.presetId}
                    onChange={(e) => setForm(applyPreset(form, e.target.value, presets))}
                  >
                    <option value="">选择预设…</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          {form.mode === "custom" && (
            <label>
              接口格式
              <select
                data-testid="model-form-format"
                value={form.format}
                onChange={(e) => setForm({ ...form, format: e.target.value as ApiFormat, models: null })}
              >
                <option value="openai">OpenAI 兼容（DeepSeek/Ollama 等）</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </label>
          )}
          <div className="model-form-row">
            <label>
              名称
              <input
                data-testid="model-form-name"
                value={form.name}
                disabled={form.editing !== null}
                placeholder="会话与命令里用的条目名"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              API 地址
              <input
                data-testid="model-form-url"
                value={form.baseUrl}
                readOnly={form.mode === "preset" && activePreset !== undefined}
                placeholder="https://…/v1"
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value, models: null })}
              />
            </label>
            <label>
              API Key
              <input
                data-testid="model-form-key"
                type="password"
                value={form.apiKey}
                placeholder={
                  form.editing !== null
                    ? "留空保持不变"
                    : activePreset?.authOptional === true
                      ? "可留空"
                      : "sk-…"
                }
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </label>
          </div>
          <div className="model-form-row">
            <label>
              模型 ID
              {form.models !== null ? (
                <select
                  data-testid="model-form-model-select"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                >
                  {form.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input
                  data-testid="model-form-model"
                  value={form.model}
                  placeholder="例：deepseek-chat"
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              )}
            </label>
            {form.models !== null && (
              <button type="button" data-testid="model-form-model-text" onClick={() => setForm({ ...form, models: null })}>
                手动输入
              </button>
            )}
            <button
              type="button"
              data-testid="model-form-fetch"
              disabled={probing !== null || form.baseUrl.trim() === ""}
              onClick={() => void fetchModels(form)}
            >
              {probing === "form" ? "拉取中…" : "拉取模型列表"}
            </button>
          </div>
          <details className="model-advanced">
            <summary>高级（可选）</summary>
            <div className="model-form-row">
              <label>
                上下文窗口
                <input
                  data-testid="model-form-context"
                  type="number"
                  min={1}
                  value={form.contextWindow}
                  placeholder="token，缺省不限"
                  onChange={(e) => setForm({ ...form, contextWindow: e.target.value })}
                />
              </label>
              <label>
                输出上限
                <input
                  data-testid="model-form-maxout"
                  type="number"
                  min={1}
                  value={form.maxOutput}
                  placeholder="token，缺省供应商默认"
                  onChange={(e) => setForm({ ...form, maxOutput: e.target.value })}
                />
              </label>
            </div>
          </details>
          {formError !== null && (
            <p className="model-form-error" data-testid="model-form-error">
              {formError}
            </p>
          )}
          <div className="model-form-actions">
            <button type="submit" data-testid="model-form-submit">
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
      {snap === null ? (
        <p className="muted">加载中…</p>
      ) : Object.keys(snap.entries).length === 0 ? (
        <p className="muted" data-testid="model-empty">
          还没有配置任何 provider 条目。
        </p>
      ) : (
        <ul className="model-entries">
          {Object.entries(snap.entries).map(([name, e]) => (
            <li key={name} className="model-entry" data-testid={`model-entry-${name}`}>
              <div className="model-entry-head">
                <span className="model-name">{name}</span>
                {snap.default === name && (
                  <span className="model-default" data-testid={`model-default-${name}`}>
                    默认
                  </span>
                )}
                <span className="model-format">{FORMAT_LABELS[entryFormat(e)]}</span>
                <span className="model-actions">
                  {snap.default !== name && (
                    <button
                      type="button"
                      data-testid={`model-setdefault-${name}`}
                      onClick={() => void act(() => api.post(`/providers/${encodeURIComponent(name)}/default`))}
                    >
                      设为默认
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`model-verify-${name}`}
                    disabled={probing !== null}
                    onClick={() => void verifyEntry(name)}
                  >
                    {probing === `entry:${name}` ? "验证中…" : "验证"}
                  </button>
                  <button
                    type="button"
                    data-testid={`model-edit-${name}`}
                    onClick={() => { setFormError(null); setConfirmDelete(null); setForm(formFromEntry(name, e)) }}
                  >
                    编辑
                  </button>
                  <button type="button" data-testid={`model-delete-${name}`} onClick={() => void remove(name)}>
                    删除
                  </button>
                </span>
              </div>
              {confirmDelete?.name === name && (
                <p className="model-warning" data-testid={`model-warning-${name}`}>
                  {confirmDelete.usedBy > 0 && `${confirmDelete.usedBy} 个会话正在使用该条目，删除后这些会话将回落默认模型。`}
                  {confirmDelete.memoryRefs && "记忆提取或向量检索正在使用该条目，删除后将回落默认端点。"}
                  <button type="button" data-testid={`model-delete-confirm-${name}`} onClick={() => void confirmRemove(name)}>
                    确认删除
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(null)}>取消</button>
                </p>
              )}
              <div className="model-meta">
                <code data-testid={`model-url-${name}`}>{e.baseUrl}</code>
                <code data-testid={`model-id-${name}`}>{e.model}</code>
                <code>{e.apiKey}</code>
                {(e.contextWindow !== undefined || e.maxOutput !== undefined) && (
                  <span className="model-limits">
                    {e.contextWindow !== undefined && `窗口 ${e.contextWindow}`}
                    {e.contextWindow !== undefined && e.maxOutput !== undefined && " · "}
                    {e.maxOutput !== undefined && `输出 ${e.maxOutput}`}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
