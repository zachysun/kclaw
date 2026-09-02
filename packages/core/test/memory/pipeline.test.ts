import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryPipeline, EXTRACT_SYSTEM_PROMPT, CONSOLIDATE_SYSTEM_PROMPT, type PipelineDeps } from "../../src/memory/pipeline.js"
import { projectIdFor } from "../../src/memory/layout.js"
import { SessionStore } from "../../src/session/store.js"
import type { MemoryEvent } from "../../src/session/events.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"
import { newMessage } from "../../src/protocol/messages.js"
import { scriptedLlm } from "./helpers.js"
import { parseThreadFile } from "../../src/memory/threads.js"

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

  it("clear advances BOTH watermarks (incremental — no full rescan, 回归 2026-09-02)", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    let calls = 0
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "x", op: "new-thread", thread: "x", title: "X", content: "c" }] })]), model: "test" }),
      emit: () => { calls += 1 },
    })
    await pipe.runTrigger(WORKDIR, "clear")
    await pipe.runTrigger(WORKDIR, "interval") // 水位已推进：无范围
    await pipe.runTrigger(WORKDIR, "follow")
    // 只有 clear 那次落盘；后续增量触发不重复提取同一段消息
    expect(calls).toBe(1)
  })

  it("clear 不把已提取过的旧消息再喂给提取器（重复内化回归 2026-09-02）", async () => {
    // 真实时间线复刻：会话 A 里用户强调偏好，memory_save 工具触发 immediate 提取落线；
    // 之后新开会话只发了一句寒暄，POST /sessions 触发 clear——此时提取器不应再见到旧消息。
    const a = sessions.create("a", undefined, WORKDIR)
    sessions.appendMessage(a.id, newMessage(a.id, "user", [{ id: "blk_u1", type: "text", text: "记住，我只听得懂人话" }]))
    sessions.appendMessage(a.id, newMessage(a.id, "assistant", [{ id: "blk_a1", type: "text", text: "记住了，以后直来直去。" }]))
    const inputs: string[] = []
    let call = 0
    const replies = [
      JSON.stringify({ actions: [{ file: "user-pref", op: "new-thread", thread: "user-pref", title: "用户偏好通俗语言", content: "用户明确表示只听得懂人话，要求直白朴素。" }] }),
      JSON.stringify({ actions: [] }), // 寒暄是噪音：修复后提取器只见这一句，按现有规则跳过
    ]
    const deps: PipelineDeps = {
      resolveLlm: () => ({
        llm: {
          async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
            inputs.push(String(req.messages[0]?.content ?? ""))
            yield { type: "text_delta", delta: replies[Math.min(call++, replies.length - 1)]! }
            yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
          },
        },
        model: "test",
      }),
    }
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, deps)
    await pipe.runTrigger(WORKDIR, "immediate", a.id)
    // 次日：新会话只发寒暄，切会话触发 clear
    const b = sessions.create("b", undefined, WORKDIR)
    sessions.appendMessage(b.id, newMessage(b.id, "user", [{ id: "blk_u2", type: "text", text: "在吗" }]))
    await pipe.runTrigger(WORKDIR, "clear", b.id)

    // 提取器调两次（immediate 全量首提 + clear 只处理新到的寒暄）
    expect(inputs).toHaveLength(2)
    // 关键断言：clear 那次的提取输入里不得再出现已提取过的旧消息
    expect(inputs[1]).not.toContain("只听得懂人话")
    expect(inputs[1]).toContain("在吗")
    const threadPath = join(root, "memory", "projects", projectIdFor(WORKDIR), "user-pref.md")
    const tf = parseThreadFile(readFileSync(threadPath, "utf8"))
    // 同一情节不因切会话被重复转述落线
    expect(tf?.sections).toHaveLength(1)
    expect(tf?.sections[0]?.body).toBe("用户明确表示只听得懂人话，要求直白朴素。")
  })

  it("rename in an older session is not skipped after a younger session advanced the watermark (regression 2026-09-02)", async () => {
    // Line incident: user said "改名 master" in a session created EARLIER than the
    // session an interval trigger had advanced the project-wide watermark to.
    // The old messagesSince ordered sessions by createdAt and skipped everything
    // before the watermark session, so the immediate trigger saw an empty range
    // (5ms no-op) and the rename was never extracted. Session-scoped watermarks
    // make this impossible: each session advances only against its own messages.
    const a = sessions.create("a", undefined, WORKDIR) // created first
    const b = sessions.create("b", undefined, WORKDIR) // created later
    seedMessages(b.id, ["b 的背景内容"])
    const inputs: string[] = []
    let call = 0
    const replies = [
      JSON.stringify({ actions: [] }),
      JSON.stringify({ actions: [{ file: "user-name", op: "new-thread", thread: "user-name", title: "用户姓名", content: "用户改名为 master，之后用 master 称呼。" }] }),
    ]
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({
        llm: {
          async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
            inputs.push(String(req.messages[0]?.content ?? ""))
            yield { type: "text_delta", delta: replies[Math.min(call++, replies.length - 1)]! }
            yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
          },
        },
        model: "test",
      }),
    })
    await pipe.runTrigger(WORKDIR, "interval") // interval consumed b's messages
    sessions.appendMessage(a.id, newMessage(a.id, "user", [{ id: "blk_rename", type: "text", text: "改名，我叫 master" }]))
    await pipe.runTrigger(WORKDIR, "immediate", a.id) // memory_save fired in the OLD session

    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toContain("master")
    const tf = parseThreadFile(readFileSync(join(root, "memory", "projects", projectIdFor(WORKDIR), "user-name.md"), "utf8"))
    expect(tf?.sections).toHaveLength(1)
  })

  it("模拟跨会话：A 会话说 a 记 a，B 会话说 b 只记 b——a 不重记、b 正常落线（回归 2026-09-02）", async () => {
    // 会话 A：说 a → immediate 提取，记 a
    const a = sessions.create("a", undefined, WORKDIR)
    sessions.appendMessage(a.id, newMessage(a.id, "user", [{ id: "blk_u1", type: "text", text: "记住，我只听得懂人话" }]))
    const inputs: string[] = []
    let call = 0
    const replies = [
      JSON.stringify({ actions: [{ file: "user-pref", op: "new-thread", thread: "user-pref", title: "用户偏好通俗语言", content: "用户明确表示只听得懂人话，要求直白朴素。" }] }),
      JSON.stringify({ actions: [{ file: "running", op: "new-thread", thread: "running", title: "跑步记录", content: "用户昨晚跑了五公里，配速六分半。" }] }),
    ]
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({
        llm: {
          async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
            inputs.push(String(req.messages[0]?.content ?? ""))
            yield { type: "text_delta", delta: replies[Math.min(call++, replies.length - 1)]! }
            yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
          },
        },
        model: "test",
      }),
    })
    // 会话 A 进行中：memory_save 工具触发 immediate，此时只有 a
    await pipe.runTrigger(WORKDIR, "immediate", a.id)
    // 之后才开 B 会话说 b，切会话触发 clear
    const b = sessions.create("b", undefined, WORKDIR)
    sessions.appendMessage(b.id, newMessage(b.id, "user", [{ id: "blk_u2", type: "text", text: "我昨晚跑了五公里，配速六分半" }]))
    await pipe.runTrigger(WORKDIR, "clear", b.id)

    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    // a 只有一条，没被 B 会话的提取重记
    const tfA = parseThreadFile(readFileSync(join(projectDir, "user-pref.md"), "utf8"))
    expect(tfA?.sections).toHaveLength(1)
    // b 正常落线；这次提取输入里有 b、没有 a
    const tfB = parseThreadFile(readFileSync(join(projectDir, "running.md"), "utf8"))
    expect(tfB?.sections).toHaveLength(1)
    expect(tfB?.sections[0]?.body).toContain("五公里")
    expect(inputs[1]).toContain("五公里")
    expect(inputs[1]).not.toContain("只听得懂人话")
  })

  it("new-thread 身份以 file 为准：thread 字段不一致时 topic 跟随 file（读取线 404 回归 2026-09-02）", async () => {
    // 真实案例：模型交回 file:"user-abcd-profile" + thread:"user-name-abcd"，落盘后
    // 文件名与内部 topic 分裂——MEMORY.md 行按 topic 显示，点击按文件名找，404。
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["记住，我叫abcd"])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "user-abcd-profile", op: "new-thread", thread: "user-name-abcd", title: "用户姓名 abcd", content: "用户要求记住自己的名字叫 abcd。" }] })]), model: "test" }),
    })
    await pipe.runTrigger(WORKDIR, "immediate", meta.id)
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    const tf = parseThreadFile(readFileSync(join(projectDir, "user-abcd-profile.md"), "utf8"))
    expect(tf?.topic).toBe("user-abcd-profile")
    const memoryMd = readFileSync(join(projectDir, "MEMORY.md"), "utf8")
    expect(memoryMd).toContain("user-abcd-profile")
    expect(memoryMd).not.toContain("user-name-abcd")
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

  it("auto-inactivates idle threads even on an empty batch (no new messages)", async () => {
    // 项目静止（无任何会话消息）：一次 interval 触发也应收束到期的 active 线。
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "old.md"), [
      "---", "topic: old", "title: 旧线", "status: active", "created: 2026-08-01", "updated: 2026-08-13", "---", "",
      "## 2026-08-13 · 旧情节", "", "- 做了什么：旧内容", "",
    ].join("\n"), "utf8")
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [] })]), model: "m" }),
      now: () => new Date("2026-08-28T00:00:00Z"), // 距线 updated（8-13）15 天 ≥ 14
    })
    // sessions 无消息 → 范围为空；仍应收束并重建 MEMORY.md
    await pipe.runTrigger(WORKDIR, "interval")
    expect(readFileSync(join(projectDir, "old.md"), "utf8")).toContain("status: inactive")
    const memoryMd = readFileSync(join(projectDir, "MEMORY.md"), "utf8")
    expect(memoryMd).toContain("| old | 旧线 | inactive | 2026-08-13 |")
  })

  it("empty-batch sweep consolidates the inactivated thread into global cognitions", async () => {
    // 静止项目：空批次收束到期线后同样触发内化（spec 4.2/6）——否则该线的认知
    // 永远不会被总结（线不复活、收束只扫 active，之后再无新情节触发内化）。
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "old.md"), [
      "---", "topic: old", "title: 旧线", "status: active", "created: 2026-08-01", "updated: 2026-08-13", "---", "",
      "## 2026-08-13 · 旧情节", "", "- 做了什么：旧内容", "",
    ].join("\n"), "utf8")
    const written: Array<{ path: string; kind: string }> = []
    const llm = scriptedLlm([
      JSON.stringify({ actions: [{ target: "rule", name: "general", op: "append", content: "旧线教训：静止项目也要定期收束" }] }),
    ])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
      now: () => new Date("2026-08-28T00:00:00Z"), // 距线 updated（8-13）15 天 ≥ 14
      emit: (e) => { written.push({ path: e.path, kind: e.kind }) },
    })
    await pipe.runTrigger(WORKDIR, "interval") // 空批次：范围空，只有收束 + 内化走 LLM
    const rulePath = join(root, "memory", "global", "rule", "general.md")
    expect(written.some((w) => w.path === rulePath && w.kind === "cognition")).toBe(true)
    expect(readFileSync(rulePath, "utf8")).toContain("静止项目也要定期收束")
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

  it("memory 事件带 trigger 与归属 sessionId 发出", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    // 预置已有线让 append 命中（目标线缺失会降级为 new-thread）
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "x.md"), [
      "---", "topic: x", "title: X", "status: active", "created: 2026-08-01", "updated: 2026-08-01", "---", "",
      "## 2026-08-01 · 旧", "", "- 做了什么：旧", "",
    ].join("\n"), "utf8")
    const audits: MemoryEvent[] = []
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "x", op: "append", content: "- 做了什么：新情节" }] })]), model: "m" }),
      audit: (e) => audits.push({ type: "memory", at: e.at!, ...e } as MemoryEvent),
    })
    await pipe.runTrigger(WORKDIR, "manual", meta.id)
    expect(audits.some((a) => a.trigger === "manual" && a.kind === "episode" && a.op === "append" && a.sessionId === meta.id)).toBe(true)
  })

  it("cognition 内化事件带 trigger 与归属 sessionId", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    const llm = scriptedLlm([
      JSON.stringify({ actions: [{ file: "t1", op: "new-thread", thread: "t1", title: "T1", content: "情节", status: "inactive" }] }),
      JSON.stringify({ actions: [{ target: "rule", name: "general", op: "append", content: "内化规则", source: "t1#2026-08-28" }] }),
    ])
    const audits: MemoryEvent[] = []
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
      audit: (e) => audits.push({ type: "memory", at: e.at!, ...e } as MemoryEvent),
    })
    await pipe.runTrigger(WORKDIR, "follow", meta.id)
    expect(audits.some((a) => a.trigger === "follow" && a.kind === "cognition" && a.op === "append" && a.file === "rule/general" && a.sessionId === meta.id)).toBe(true)
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

  it("drops cognition actions whose target is not persona/wiki/rule — no stray files in global", async () => {
    // 回归（2026-09-01）：prompt 的 "wiki:<name>" 记法诱导模型把名字嵌进 target
    //（如 "wiki:用户偏好"），旧校验只查"是字符串"，#applyCognitionAction 会把它
    // 当目录类别写出永远不被索引/读取的垃圾文件。
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    const logs: string[] = []
    const llm = scriptedLlm([
      JSON.stringify({ actions: [{ file: "t1", op: "new-thread", thread: "t1", title: "T1", content: "情节", status: "inactive" }] }),
      JSON.stringify({ actions: [
        { target: "wiki:用户偏好", op: "append", content: "嵌名 target", source: "t1#2026-08-28" },
        { target: "认知", op: "append", content: "非法类别", source: "t1#2026-08-28" },
        { target: "wiki", op: "append", content: "wiki 缺 name", source: "t1#2026-08-28" },
      ] }),
    ])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
      log: (m) => logs.push(m),
    })
    await pipe.runTrigger(WORKDIR, "interval")
    const globalDir = join(root, "memory", "global")
    const entries = existsSync(globalDir) ? readdirSync(globalDir) : []
    expect(entries.filter((e) => e.includes(":") || e === "认知" || e === "skill")).toHaveLength(0)
    expect(existsSync(join(globalDir, "wiki", "misc.md"))).toBe(false) // 缺 name 的 wiki 不落到 misc
    expect(logs.some((l) => l.includes("dropping malformed cognition action"))).toBe(true)
  })

  it("legal cognition actions (persona / wiki+name / rule+name) still land after the tightened check", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["内容"])
    const llm = scriptedLlm([
      JSON.stringify({ actions: [{ file: "t1", op: "new-thread", thread: "t1", title: "T1", content: "情节", status: "inactive" }] }),
      JSON.stringify({ actions: [
        { target: "persona", op: "append", content: "用户画像正文", source: "t1#2026-08-28" },
        { target: "wiki", name: "kclaw", op: "create", content: "kclaw 是个人助理" },
        { target: "rule", name: "general", op: "append", content: "一条规范" },
      ] }),
    ])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm, model: "m" }),
    })
    await pipe.runTrigger(WORKDIR, "interval")
    expect(readFileSync(join(root, "memory", "global", "persona.md"), "utf8")).toContain("用户画像正文")
    expect(readFileSync(join(root, "memory", "global", "wiki", "kclaw.md"), "utf8")).toContain("个人助理")
    expect(readFileSync(join(root, "memory", "global", "rule", "general.md"), "utf8")).toContain("一条规范")
  })
})

