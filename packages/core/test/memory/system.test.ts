import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemorySystem } from "../../src/memory/system.js"
import { SessionStore } from "../../src/session/store.js"
import { defaultConfig } from "../../src/storage/config.js"
import { projectIdFor } from "../../src/memory/layout.js"
import { VectorIndex } from "../../src/memory/indexer.js"
import { scriptedLlm } from "./helpers.js"

let root: string
let sessions: SessionStore
const WORKDIR = "/w/kclaw"
const OTHER = "/w/other"

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-sys-"))
  sessions = new SessionStore(join(root, "sessions"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function makeSystem(over: Partial<Parameters<typeof MemorySystem.prototype.constructor>[0]> = {}): MemorySystem {
  return new MemorySystem({
    memoryDir: join(root, "memory"),
    sessions,
    config: structuredClone(defaultConfig),
    resolveLlm: () => ({ llm: scriptedLlm(["{\"actions\":[]}"]), model: "m" }),
    ...over,
  })
}

describe("cognitionPrompt (L2 常驻注入)", () => {
  it("includes global + current-project files only, in the spec block order", () => {
    const sys = makeSystem()
    mkdirSync(join(root, "memory"), { recursive: true })
    // 直接用管理写入口布认知（也顺路测了写入口）
    sys.writeCognition("persona", "persona", "Master 偏好中文。")
    sys.writeCognition("rule", "general", "始终中文回复。")           // global
    sys.writeCognition("wiki", "dev-machine", "开发机是 macOS。")      // global
    // 项目专属规则：手工放置 scope 文件（模拟内化产物）
    const projId = projectIdFor(WORKDIR)
    const otherId = projectIdFor(OTHER)
    writeFileSync(join(root, "memory", "global", "rule", "kclaw.md"), `---\ntitle: kclaw 项目规则\nscope: project:${projId}\ncreated: 2026-08-01\nupdated: 2026-08-01\n---\n\nkclaw 必须 TDD\n`)
    writeFileSync(join(root, "memory", "global", "rule", "other.md"), `---\ntitle: other 项目规则\nscope: project:${otherId}\ncreated: 2026-08-01\nupdated: 2026-08-01\n---\n\nother 专属规则\n`)
    const prompt = sys.cognitionPrompt(WORKDIR)
    expect(prompt).toContain("Master 偏好中文。")
    expect(prompt).toContain("始终中文回复。")
    expect(prompt).toContain("kclaw 必须 TDD")          // 当前项目 scope 的规则进来
    expect(prompt).not.toContain("other 专属规则")        // 别的项目 scope 不进来
    expect(prompt).toContain("[关于用户]")
    expect(prompt).toContain("[项目认知]")
    expect(prompt).toContain("[通用规则]")
  })
  it("drops whole files over budget by rule > persona > wiki, never truncates", () => {
    const cfg = structuredClone(defaultConfig)
    cfg.memory.injectTokenBudget = 30 // 极小预算：容不下 wiki 大文件
    const sys = makeSystem({ config: cfg })
    sys.writeCognition("rule", "general", "规则一二三四五六七八九十。")
    sys.writeCognition("persona", "persona", "画像。")
    sys.writeCognition("wiki", "big", "很".repeat(200))
    const prompt = sys.cognitionPrompt(WORKDIR)
    expect(prompt).toContain("规则一二三四五六七八九十")
    expect(prompt).not.toContain("很很很") // wiki 整文件跳过（不截断）
  })
})

describe("migrateV1Notes", () => {
  it("routes preference/rule/fact notes into persona/rule/wiki and deletes notes/", () => {
    const notesDir = join(root, "notes")
    mkdirSync(notesDir, { recursive: true })
    writeFileSync(join(notesDir, "mem_1.md"), `---\nid: mem_1\ntags: []\ncreated: 2026-01-01\nupdated: 2026-01-01\nsource: model\n---\n\n用户偏好深色主题\n`)
    writeFileSync(join(notesDir, "mem_2.md"), `---\nid: mem_2\n---\n\n发布前必须跑全量测试\n`)
    writeFileSync(join(notesDir, "mem_3.md"), `---\nid: mem_3\n---\n\n家里有一只猫\n`)
    const sys = makeSystem()
    sys.migrateV1Notes(notesDir)
    expect(readFileSync(join(root, "memory", "global", "persona.md"), "utf8")).toContain("深色主题")
    expect(readFileSync(join(root, "memory", "global", "rule", "general.md"), "utf8")).toContain("全量测试")
    expect(readFileSync(join(root, "memory", "global", "wiki", "misc.md"), "utf8")).toContain("一只猫")
    // 首条不重复（writeCognitionFile 的 create/append 双拼守卫）
    expect(readFileSync(join(root, "memory", "global", "persona.md"), "utf8").match(/深色主题/g)?.length).toBe(1)
    expect(existsSync(notesDir)).toBe(false)
    // 幂等：notes 不存在再跑无事可做
    expect(() => sys.migrateV1Notes(notesDir)).not.toThrow()
  })
})

describe("search preserves reconciled vectors (spec 7.2)", () => {
  it("reindex during search does not wipe project vectors (dual-path fusion intact)", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, { id: "m1", sessionId: meta.id, role: "user", blocks: [{ id: "b", type: "text", text: "重连风暴修好了" }], createdAt: new Date().toISOString() })
    // 确定性 embed mock：任何文本都返回同一向量，便于断言向量路参与
    const embed = { embed: async (texts: string[]): Promise<Float32Array[]> => texts.map(() => new Float32Array([1, 0, 0])) }
    const sys = makeSystem({
      embed,
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "ws", op: "new-thread", thread: "ws", title: "重连线", content: "指数退避消灭了重连风暴" }] })]), model: "m" }),
    })
    await sys.triggerManual(WORKDIR)
    sys.reconcile() // 补算向量（fire-and-forget：等一拍让补算落盘）
    await new Promise((r) => setTimeout(r, 0))
    const dbPath = join(root, "memory", "projects", projectIdFor(WORKDIR), "vectors.db")
    const before = new VectorIndex(dbPath)
    const key = [...before.keys()][0]!
    expect(before.vectorOf(key)).toBeDefined() // reconcile 已补算向量
    const hits = await sys.searchEpisodes(WORKDIR, "重连风暴", 5)
    expect(hits.length).toBeGreaterThan(0)
    // 检索内部也会 reindexProject：已补算的向量不能被抹掉（否则 fusedScore 退化成纯关键词）
    const after = new VectorIndex(dbPath)
    const vec = after.vectorOf(key)
    expect(vec).toBeDefined()
    expect(Array.from(vec!)).toEqual([1, 0, 0])
  })
})

