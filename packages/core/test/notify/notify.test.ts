import { describe, it, expect } from "vitest"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { createNotifier, type JobFinishedPayload, type NotifyChannel } from "../../src/notify/notify.js"

const PAYLOAD: JobFinishedPayload = {
  jobId: "job-1",
  jobName: "nightly-build",
  status: "ok",
  summary: "all steps passed",
  sessionId: "sess-9",
  sessionUrl: "https://kclaw.local/s/sess-9",
}

/** Capture requests via injected fetchImpl; returns access to the last request per URL key. */
function captureFetch(responses: Array<{ match: string; status: number }> = []) {
  const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }> = []
  let call = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    captured.push({
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers.entries()),
      body: await req.text(),
      signal: init?.signal,
    })
    const match = responses[call] ?? { match: "", status: 200 }
    call++
    if (match.status !== 200 && req.url.includes(match.match)) {
      return new Response("bad gateway", { status: match.status })
    }
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  return { fetchImpl, captured }
}

function lastOf(captured: ReturnType<typeof captureFetch>["captured"], urlPart: string) {
  const found = captured.filter((c) => c.url.includes(urlPart))
  return found[found.length - 1]!
}

describe("notify request shapes per channel", () => {
  it("bark posts JSON {title, body}", async () => {
    const { fetchImpl, captured } = captureFetch()
    const n = createNotifier([{ type: "bark", url: "https://bark.dev/abc" }], { fetchImpl })
    await n.notifyJobFinished(PAYLOAD)
    const req = lastOf(captured, "bark.dev")
    expect(req.method).toBe("POST")
    expect(req.headers["content-type"]).toBe("application/json")
    const body = JSON.parse(req.body)
    expect(body.title).toBe("【kclaw】nightly-build 任务成功")
    expect(body.body).toBe("nightly-build：成功\nall steps passed\n会话：https://kclaw.local/s/sess-9")
    expect(body.desp).toBeUndefined()
  })

  it("serverchan posts urlencoded title + desp", async () => {
    const { fetchImpl, captured } = captureFetch()
    const n = createNotifier([{ type: "serverchan", url: "https://sct.ftqq.com/SENDKEY.send" }], { fetchImpl })
    await n.notifyJobFinished(PAYLOAD)
    const req = lastOf(captured, "sct.ftqq.com")
    expect(req.method).toBe("POST")
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    const params = new URLSearchParams(req.body)
    expect(params.get("title")).toBe("【kclaw】nightly-build 任务成功")
    expect(params.get("desp")).toBe("nightly-build：成功\nall steps passed\n会话：https://kclaw.local/s/sess-9")
  })

  it("webhook posts JSON with all payload fields", async () => {
    const { fetchImpl, captured } = captureFetch()
    const n = createNotifier([{ type: "webhook", url: "https://hooks.dev/jobs" }], { fetchImpl })
    await n.notifyJobFinished({ ...PAYLOAD, status: "error" })
    const req = lastOf(captured, "hooks.dev")
    expect(req.method).toBe("POST")
    expect(req.headers["content-type"]).toBe("application/json")
    const body = JSON.parse(req.body)
    expect(body.title).toBe("【kclaw】nightly-build 任务失败")
    expect(body.body).toContain("失败")
    expect(body).toMatchObject({
      jobId: "job-1",
      jobName: "nightly-build",
      status: "error",
      summary: "all steps passed",
      sessionId: "sess-9",
      sessionUrl: "https://kclaw.local/s/sess-9",
    })
  })

  it("renders custom template placeholders and blanks unknown ones", async () => {
    const { fetchImpl, captured } = captureFetch()
    const channel: NotifyChannel = {
      type: "bark",
      url: "https://bark.dev/abc",
      template: "job={{job}} status={{status}} text={{statusText}} sid={{sessionId}} unknown={{nope}} tail",
    }
    const n = createNotifier([channel], { fetchImpl })
    await n.notifyJobFinished(PAYLOAD)
    const body = JSON.parse(lastOf(captured, "bark.dev").body)
    expect(body.body).toBe("job=nightly-build status=ok text=成功 sid=sess-9 unknown= tail")
  })
})

describe("sendNotification outcomes", () => {
  it("returns {ok:true} on 200", async () => {
    const { fetchImpl } = captureFetch()
    const errors: Array<[NotifyChannel, string]> = []
    const n = createNotifier([{ type: "webhook", url: "https://ok.dev/h" }], { fetchImpl, onError: (c, e) => errors.push([c, e]) })
    await n.notifyJobFinished(PAYLOAD)
    expect(errors).toHaveLength(0)
  })

  it("reports http error status via onError", async () => {
    const { fetchImpl } = captureFetch([{ match: "hooks.dev", status: 502 }])
    const errors: Array<[NotifyChannel, string]> = []
    const n = createNotifier([{ type: "webhook", url: "https://hooks.dev/h" }], { fetchImpl, onError: (c, e) => errors.push([c, e]) })
    await expect(n.notifyJobFinished(PAYLOAD)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]![0].url).toBe("https://hooks.dev/h")
    expect(errors[0]![1]).toContain("502")
  })

  it("swallows fetch rejection (timeout simulation) without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down")
    }) as typeof fetch
    const errors: Array<[NotifyChannel, string]> = []
    const n = createNotifier([{ type: "bark", url: "https://bark.dev/x" }], { fetchImpl, onError: (c, e) => errors.push([c, e]) })
    await expect(n.notifyJobFinished(PAYLOAD)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]![1]).toContain("network down")
  })
})

describe("createNotifier fan-out", () => {
  it("sends to all channels in parallel and reports only the failed one", async () => {
    const { fetchImpl, captured } = captureFetch([
      { match: "hooks.dev", status: 200 },
      { match: "bark.dev", status: 500 },
    ])
    const errors: Array<[NotifyChannel, string]> = []
    const n = createNotifier(
      [
        { type: "webhook", url: "https://hooks.dev/a" },
        { type: "bark", url: "https://bark.dev/b" },
      ],
      { fetchImpl, onError: (c, e) => errors.push([c, e]) },
    )
    await expect(n.notifyJobFinished(PAYLOAD)).resolves.toBeUndefined()
    expect(captured).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]![0].url).toBe("https://bark.dev/b")
    expect(errors[0]![1]).toContain("500")
  })

  it("with zero channels performs no fetch and resolves immediately", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response("{}", { status: 200 })
    }) as typeof fetch
    const n = createNotifier([], { fetchImpl })
    await expect(n.notifyJobFinished(PAYLOAD)).resolves.toBeUndefined()
    expect(calls).toBe(0)
  })
})

describe("real receiver integration", () => {
  it("delivers a webhook notification over real http", async () => {
    const received: Array<{ body: string }> = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        received.push({ body: Buffer.concat(chunks).toString("utf8") })
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    try {
      const n = createNotifier([{ type: "webhook", url: `http://127.0.0.1:${port}/hook` }])
      await n.notifyJobFinished(PAYLOAD)
      expect(received).toHaveLength(1)
      const body = JSON.parse(received[0]!.body)
      expect(body.title).toBe("【kclaw】nightly-build 任务成功")
      expect(body.body).toContain("会话")
      expect(body.jobId).toBe("job-1")
      expect(body.sessionUrl).toBe("https://kclaw.local/s/sess-9")
    } finally {
      server.close()
    }
  })
})
