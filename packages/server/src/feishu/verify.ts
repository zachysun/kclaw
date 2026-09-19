/**
 * Credential check behind the admin page's "test connection" button: one
 * tenant_access_token exchange against the Feishu open API. A one-shot HTTP
 * probe, deliberately NOT behind the FeishuTransport seam (it is not a
 * transport session); tests inject a fake verifier into the channel manager.
 */
const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
const TIMEOUT_MS = 10_000

export interface CredentialCheck {
  ok: boolean
  error?: string
}

export async function verifyFeishuCredentials(appId: string, appSecret: string): Promise<CredentialCheck> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { code?: number; msg?: string }
    if (body.code === 0) return { ok: true }
    return { ok: false, error: body.msg ? `飞书返回 code ${body.code}：${body.msg}` : `飞书返回 code ${body.code}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