describe("searchAll", () => {
  it("searches project episodes and global cognitions with labels", async () => {
    const sys = makeSystem()
    sys.writeCognition("rule", "general", "重连改动必须带注释说明原因")
    // 布一条情节：直接走 pipeline（脚本回复 new-thread）
    const meta = sessions.create("s", undefined, WORKDIR)
    sessions.appendMessage(meta.id, { id: "m1", sessionId: meta.id, role: "user", blocks: [{ id: "b", type: "text", text: "重连风暴修好了" }], createdAt: new Date().toISOString() })
    const sysWithLlm = new MemorySystem({
      memoryDir: join(root, "memory"), sessions, config: structuredClone(defaultConfig),
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ actions: [{ file: "ws", op: "new-thread", thread: "ws", title: "重连线", content: "指数退避消灭了重连风暴" }] })]), model: "m" }),
    })
    await sysWithLlm.triggerManual(WORKDIR)
    const hits = await sysWithLlm.searchAll("重连风暴", 10)
    const episode = hits.find((h) => h.kind === "episode")
    const cognition = hits.find((h) => h.kind === "cognition")
    expect(episode?.text).toContain("指数退避")
    expect(episode?.label).toContain("经历")
    expect(cognition?.text).toContain("注释说明原因")
    expect(cognition?.scope).toBe("global")
  })
})
