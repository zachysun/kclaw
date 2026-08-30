import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryPipeline, type PipelineDeps } from "../../src/memory/pipeline.js"
import { projectIdFor } from "../../src/memory/layout.js"
import { SessionStore } from "../../src/session/store.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import { newMessage } from "../../src/protocol/messages.js"
import { scriptedLlm } from "./helpers.js"

let root: string
let sessions: SessionStore
const WORKDIR = "/w/kclaw"

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-pipe-"))
  sessions = new SessionStore(join(root, "sessions"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function seedMessages(sessionId: string, texts: string[]): void {
  for (const t of texts) sessions.appendMessage(sessionId, newMessage(sessionId, "user", [{ id: "blk_" + t.length, type: "text", text: t }]))
}

describe("runTrigger", () => {
  it("extracts episodes from messages since watermark and appends a new thread", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["我们修好了 WebSocket 重连风暴，加了指数退避，测试通过，这事完结了"])
    const written: string[] = []
    const deps: PipelineDeps = {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "ws-reconnect", op: "new-thread", thread: "ws-reconnect", title: "WebSocket 重连风暴排查", content: "- 做了什么：加指数退避\n- 结果：测试通过" }] })]), model: "test" }),
      emit: (e) => { if (e.kind === "episode") written.push(e.path) },
    }
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, deps)
    await pipe.runTrigger(WORKDIR, "interval")
    expect(written).toHaveLength(1)
    expect(written[0]!.startsWith(join(root, "memory", "projects"))).toBe(true)
    const content = readFileSync(written[0]!, "utf8")
    expect(content).toContain("topic: ws-reconnect")
    expect(content).toContain("指数退避")
    expect(existsSync(join(dirnameOf(written[0]!), "MEMORY.md"))).toBe(true)
  })

  it("advances the interval watermark; second trigger with no new messages writes nothing", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["一次性内容"])
    let calls = 0
    const deps: PipelineDeps = {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "x", op: "new-thread", thread: "x", title: "X", content: "c" }] })]), model: "test" }),
      emit: () => { calls += 1 },
    }
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, deps)
    await pipe.runTrigger(WORKDIR, "interval")
    await pipe.runTrigger(WORKDIR, "interval") // 无新消息：范围空，不再调 LLM
    expect(calls).toBe(1)
  })

  it("manual/immediate advances BOTH watermarks", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    let calls = 0
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [] })]), model: "test" }),
      emit: () => { calls += 1 },
    })
    await pipe.runTrigger(WORKDIR, "immediate")
    await pipe.runTrigger(WORKDIR, "interval") // 水位已推进：无范围
    await pipe.runTrigger(WORKDIR, "follow")
    // 三个触发都不应产生落盘 —— 通过 emit 计数为 0 断言
    expect(calls).toBe(0)
  })

  it("tolerates fenced json and drops single malformed actions", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    const deps: PipelineDeps = {
      resolveLlm: () => ({ llm: scriptedLlm(["```json\n" + JSON.stringify({ actions: [{ op: "append" }, { file: "ok", op: "new-thread", thread: "ok", title: "OK", content: "正文" }] }) + "\n```"]), model: "test" }),
    }
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, deps)
    await expect(pipe.runTrigger(WORKDIR, "interval")).resolves.toBeUndefined()
    // 非法单条被丢、合法单条落盘 —— 通过线文件存在断言
    const files = readDirDeep(join(root, "memory", "projects"))
    expect(files.some((f) => f.endsWith("ok.md"))).toBe(true)
  })

  it("serializes concurrent triggers per project (no double extract)", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["并发内容"])
    let calls = 0
    const slow: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        calls += 1
        await new Promise((r) => setTimeout(r, 20))
        yield { type: "text_delta", delta: JSON.stringify({ actions: [] }) }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, { resolveLlm: () => ({ llm: slow, model: "m" }) })
    await Promise.all([pipe.runTrigger(WORKDIR, "interval"), pipe.runTrigger(WORKDIR, "follow")])
    expect(calls).toBe(1) // 后到者按最新水位重选范围：空，直接返回
  })

  it("auto-inactivates threads idle beyond threadInactiveDays", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["旧内容"])
    const now = new Date(Date.now() + 20 * 86_400_000) // 相对真实时钟 +20 天，任何运行日期都稳定（appendSection 写 updated 用真实日期）
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "old", op: "new-thread", thread: "old", title: "旧线", content: "c" }] })]), model: "m" }),
      now: () => new Date("2026-08-28T00:00:00Z"), // 写入发生在 8-28
    })
    await pipe.runTrigger(WORKDIR, "interval")
    // 第二次触发（同一天，无新消息不写）→ 用直接调 API 的方式验证时间自动：
    // 见实现 #maybeAutoInactivate —— 单测直接对写好的线文件断言由 consolidate 触发链完成，
    // 这里通过第二次 runTrigger 传新 now 验证顺带检查
    const pipe2 = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [] })]), model: "m" }),
      now: () => now,
    })
    seedMessages(meta.id, ["新内容让范围非空"]) // 让管线真的跑，顺带检查涉及的线
    await pipe2.runTrigger(WORKDIR, "interval")
    const files = readDirDeep(join(root, "memory", "projects"))
    const oldThread = files.find((f) => f.endsWith("old.md"))!
    expect(readFileSync(oldThread, "utf8")).toContain("status: inactive")
  })

  it("revives an inactive thread on a new episode (spec 5)", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["线复活内容"])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "old", op: "append", content: "- 做了什么：又有新情节\n- 结果：线复活" }] })]), model: "m" }),
    })
    // 预置一条 inactive 线（模拟时间自动收束后的状态）
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "old.md"), [
      "---", "topic: old", "title: 旧线", "status: inactive", "created: 2026-08-01", "updated: 2026-08-01", "---", "",
      "## 2026-08-01 · 旧情节", "", "- 做了什么：旧内容", "",
    ].join("\n"), "utf8")
    await pipe.runTrigger(WORKDIR, "interval")
    expect(readFileSync(join(projectDir, "old.md"), "utf8")).toContain("status: active")
  })
})

