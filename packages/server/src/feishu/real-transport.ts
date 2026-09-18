/**
 * The real transport: a thin shell over the SDK's LarkChannel facade
 * (websocket transport, built-in reconnect, DM allowlist policy, throttled
 * markdown streaming). No logic lives here — every decision belongs to the
 * channel behind the FeishuTransport seam; this file only translates our
 * semantic card descriptors into Feishu card JSON and bridges the SDK's
 * producer-style streaming onto the seam's start/append/finish calls.
 */
import { LoggerLevel } from "@larksuiteoapi/node-sdk"
import type { createLarkChannel as CreateLarkChannel, LarkChannel as SdkChannel } from "@larksuiteoapi/node-sdk"
import type { FeishuConfig } from "./config.js"
import type { FeishuTransport, OutboundCard, TransportHandlers } from "./transport.js"

type CreateLarkChannelFn = typeof CreateLarkChannel

/** Feishu interactive card (stable v1 shape) carrying our markdown content. */
function buildCard(card: OutboundCard): object {
  const md = (content: string) => ({ tag: "markdown", content })
  const header = (title: string, template: string) => ({
    title: { tag: "plain_text", content: title },
    ...(template !== "" ? { template } : {}),
  })
  switch (card.kind) {
    case "help":
      return {
        config: { update_multi: true },
        header: header("kclaw 命令", "blue"),
        elements: [
          md(
            [
              "**/new** — 开启新会话（旧会话保留可查）",
              "**/stop** — 停止当前回复并清空排队消息",
              "**/help** — 显示本卡片",
              "",
              "其他任何文字都会作为消息发给 kclaw；回复进行中再发消息会自动排队。",
            ].join("\n"),
          ),
        ],
      }
    case "thinking":
      return {
        config: { update_multi: true },
        header: header("思考中…", "blue"),
        elements: [md(card.sessionTitle)],
      }
    case "complete":
      return {
        config: { update_multi: true },
        header: header("回复", "green"),
        elements: [md(card.markdown === "" ? "（空回复）" : card.markdown)],
      }
    case "summary":
      return {
        config: { update_multi: true },
        header: header(card.title, "blue"),
        elements: [md(card.body === "" ? "（无详情）" : card.body)],
      }
    case "approval":
      return {
        config: { update_multi: true },
        header: header(`需要批准：${card.toolName}`, "orange"),
        elements: [
          md(`**工具**：${card.toolName}\n**参数**：\n\`\`\`\n${card.argsPreview}\n\`\`\`${card.noteText !== undefined ? `\n${card.noteText}` : ""}`),
          {
            tag: "action",
            actions: [
              { tag: "button", text: { tag: "plain_text", content: "批准（仅本次）" }, style: "primary", value: `confirm:${card.confirmationId}` },
              { tag: "button", text: { tag: "plain_text", content: "拒绝" }, value: `reject:${card.confirmationId}` },
            ],
          },
        ],
      }
    case "approval-settled": {
      const label = card.outcome === "approved" ? "已批准" : card.outcome === "rejected" ? "已拒绝" : "已失效（在别处处理或超时）"
      return {
        config: { update_multi: true },
        header: header(`确认卡：${label}`, card.outcome === "approved" ? "green" : "grey"),
        elements: [md(`confirmationId: ${card.confirmationId}`)],
      }
    }
  }
}

/** Streaming plumbing: one in-memory chunk queue per streaming card. */
interface StreamPipe {
  queue: string[]
  wake: (() => void) | undefined
  eof: boolean
  final: string | undefined
}

export function createRealFeishuTransport(
  config: FeishuConfig,
  log: (line: string) => void = (line) => console.error(`kclaw feishu: ${line}`),
): FeishuTransport {
  let channel: SdkChannel | undefined
  let createChannel: CreateLarkChannelFn | undefined
  const streams = new Map<string, StreamPipe>()
  let nextStreamId = 0

  const settle = (p: Promise<unknown>, what: string): void => {
    void p.catch((err: unknown) => {
      log(`${what} 失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  return {
    async start(handlers: TransportHandlers): Promise<void> {
      if (createChannel === undefined) {
        // 动态加载：未启用飞书的 daemon 不为这个 SDK 付任何启动成本
        ({ createLarkChannel: createChannel } = await import("@larksuiteoapi/node-sdk"))
      }
      channel = createChannel({
        appId: config.appId,
        appSecret: config.appSecret,
        transport: "websocket",
        // 白名单第二道防线（第一道在频道逻辑里，可在假传输上测试）
        policy: { dmMode: "allowlist", dmAllowlist: config.allowlist },
        loggerLevel: LoggerLevel.error,
      })
      channel.on({
        message: (msg) => {
          if (msg.chatType !== "p2p") return
          handlers.onMessage({ openId: msg.senderId, messageId: msg.messageId, text: msg.content })
        },
        cardAction: (evt) => {
          const value = typeof evt.action.value === "string" ? evt.action.value : ""
          if (value === "") return
          handlers.onCardAction({ openId: evt.operator.openId, value })
        },
      })
      await channel.connect()
    },

    async stop(): Promise<void> {
      await channel?.disconnect()
      channel = undefined
    },

    async reactTyping(messageId: string): Promise<void> {
      settle(channel!.addReaction(messageId, "Typing"), "表情回执")
    },

    async replyText(openId: string, text: string): Promise<void> {
      await channel!.send(openId, { text })
    },

    async sendCard(openId: string, card: OutboundCard): Promise<string> {
      const result = await channel!.send(openId, { card: buildCard(card) })
      return result.messageId
    },

    async updateCard(cardId: string, card: OutboundCard): Promise<void> {
      await channel!.updateCard(cardId, buildCard(card))
    },

    async startStream(openId: string, _initial: string): Promise<string> {
      if (channel === undefined) throw new Error("feishu transport not started")
      const id = `stream_${++nextStreamId}`
      const pipe: StreamPipe = { queue: [], wake: undefined, eof: false, final: undefined }
      streams.set(id, pipe)
      const waitForChunk = (): Promise<void> =>
        pipe.queue.length > 0 || pipe.eof
          ? Promise.resolve()
          : new Promise<void>((resolve) => { pipe.wake = resolve })
      settle(
        channel.stream(openId, {
          markdown: async (controller) => {
            for (;;) {
              await waitForChunk()
              while (pipe.queue.length > 0) {
                await controller.append(pipe.queue.shift()!)
              }
              if (pipe.eof) {
                if (pipe.final !== undefined) await controller.setContent(pipe.final)
                streams.delete(id)
                return
              }
            }
          },
        }).then((result) => { void result }).catch((err: unknown) => {
          streams.delete(id)
          throw err
        }),
        "流式卡片",
      )
      return id
    },

    async appendStream(cardId: string, text: string): Promise<void> {
      const pipe = streams.get(cardId)
      if (pipe === undefined) return
      pipe.queue.push(text)
      pipe.wake?.()
      pipe.wake = undefined
    },

    async finishStream(cardId: string, markdown: string): Promise<void> {
      const pipe = streams.get(cardId)
      if (pipe === undefined) return
      pipe.final = markdown
      pipe.eof = true
      pipe.wake?.()
      pipe.wake = undefined
    },
  }
}