describe("提取/内化的接口约定（prompt ↔ 校验对齐，回归 2026-09-01）", () => {
  it("EXTRACT_SYSTEM_PROMPT pins the field names: op discriminator, mandatory file, full JSON example", () => {
    // 提示词必须与 #extract 校验（file 非空 + op 三值）说同一套字段名——
    // 真实模型按 prompt 写 JSON，字段名只在这里教。示例必须同时含 op 与 file。
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"op"')
    expect(EXTRACT_SYSTEM_PROMPT).toContain('"file"')
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/\{"op":"new-thread","file":"[^"]+"/)
  })

  it("CONSOLIDATE_SYSTEM_PROMPT pins target 三值与 name 必填，清除 wiki:<name> 歧义记法", () => {
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('"persona"')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('"wiki"')
    expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('"rule"')
    expect(CONSOLIDATE_SYSTEM_PROMPT).not.toContain("wiki:<name>")
    expect(CONSOLIDATE_SYSTEM_PROMPT).not.toContain('target:"wiki"+name')
  })

  it("real-model-shaped extract actions (type discriminator, no file) are dropped; no thread file written", async () => {
    // 锁既有语义：deepseek 真实返回 {"type":"new-thread",...}（无 file）——校验丢弃，
    // 且不因丢弃而阻塞 watermark 推进（丢弃 ≠ 失败）。见 docs/core/memory.md 提取节。
    const meta = sessions.create("s", undefined, WORKDIR)
    seedMessages(meta.id, ["记住，我是小白，请说人话"])
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ type: "new-thread", thread: "user-pref", title: "用户偏好", content: "内容" }] })]), model: "m" }),
    })
    await pipe.runTrigger(WORKDIR, "immediate", meta.id)
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    const threads = existsSync(projectDir) ? readdirSync(projectDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md") : []
    expect(threads).toHaveLength(0)
  })
})

