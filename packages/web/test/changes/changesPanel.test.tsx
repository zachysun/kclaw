/**
 * ChangesPanel — 改动抽屉测试。照 skillsView.test.tsx 的 fake-api 模式：
 * vi.fn 的 ApiClient，get 按路径返回裸数据。覆盖胶囊显隐、抽屉展开、
 * 清单/详情两栏、当前全文三种落点（ok / 已删 404 / 二进制）、改动历史的
 * fs_edit diff 与 fs_write 折叠、工具卡跳转信号（focus）直接定位。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { ChangesPanel, type ChangesFocus } from "../../src/changes/ChangesPanel.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T1 = "2026-01-01T00:00:01.000Z"
const T2 = "2026-01-01T00:00:02.000Z"

const FILES = [
  {
    path: "/w/proj/src/b.ts", relativePath: "src/b.ts", firstAt: T2, lastAt: T2,
    ops: [{ callId: "c2", tool: "fs_write", at: T2, args: { content: "export const b = 2\n" } }],
  },
  {
    path: "/w/proj/src/a.ts", relativePath: "src/a.ts", firstAt: T1, lastAt: T1,
    ops: [{ callId: "c1", tool: "fs_edit", at: T1, args: { old: "const a = 1", new: "const a = 2" } }],
  },
]

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

function fakeApi(fileOverrides: Record<string, unknown> = {}): ApiClient & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path.startsWith(`/sessions/ses1/changes/file?`)) {
        const target = decodeURIComponent(path.split("path=")[1] ?? "")
        const override = Object.entries(fileOverrides).find(([k]) => target.includes(k))
        if (override !== undefined) {
          if (override[1] instanceof Error) throw override[1]
          return override[1]
        }
        return { content: `export const x = 1\n`, bytes: 19 }
      }
      if (path === "/sessions/ses1/changes") return { files: FILES }
      throw new Error(`unexpected ${path}`)
    }),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    upload: vi.fn(),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn> }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve))
  })
}

async function mount(props: { api: ApiClient; focus?: ChangesFocus | null }): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ChangesPanel api={props.api} sessionId="ses1" refreshTick={0} focus={props.focus ?? null} />,
    )
  })
  await flush()
  return { container, root }
}

async function unmount(h: { container: HTMLElement; root: Root }): Promise<void> {
  await act(async () => {
    h.root.unmount()
  })
  h.container.remove()
}

describe("changes chip", () => {
  it("shows the chip with the file count and opens the drawer on click", async () => {
    const api = fakeApi()
    const h = await mount({ api })
    const chip = h.container.querySelector('[data-testid="changes-chip"]')!
    expect(chip.textContent).toContain("改动 · 2")
    await act(async () => {
      ;(chip as HTMLButtonElement).click()
    })
    expect(h.container.querySelector('[data-testid="changes-drawer"]')).not.toBeNull()
    await unmount(h)
  })

  it("hides the chip entirely when the session has no change records", async () => {
    const api = fakeApi()
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/sessions/ses1/changes") return { files: [] }
      throw new Error(`unexpected ${path}`)
    })
    const h = await mount({ api })
    expect(h.container.querySelector('[data-testid="changes-chip"]')).toBeNull()
    await unmount(h)
  })

  it("stays silent (no chip) when the aggregation fetch fails", async () => {
    const api = fakeApi()
    vi.mocked(api.get).mockRejectedValue(new Error("down"))
    const h = await mount({ api })
    expect(h.container.querySelector('[data-testid="changes-chip"]')).toBeNull()
    await unmount(h)
  })
})

describe("changes drawer", () => {
  it("lists files by relative path with op counts and shows the empty-detail hint", async () => {
    const api = fakeApi()
    const h = await mount({ api })
    await act(async () => {
      ;(h.container.querySelector('[data-testid="changes-chip"]') as HTMLButtonElement).click()
    })
    const items = [...h.container.querySelectorAll(".changes-item")]
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain("src/b.ts")
    expect(items[0]!.textContent).toContain("1 次")
    expect(items[1]!.textContent).toContain("src/a.ts")
    expect(h.container.querySelector(".changes-empty")!.textContent).toContain("选择一个文件")
    await unmount(h)
  })

  it("defaults to the current-content tab and renders the code view", async () => {
    const api = fakeApi({ "src/a.ts": { content: "export const a = 2\n", bytes: 19 } })
    const h = await mount({ api })
    await act(async () => {
      ;(h.container.querySelector('[data-testid="changes-chip"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-item")[1] as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector(".changes-tabs .on")!.textContent).toBe("当前全文")
    expect(h.container.querySelector('[data-testid="changes-content"]')!.textContent).toContain("export const a = 2")
    await unmount(h)
  })

  it("shows the gone-from-disk hint on 404", async () => {
    const api = fakeApi({ "src/a.ts": statusError(404, "file no longer on disk") })
    const h = await mount({ api })
    await act(async () => {
      ;(h.container.querySelector('[data-testid="changes-chip"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-item")[1] as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector('[data-testid="changes-content"]')!.textContent).toContain("文件已不在磁盘上")
    await unmount(h)
  })

  it("flags binary content without rendering it", async () => {
    const api = fakeApi({ "src/a.ts": { binary: true, bytes: 4 } })
    const h = await mount({ api })
    await act(async () => {
      ;(h.container.querySelector('[data-testid="changes-chip"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-item")[1] as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector('[data-testid="changes-content"]')!.textContent).toContain("二进制文件")
    expect(h.container.querySelector(".codeview")).toBeNull()
    await unmount(h)
  })

  it("shows the over-cap hint on 413", async () => {
    const api = fakeApi({ "src/a.ts": statusError(413, "file too large") })
    const h = await mount({ api })
    await act(async () => {
      ;(h.container.querySelector('[data-testid="changes-chip"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-item")[1] as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector('[data-testid="changes-content"]')!.textContent).toContain("超过 1 MiB")
    await unmount(h)
  })

  it("history tab renders fs_edit diffs and a collapsed fs_write entry", async () => {
    const api = fakeApi()
    const h = await mount({ api })
    await act(async () => {
      ;(h.container.querySelector('[data-testid="changes-chip"]') as HTMLButtonElement).click()
    })
    // a.ts（fs_edit）
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-item")[1] as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-tabs button")[1] as HTMLButtonElement).click()
    })
    const history = h.container.querySelector('[data-testid="changes-history"]')!
    expect(history.querySelectorAll(".diff-del")).toHaveLength(1)
    expect(history.querySelectorAll(".diff-add")).toHaveLength(1)
    expect(history.textContent).toContain("✎ fs_edit")
    // b.ts（fs_write 折叠条 + 无 diff 行；点条目会回到当前全文，再切历史）
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-item")[0] as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(h.container.querySelectorAll(".changes-tabs button")[1] as HTMLButtonElement).click()
    })
    const historyB = h.container.querySelector('[data-testid="changes-history"]')!
    expect(historyB.querySelector(".diff-del")).toBeNull()
    expect(historyB.querySelector("summary")!.textContent).toContain("写入")
    await unmount(h)
  })
})

describe("changes focus signal", () => {
  it("opens the drawer straight onto the focused file's current content", async () => {
    const api = fakeApi({ "src/a.ts": { content: "export const a = 2\n", bytes: 19 } })
    const h = await mount({ api, focus: { path: "/w/proj/src/a.ts", seq: 1 } })
    await flush()
    expect(h.container.querySelector('[data-testid="changes-drawer"]')).not.toBeNull()
    expect(h.container.querySelector(".changes-item.on")!.textContent).toContain("src/a.ts")
    expect(h.container.querySelector('[data-testid="changes-content"]')!.textContent).toContain("export const a = 2")
    await unmount(h)
  })
})
