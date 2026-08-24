/**
 * Job-finish notification channels (bark / Server酱 / generic webhook).
 *
 * Design rules: sending never throws — every failure is reported through
 * `opts.onError` (or swallowed) so a notify hiccup can never break the
 * job pipeline. No external deps: native fetch + AbortSignal.timeout.
 */

export interface NotifyChannel {
  /** Display name used in logs; defaults to `type`. */
  name?: string
  type: "bark" | "serverchan" | "webhook"
  /** Channel endpoint: bark device URL / Server酱 SendKey URL / any webhook URL. */
  url: string
  /** Optional body template; placeholders {{job}} {{status}} {{summary}} {{sessionId}} {{sessionUrl}}. */
  template?: string
}

export interface JobFinishedPayload {
  jobId: string
  jobName: string
  status: "ok" | "error"
  summary: string
  sessionId: string
  sessionUrl: string
}

export interface Notifier {
  notifyJobFinished(payload: JobFinishedPayload): Promise<void>
}

export type FetchImpl = typeof fetch

export interface NotifierOptions {
  /** Per-request timeout; defaults to 10s. */
  timeoutMs?: number
  /** Injection seam for tests. */
  fetchImpl?: FetchImpl
  /** Failure reporter; absent means failures are silently ignored. */
  onError?: (channel: NotifyChannel, error: string) => void
}

const DEFAULT_BODY_TEMPLATE = "{{job}}：{{statusText}}\n{{summary}}\n会话：{{sessionUrl}}"
const DEFAULT_TIMEOUT_MS = 10_000

/** Render `{{placeholder}}` against vars; unknown placeholders become "". */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "")
}

export function createNotifier(channels: NotifyChannel[], opts: NotifierOptions = {}): Notifier {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async notifyJobFinished(payload: JobFinishedPayload): Promise<void> {
      const vars = {
        job: payload.jobName,
        statusText: payload.status === "ok" ? "成功" : "失败",
        status: payload.status,
        summary: payload.summary,
        sessionId: payload.sessionId,
        sessionUrl: payload.sessionUrl,
      }
      const title = `【kclaw】${payload.jobName} ${payload.status === "ok" ? "任务成功" : "任务失败"}`
      const body = render(DEFAULT_BODY_TEMPLATE, vars)
      const results = await Promise.allSettled(
        channels.map((channel) => {
          const text = channel.template ? render(channel.template, vars) : body
          return sendNotification(channel, title, text, payload, fetchImpl, timeoutMs)
        }),
      )
      results.forEach((result, i) => {
        const channel = channels[i]!
        const error =
          result.status === "fulfilled"
            ? result.value.ok
              ? undefined
              : result.value.error
            : String(result.reason)
        if (error !== undefined) opts.onError?.(channel, error)
      })
    },
  }
}

/** Send one notification; never throws. */
export async function sendNotification(
  channel: NotifyChannel,
  title: string,
  body: string,
  payload: JobFinishedPayload,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const channelName = channel.name ?? channel.type
  try {
    let res: Response
    if (channel.type === "serverchan") {
      res = await fetchImpl(channel.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title, desp: body }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } else {
      // bark: {title, body}; webhook: full payload alongside the rendered text.
      const json =
        channel.type === "webhook"
          ? { title, body, jobId: payload.jobId, jobName: payload.jobName, status: payload.status, summary: payload.summary, sessionId: payload.sessionId, sessionUrl: payload.sessionUrl }
          : { title, body }
      res = await fetchImpl(channel.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(json),
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    if (!res.ok) return { ok: false, error: `${channelName}: http ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `${channelName}: ${(err as Error).message}` }
  }
}
