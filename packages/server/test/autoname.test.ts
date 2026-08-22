import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SessionStore } from "@kclaw/core"

import { defaultTitle, scheduleAutoname } from "../src/autoname.js"

// --- fixtures ---------------------------------------------------------------

/** Temp dirs to sweep in afterEach. */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempSessions(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "autoname-"))
  dirs.push(dir)
  return new SessionStore(dir)
}

describe("scheduleAutoname", () => {
  it("标题为默认值时异步生成并写回", async () => {
    const sessions = tempSessions()
    const meta = sessions.create() // 标题默认"新会话"
    await scheduleAutoname(
      { sessions, llm: {} as never, model: "m", titleFor: async () => "生成的标题" },
      meta.id, "你好",
    )
    expect(sessions.meta(meta.id)?.title).toBe("生成的标题")
  })

  it("手动改过的标题不被覆盖", async () => {
    const sessions = tempSessions()
    const meta = sessions.create("手动标题")
    await scheduleAutoname(
      { sessions, llm: {} as never, model: "m", titleFor: async () => "不该覆盖" },
      meta.id, "你好",
    )
    expect(sessions.meta(meta.id)?.title).toBe("手动标题")
  })

  it("生成标题期间用户手动改名不被覆盖", async () => {
    const sessions = tempSessions()
    const meta = sessions.create() // 标题默认"新会话"
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const pending = scheduleAutoname(
      {
        sessions,
        llm: {} as never,
        model: "m",
        titleFor: async () => {
          await gate // 挂起，模拟标题生成耗时
          return "生成的标题"
        },
      },
      meta.id, "你好",
    )
    // 生成期间用户手动改名
    sessions.updateMeta(meta.id, { title: "手动改名" })
    release()
    await pending
    expect(sessions.meta(meta.id)?.title).toBe("手动改名")
  })
})

describe("defaultTitle", () => {
  it("defaultTitle 用流拼接文本生成标题", async () => {
    const llm = { stream: async function* () { yield { type: "text_delta", delta: "你好" } } } as never
    const title = await defaultTitle(llm as never, "m", "用户消息")
    expect(title).toBe("你好")
  })
})
