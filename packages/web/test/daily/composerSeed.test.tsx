/**
 * Composer 单次预填种子（daily 展开选项）测试：draftSeed 非空写进草稿并
 * 回调 onSeedConsumed；清除后（null）不再动草稿，用户可改可发。
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Composer } from "../../src/chat/Composer.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function render(
  root: Root,
  container: HTMLElement,
  props: { draftSeed?: string | null; onSeedConsumed?: () => void },
): Promise<void> {
  await act(async () => {
    root.render(
      <Composer
        onSend={() => true}
        onHelpRequest={() => {}}
        running={false}
        {...(props.draftSeed !== undefined ? { draftSeed: props.draftSeed } : {})}
        {...(props.onSeedConsumed !== undefined ? { onSeedConsumed: props.onSeedConsumed } : {})}
      />,
    )
  })
}

function inputValue(container: HTMLElement): string {
  return (container.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement).value
}

describe("Composer draftSeed", () => {
  it("a non-empty seed fills the draft once and consumes it", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const consumed = vi.fn()
    try {
      await render(root, container, { draftSeed: "关于日报功能，我想继续聊聊。", onSeedConsumed: consumed })
      expect(inputValue(container)).toBe("关于日报功能，我想继续聊聊。")
      expect(consumed).toHaveBeenCalledTimes(1)
      // App 侧消费后置 null：草稿保持，不再被清空或覆盖
      await act(async () => {
        root.render(
          <Composer onSend={() => true} onHelpRequest={() => {}} running={false} draftSeed={null} onSeedConsumed={consumed} />,
        )
      })
      expect(inputValue(container)).toBe("关于日报功能，我想继续聊聊。")
      expect(consumed).toHaveBeenCalledTimes(1)
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("the seeded draft is editable and submittable like a typed one", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const sent: string[] = []
    try {
      await render(root, container, { draftSeed: "开场文案", onSeedConsumed: () => {} })
      const textarea = container.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!
      await act(async () => {
        setter.call(textarea, "开场文案，另外补一句")
        textarea.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await act(async () => {
        root.render(
          <Composer onSend={(t) => { sent.push(t); return true }} onHelpRequest={() => {}} running={false} />,
        )
      })
      await act(async () => {
        ;(container.querySelector('[data-testid="send-button"]') as HTMLButtonElement).click()
      })
      expect(sent).toEqual(["开场文案，另外补一句"])
      expect(inputValue(container)).toBe("") // 发送被接受 → 草稿清空
    } finally {
      root.unmount()
      container.remove()
    }
  })

  it("an empty-string seed never touches the draft", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const consumed = vi.fn()
    try {
      await render(root, container, { draftSeed: "", onSeedConsumed: consumed })
      expect(inputValue(container)).toBe("")
      expect(consumed).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      container.remove()
    }
  })
})