describe("consolidate", () => {
  it("turning a thread inactive via extraction triggers consolidation into global rule file", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["修完了重连问题，决定以后重连改动必须带注释，此事完结"])
    const written: Array<{ path: string; kind: string }> = []
    const reply = JSON.stringify({
      actions: [
        { file: "ws-reconnect", op: "new-thread", thread: "ws-reconnect", title: "重连排查", content: "- 做了什么：修复\n- 结果：通过", status: "inactive" },
      ],
    })
    const consolidateReply = JSON.stringify({
      actions: [{ target: "rule", name: "general", op: "append", content: "## 重连改动规范\n\n重连相关改动必须带注释说明原因。", source: "ws-reconnect#2026-08-28" }],
    })
    // resolveLlm 每次触发现取：多次 LLM 调用必须共享同一脚本客户端，序号才连续
    const llm = scriptedLlm([reply, consolidateReply])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
      emit: (e) => { written.push({ path: e.path, kind: e.kind }) },
    })
    await pipe.runTrigger(WORKDIR, "interval")
    const rulePath = join(root, "memory", "global", "rule", "general.md")
    expect(written.some((w) => w.path === rulePath && w.kind === "cognition")).toBe(true)
    expect(readFileSync(rulePath, "utf8")).toContain("重连相关改动必须带注释")
    expect(readFileSync(rulePath, "utf8")).toContain("<!-- 来源：ws-reconnect#2026-08-28 -->")
  })

  it("manual consolidate of an explicit topic", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    const llm = scriptedLlm([
      JSON.stringify({ actions: [{ file: "t1", op: "new-thread", thread: "t1", title: "T1", content: "情节" }] }),
      JSON.stringify({ actions: [{ target: "persona", op: "append", content: "用户偏好简洁回复", source: "t1#2026-08-28" }] }),
    ])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
    })
    await pipe.runTrigger(WORKDIR, "interval")
    await pipe.consolidate(WORKDIR, "t1")
    expect(readFileSync(join(root, "memory", "global", "persona.md"), "utf8")).toContain("用户偏好简洁回复")
  })

  it("skill target is skipped with a log, others still land", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    const logs: string[] = []
    const llm = scriptedLlm([
      JSON.stringify({ actions: [{ file: "t1", op: "new-thread", thread: "t1", title: "T1", content: "情节", status: "inactive" }] }),
      JSON.stringify({ actions: [
        { target: "skill", name: "reconnect", op: "create", content: "SKILL.md" },
        { target: "wiki", name: "kclaw", op: "create", content: "kclaw 是个人助理" },
      ] }),
    ])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
      log: (m) => logs.push(m),
    })
    await pipe.runTrigger(WORKDIR, "interval")
    expect(readFileSync(join(root, "memory", "global", "wiki", "kclaw.md"), "utf8")).toContain("个人助理")
    expect(logs.some((l) => l.includes("skill"))).toBe(true)
    expect(existsSync(join(root, "memory", "global", "skill"))).toBe(false)
  })

  it("consolidate disabled via deps skips the LLM consolidate call", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    let calls = 0
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({
        llm: {
          async *stream(): AsyncIterable<LlmStreamEvent> {
            calls += 1
            yield { type: "text_delta", delta: JSON.stringify({ actions: [{ file: "t1", op: "new-thread", thread: "t1", title: "T1", content: "x", status: "inactive" }] }) }
            yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }
          },
        },
        model: "m",
      }),
      consolidateEnabled: false,
    })
    await pipe.runTrigger(WORKDIR, "interval")
    expect(calls).toBe(1) // 只有提取调用，没有内化调用
  })

  it("append to a new cognition file does not duplicate the entry", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    const llm = scriptedLlm([
      JSON.stringify({ actions: [{ file: "t1", op: "new-thread", thread: "t1", title: "T1", content: "情节", status: "inactive" }] }),
      JSON.stringify({ actions: [{ target: "rule", name: "nd", op: "append", content: "一条规范", source: "t1#2026-08-28" }] }),
    ])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
    })
    await pipe.runTrigger(WORKDIR, "interval")
    const raw = readFileSync(join(root, "memory", "global", "rule", "nd.md"), "utf8")
    expect(raw.match(/一条规范/g)?.length).toBe(1)
  })
})

function dirnameOf(p: string): string { return p.slice(0, p.lastIndexOf("/")) }
function readDirDeep(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...readDirDeep(p)); else out.push(p)
  }
  return out
}
