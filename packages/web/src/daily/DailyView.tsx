/**
 * DailyView — 日报页：左栏项目清单，右侧按日期翻阅卡片流（成果/教训/卡点/
 * 观察），每张卡片的展开选项点开后新建该项目会话并把开场文案预填进输入框
 * （不自动发送，用户可改可发）。页头带生成时间设置（PATCH /config 的 daily
 * 节）与"重新生成当天"（同步等响应）。纯 REST 拉取；生成完成不做 ws 推送，
 * 定时生成的结果下次打开本页自然可见。
 */
import { useCallback, useEffect, useState, type FormEvent } from "react"
import type { ApiClient } from "../api.js"
import type { NoticeFn } from "../toast.js"

interface DailyProjectRow { id: string; workdir: string; latest: string }
interface DailyCardOption { label: string; opener: string }
interface DailyCard { kind: "achievement" | "lesson" | "blocker" | "insight"; title: string; body: string; options: DailyCardOption[] }
interface DailyReport { date: string; windowStart: string; windowEnd: string; generatedAt: string; cards: DailyCard[] }
interface DailySettings { hour: number; intervalDays: number }

/** 类型标签：kind 四值映射中文。 */
const KIND_LABEL: Record<DailyCard["kind"], string> = {
  achievement: "成果",
  lesson: "教训",
  blocker: "卡点",
  insight: "观察",
}