describe("runNightly（夜间闲时内化）", () => {
  const writeThread = (projectDir: string, updated: string): void => {
    writeFileSync(join(projectDir, "deploy.md"), [
      "---", "topic: deploy", "title: 部署", "status: active", "created: 2026-08-01", `updated: ${updated}`, "---", "",
      `## ${updated} · 情节`, "", "- 做了什么：部署上线", "",
    ].join("\n"), "utf8")
  }

  it("consolidates an active thread updated today (first run, baseline = today); thread stays active", async () => {
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    mkdirSync(projectDir, { recursive: true })
    writeThread(projectDir, "2026-09-01")
    const audits: MemoryEvent[] = []
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ target: "rule", name: "ops", op: "append", content: "部署经验：先灰度" }] })]), model: "m" }),
      now: () => new Date("2026-09-01T20:00:00Z"),
      audit: (e) => audits.push({ type: "memory", at: e.at!, ...e } as MemoryEvent),
    })
    const n = await pipe.runNightly(WORKDIR, "ses_A")
    expect(n).toBe(1)
    const rulePath = join(root, "memory", "global", "rule", "ops.md")
    expect(readFileSync(rulePath, "utf8")).toContain("先灰度")
    expect(audits.some((a) => a.trigger === "nightly" && a.kind === "cognition" && a.sessionId === "ses_A")).toBe(true)
    // 夜间内化不动线状态：活跃线保持 active（收束仍由四触发顺带做）
    expect(readFileSync(join(projectDir, "deploy.md"), "utf8")).toContain("status: active")
  })

  it("skips threads older than the baseline; a newly updated thread is picked up next night", async () => {
    const projectDir = join(root, "memory", "projects", projectIdFor(WORKDIR))
    mkdirSync(projectDir, { recursive: true })
    writeThread(projectDir, "2026-08-01")
    let consolidateCalls = 0
    const makePipe = (nowISO: string): MemoryPipeline => new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ target: "rule", name: "ops", op: "append", content: "x" }] })]), model: "m" }),
      now: () => new Date(nowISO),
      audit: () => { consolidateCalls += 1 },
    })
    // 首跑（baseline = 9-01）：updated 8-01 的旧线不内化——历史线由顺带内化覆盖，不补跑
    expect(await makePipe("2026-09-01T20:00:00Z").runNightly(WORKDIR)).toBe(0)
    expect(consolidateCalls).toBe(0)
    // 线有了新情节（updated 推进到 9-01）→ 次日夜间内化（baseline 9-01，updated >= baseline）
    writeThread(projectDir, "2026-09-01")
    expect(await makePipe("2026-09-02T20:00:00Z").runNightly(WORKDIR)).toBe(1)
    expect(consolidateCalls).toBe(1)
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
