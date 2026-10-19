import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTodoTools, type TodoStore } from "../../src/tools/todo.js"
import type { TodoItem } from "../../src/protocol/session-events.js"
import type { ToolExecutor } from "../../src/agent/tools.js"

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) => t.execute(args, { onOutput: () => {} })

/** In-memory TodoStore: snapshots in, last write wins, mirror of the projection. */
function memStore(): TodoStore & { items: TodoItem[] } {
  let items: TodoItem[] | undefined
  return {
    get items() { return items ?? [] },
    write(todos) { items = todos },
    read() { return items },
  }
}

describe("todo tools", () => {
  it("write replaces the whole list; read returns it", async () => {
    const t = createTodoTools({ store: memStore() })
    const r = await call(t.todo_list_write, { todos: [
      { content: "step 1", status: "completed" },
      { content: "step 2", status: "in_progress" },
      { content: "step 3", status: "pending" },
    ] })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("3 项")
    expect(r.output).toContain("[~] step 2")
    const back = await call(t.todo_list_read, {})
    expect(back.output).toContain("step 3")
    // full replacement, not a merge
    await call(t.todo_list_write, { todos: [{ content: "only", status: "pending" }] })
    expect((await call(t.todo_list_read, {})).output).not.toContain("step 2")
  })

  it("an empty array clears; read reports the empty state", async () => {
    const t = createTodoTools({ store: memStore() })
    await call(t.todo_list_write, { todos: [{ content: "x", status: "pending" }] })
    const r = await call(t.todo_list_write, { todos: [] })
    expect(r.status).toBe("ok")
    expect((await call(t.todo_list_read, {})).output).toContain("清单为空")
  })

  it("caps: 50 items / 200 chars per item / 4000 total", async () => {
    const t = createTodoTools({ store: memStore() })
    const tooMany = await call(t.todo_list_write, { todos: Array.from({ length: 51 }, () => ({ content: "x", status: "pending" })) })
    expect(tooMany.status).toBe("error")
    expect(tooMany.output).toContain("50")
    const tooLong = await call(t.todo_list_write, { todos: [{ content: "a".repeat(201), status: "pending" }] })
    expect(tooLong.status).toBe("error")
    const tooTotal = await call(t.todo_list_write, { todos: Array.from({ length: 30 }, () => ({ content: "c".repeat(150), status: "pending" })) })
    expect(tooTotal.status).toBe("error")
    expect(tooTotal.output).toContain("4000")
  })

  it("exactly one in_progress by default; the config escape relaxes it", async () => {
    const t = createTodoTools({ store: memStore() })
    const two = await call(t.todo_list_write, { todos: [
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ] })
    expect(two.status).toBe("error")
    expect(two.output).toContain("in_progress")
    const relaxed = createTodoTools({ store: memStore(), allowParallelInProgress: true })
    const ok = await call(relaxed.todo_list_write, { todos: [
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ] })
    expect(ok.status).toBe("ok")
  })

  it("validates item shape and status enum", async () => {
    const t = createTodoTools({ store: memStore() })
    expect((await call(t.todo_list_write, { todos: "nope" })).status).toBe("error")
    expect((await call(t.todo_list_write, { todos: [{ content: "", status: "pending" }] })).status).toBe("error")
    expect((await call(t.todo_list_write, { todos: [{ content: "x", status: "done" }] })).status).toBe("error")
    expect((await call(t.todo_list_write, {})).status).toBe("error")
  })

  it("risk classification: safe; write serial, read parallel", () => {
    const t = createTodoTools({ store: memStore() })
    expect(t.todo_list_write.risk).toBe("safe")
    expect(t.todo_list_write.concurrency).toBe("serial")
    expect(t.todo_list_read.risk).toBe("safe")
    expect(t.todo_list_read.concurrency).toBe("parallel")
  })
})

describe("todo persistence (event + projection)", () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "kclaw-todo-persist-")) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it("appendTodoWritten → meta projection (last write wins), survives replay", async () => {
    const { SessionStore } = await import("../../src/session/store.js")
    const { resolvePaths } = await import("../../src/storage/paths.js")
    const paths = resolvePaths(home)
    const store = new SessionStore(paths.sessionsDir)
    const id = store.create("todo 会话").id
    const tools = createTodoTools({
      store: {
        write: (todos) => store.appendTodoWritten(id, { at: new Date().toISOString(), todos }),
        read: () => store.meta(id)?.todo,
      },
    })
    await call(tools.todo_list_write, { todos: [{ content: "s1", status: "completed" }, { content: "s2", status: "in_progress" }] })
    await call(tools.todo_list_write, { todos: [{ content: "s3", status: "pending" }] })
    // projection = last snapshot
    expect(store.meta(id)?.todo).toEqual([{ content: "s3", status: "pending" }])
    // replay rebuilds the same projection
    const replayed = store.rebuildMeta(id)
    expect(replayed?.todo).toEqual([{ content: "s3", status: "pending" }])
    // reading through the tool mirrors it
    expect((await call(tools.todo_list_read, {})).output).toContain("s3")
  })
})