export function DailyView({ api, notice, onContinue }: {
  api: ApiClient
  notice: NoticeFn
  /** 卡片展开选项点击：新建该项目会话并预填开场文案（App 层持有跳转逻辑）。 */
  onContinue: (workdir: string, opener: string) => Promise<void>
}) {
  const [projects, setProjects] = useState<DailyProjectRow[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [dates, setDates] = useState<string[] | null>(null)
  const [datesError, setDatesError] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const [report, setReport] = useState<DailyReport | null>(null)
  const [reportError, setReportError] = useState(false)
  /** 错误态的重试驱动：自增触发报告 effect 重拉。 */
  const [reportReloadTick, setReportReloadTick] = useState(0)
  const [settings, setSettings] = useState<DailySettings | null>(null)
  const [hourDraft, setHourDraft] = useState("")
  const [intervalDraft, setIntervalDraft] = useState("")
  const [savingSettings, setSavingSettings] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  const project = projects?.find((p) => p.id === projectId) ?? null

  const reloadProjects = useCallback((): void => {
    api.get<DailyProjectRow[]>("/memory/daily/projects")
      .then((rows) => { setProjects(rows) })
      .catch((e) => { setProjects([]); notice(`加载日报项目失败: ${String(e)}`, "error") })
  }, [api, notice])

  useEffect(() => { reloadProjects() }, [reloadProjects])

  // 生成时间设置：GET /config 的 daily 节（值被掩码的只有密钥，daily 原样可读）
  useEffect(() => {
    api.get<{ daily: DailySettings }>("/config")
      .then((cfg) => {
        setSettings(cfg.daily)
        setHourDraft(String(cfg.daily.hour))
        setIntervalDraft(String(cfg.daily.intervalDays))
      })
      .catch((e) => notice(`加载生成设置失败: ${String(e)}`, "error"))
  }, [api, notice])

  const openProject = useCallback(async (id: string): Promise<void> => {
    setProjectId(id)
    setDates(null); setDatesError(false); setDate(null); setReport(null); setReportError(false)
    try {
      const { dates: ds } = await api.get<{ dates: string[] }>(`/memory/daily/${encodeURIComponent(id)}`)
      setDates(ds)
      if (ds.length > 0) setDate(ds[0]!)
    } catch (e) {
      // 索引加载失败是错误态：不落"还没有日报"空态（空与错必须区分）。
      setDatesError(true)
      notice(`加载日报索引失败: ${String(e)}`, "error")
    }
  }, [api, notice])

  // 自动选第一个项目；有了日期自动打开最新一天（report 拉取由 date effect 接力）
  useEffect(() => {
    if (projects !== null && projectId === null && projects.length > 0) void openProject(projects[0]!.id)
  }, [projects, projectId, openProject])

  useEffect(() => {
    if (projectId === null || date === null) return
    let cancelled = false
    setReport(null); setReportError(false)
    api.get<DailyReport>(`/memory/daily/${encodeURIComponent(projectId)}/${date}`)
      .then((r) => { if (!cancelled) setReport(r) })
      .catch(() => { if (!cancelled) setReportError(true) })
    return () => { cancelled = true }
  }, [api, projectId, date, reportReloadTick])

  const saveSettings = (event: FormEvent): void => {
    event.preventDefault()
    if (settings === null) return
    const hour = Number(hourDraft)
    const intervalDays = Number(intervalDraft)
    if (!Number.isInteger(hour) || hour > 23) { notice("生成时刻必须是 0-23 的整数（负数表示关闭日报）", "error"); return }
    if (!Number.isInteger(intervalDays) || intervalDays < 1) { notice("生成间隔必须是正整数天", "error"); return }
    setSavingSettings(true)
    api.patch<{ daily: DailySettings }>("/config", { daily: { hour, intervalDays } })
      .then((r) => {
        setSettings(r.daily)
        notice("已保存，下一拍调度生效")
      })
      .catch((e) => notice(`保存生成设置失败: ${String(e)}`, "error"))
      .finally(() => setSavingSettings(false))
  }

  const regenerate = (): void => {
    if (projectId === null || date === null) return
    setRegenerating(true)
    api.post<{ report: DailyReport }>(`/memory/daily/${encodeURIComponent(projectId)}/regenerate`, { date })
      .then((r) => { setReport(r.report); notice("已重新生成") })
      .catch((e) => notice(`重新生成失败: ${e instanceof Error ? e.message : String(e)}`, "error"))
      .finally(() => setRegenerating(false))
  }

  /** "今天无文件"象限的 UI 入口：项目还没有日报（或今天缺报）时立即生成今天。 */
  const generateToday = (): void => {
    if (projectId === null) return
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, "0")
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    setRegenerating(true)
    api.post<{ report: DailyReport }>(`/memory/daily/${encodeURIComponent(projectId)}/regenerate`, { date: today })
      .then(() => {
        notice("已生成今天的日报")
        // 重新打开项目：索引里今天已就位，自动选中最新一天。
        return openProject(projectId)
      })
      .catch((e) => notice(`生成失败: ${e instanceof Error ? e.message : String(e)}`, "error"))
      .finally(() => setRegenerating(false))
  }

  const stepDate = (delta: number): void => {
    if (dates === null || date === null) return
    const idx = dates.indexOf(date)
    const next = dates[idx + delta]
    if (next !== undefined) setDate(next)
  }

  return (
    <div className="daily-view" data-testid="daily-view">
      <h2 className="view-title">Daily</h2>
      <div className="daily-list">
        <section>
          <h3>项目</h3>
          {projects === null ? <p className="muted">加载中…</p> : projects.length === 0 ? <p className="muted">还没有项目日报</p> : (
            <ul data-testid="daily-projects">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={p.id === projectId ? "active" : undefined}
                    onClick={() => void openProject(p.id)}
                  >{p.id}{p.latest === "" ? "" : ` · ${p.latest}`}</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <div className="daily-main">
        <form className="daily-settings" data-testid="daily-settings" onSubmit={saveSettings}>
          <label>
            每隔
            <input
              type="number" min={1} step={1} value={intervalDraft}
              data-testid="daily-interval"
              onChange={(e) => setIntervalDraft(e.target.value)}
            />
            天的
            <input
              type="number" step={1} value={hourDraft}
              data-testid="daily-hour"
              onChange={(e) => setHourDraft(e.target.value)}
            />
            点生成（负数关闭）
          </label>
          <button type="submit" disabled={savingSettings || settings === null}>保存设置</button>
        </form>
        {project === null ? (
          <p className="pane-placeholder muted">选择一个项目查看日报</p>
        ) : datesError ? (
          <p className="form-error" data-testid="daily-dates-error">
            加载日报索引失败
            <button type="button" data-testid="daily-dates-retry" onClick={() => { if (projectId !== null) void openProject(projectId) }}>重试</button>
          </p>
        ) : dates === null ? (
          <p className="muted">加载中…</p>
        ) : dates.length === 0 ? (
          <div className="daily-empty" data-testid="daily-empty-project">
            <p className="pane-placeholder muted">这个项目还没有日报——到点后自动生成，也可以现在立即生成今天</p>
            <button
              type="button" data-testid="daily-generate-today" onClick={generateToday} disabled={regenerating}
            >{regenerating ? "生成中…" : "立即生成今天"}</button>
          </div>
        ) : date === null ? (
          <p className="pane-placeholder muted">该日没有日报</p>
        ) : (
          <>
            <div className="daily-datebar">
              <button type="button" data-testid="daily-prev" onClick={() => stepDate(1)} disabled={dates[dates.indexOf(date) + 1] === undefined}>← 早一天</button>
              <span className="daily-date" data-testid="daily-date">{date}</span>
              <button type="button" data-testid="daily-next" onClick={() => stepDate(-1)} disabled={dates.indexOf(date) === 0}>晚一天 →</button>
              <button
                type="button" className="daily-regen" data-testid="daily-regenerate"
                onClick={regenerate} disabled={regenerating}
              >{regenerating ? "重新生成中…" : "重新生成这天"}</button>
            </div>
            {report === null ? (
              reportError ? (
                <p className="form-error" data-testid="daily-report-error">
                  读取日报失败
                  <button type="button" data-testid="daily-report-retry" onClick={() => setReportReloadTick((t) => t + 1)}>重试</button>
                </p>
              ) : <p className="muted">加载中…</p>
            ) : report.cards.length === 0 ? (
              <p className="pane-placeholder muted" data-testid="daily-no-cards">这一天没有生成卡片</p>
            ) : (
              <div className="daily-cards" data-testid="daily-cards">
                {report.cards.map((card, i) => (
                  <article key={`${i}-${card.title}`} className="daily-card" data-testid="daily-card">
                    <header>
                      <span className={`daily-kind kind-${card.kind}`}>{KIND_LABEL[card.kind]}</span>
                      <h3>{card.title}</h3>
                    </header>
                    <p>{card.body}</p>
                    {card.options.length > 0 && (
                      <div className="daily-options">
                        {card.options.map((opt, j) => (
                          <button
                            key={`${i}-${j}-${opt.label}`} type="button"
                            data-testid="daily-option"
                            onClick={() => void onContinue(project.workdir, opt.opener)}
                          >{opt.label}</button>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
