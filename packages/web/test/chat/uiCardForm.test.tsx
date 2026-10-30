/**
 * UiCardForm interaction tests — draft state stays local until the one submit;
 * empty forms cannot submit; a persisted pick flips the form into its
 * read-only snapshot (values from the pick, submit gone).
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { UiCardForm, type UiCardAction } from "../../src/chat/UiCardForm.js"
import type { UIFormCard } from "@kclaw/core/protocol"

const form: UIFormCard = {
  kind: "form",
  title: "发布参数",
  fields: [
    { kind: "input", name: "version", label: "版本号", placeholder: "0.7.0" },
    { kind: "radio", name: "channel", label: "渠道", options: [{ value: "npm", label: "npm" }, { value: "github", label: "GitHub" }] },
    { kind: "checkbox", name: "opts", label: "多选", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { kind: "slider", name: "timeout", label: "超时(秒)", min: 1, max: 600, step: 1 },
  ],
}

function mount(card: UIFormCard, props: { onAction?: (a: UiCardAction) => void; picked?: UiCardAction | null } = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<UiCardForm card={card} onAction={props.onAction} picked={props.picked} />)
  })
  const q = <T extends Element>(sel: string) => Array.from(container.querySelectorAll(sel)) as T[]
  return {
    container,
    q,
    submitBtn: () => container.querySelector('button[data-testid="ui-form-submit"]') as HTMLButtonElement,
    unmount: () => act(() => root.unmount()),
  }
}

/** React-controlled inputs need the native value setter for onChange to fire. */
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

async function fillDraft(box: ReturnType<typeof mount>) {
  await act(async () => {
    setNativeValue(box.q('input[type="text"]')[0] as HTMLInputElement, "0.7.0")
    ;(box.q('input[type="radio"]')[0] as HTMLInputElement).click()
    ;(box.q('input[type="checkbox"]')[1] as HTMLInputElement).click()
    setNativeValue(box.q('input[type="range"]')[0] as HTMLInputElement, "120")
  })
}

describe("UiCardForm", () => {
  it("submits the filled draft once", async () => {
    const onAction = vi.fn()
    const box = mount(form, { onAction })
    await fillDraft(box)
    await act(async () => box.submitBtn().click())
    expect(onAction).toHaveBeenCalledWith({
      values: { version: "0.7.0", channel: "npm", opts: "B", timeout: "120" },
      text: "[表单] 发布参数\n- 版本号: 0.7.0\n- 渠道: npm\n- 多选: B\n- 超时(秒): 120",
    })
    box.unmount()
  })

  it("a form without any value cannot submit", async () => {
    const onAction = vi.fn()
    const bare: UIFormCard = { kind: "form", fields: [{ kind: "input", name: "q", label: "问题" }] }
    const box = mount(bare, { onAction })
    await act(async () => box.submitBtn().click())
    expect(onAction).not.toHaveBeenCalled()
    box.unmount()
  })

  it("a persisted pick renders the snapshot: values shown, submit gone", () => {
    const box = mount(form, {
      picked: { values: { version: "0.6.0", channel: "npm", timeout: "60" } },
    })
    expect(box.submitBtn()).toBeNull()
    expect(box.container.querySelector('[data-testid="ui-form-done"]')?.textContent).toBe("已提交")
    expect((box.q('input[type="text"]')[0] as HTMLInputElement).value).toBe("0.6.0")
    expect((box.q('input[type="radio"]')[0] as HTMLInputElement).disabled).toBe(true)
    box.unmount()
  })

  it("date and time fields render native pickers", () => {
    const box = mount({ kind: "form", fields: [{ kind: "date", name: "day", label: "日期" }, { kind: "time", name: "at", label: "时间" }] })
    expect(box.q('input[type="date"]')).toHaveLength(1)
    expect(box.q('input[type="time"]')).toHaveLength(1)
    box.unmount()
  })
})
