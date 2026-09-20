/**
 * The ONE new seam of the Feishu channel (#45): everything that touches the
 * Feishu SDK — connecting, receiving messages and card actions, sending and
 * updating cards, streaming — goes through this interface. All channel logic
 * (commands, allowlist, card state machine, stripping) is tested against a
 * fake transport; the real transport (real-transport.ts) is a thin SDK shell
 * with no logic of its own.
 */

/** Semantic card descriptors produced by the channel; the transport maps them to real Feishu cards. */
export type OutboundCard =
  | { kind: "help" }
  | { kind: "thinking"; sessionTitle: string }
  | { kind: "complete"; markdown: string }
  | { kind: "summary"; title: string; body: string }
  | { kind: "approval"; confirmationId: string; toolName: string; argsPreview: string; risk: "safe" | "sensitive"; noteText?: string }
  | { kind: "approval-settled"; confirmationId: string; outcome: "approved" | "rejected" | "invalid" }

/** A text message from a Feishu user (DM). */
export interface InboundMessage {
  openId: string
  /** Feishu message id — used for the Typing reaction receipt. */
  messageId: string
  text: string
}

/** A card button press (Confirm/Reject). `value` is the channel's action string. */
export interface CardAction {
  openId: string
  value: string
}

export interface TransportHandlers {
  onMessage: (m: InboundMessage) => void
  onCardAction: (a: CardAction) => void
}

/**
 * Lifecycle: start() connects and begins delivering inbound events; stop()
 * disconnects. Every outbound call is idempotent-ish and may throw — the
 * channel catches and degrades (a failed card must never kill a run).
 *
 * Delivery contract: implementations MUST hand EVERY direct message to
 * onMessage — no transport-side allowlist filtering. The channel enforces
 * the allowlist itself so rejected senders get recorded for the admin
 * page's one-click allowlisting; the real transport runs the SDK with
 * dmMode "open" for exactly this reason (see real-transport.ts).
 */
export interface FeishuTransport {
  start(handlers: TransportHandlers): Promise<void>
  stop(): Promise<void>
  /** Emoji receipt on an inbound message (processing acknowledgment). */
  reactTyping(messageId: string): Promise<void>
  /** Plain text reply (command receipts). */
  replyText(openId: string, text: string): Promise<void>
  /** Send a card; resolves to the transport's card/message id. */
  sendCard(openId: string, card: OutboundCard): Promise<string>
  /** Replace a previously sent card's content (card states are updated in place). */
  updateCard(cardId: string, card: OutboundCard): Promise<void>
  /** Create a streaming card showing `initial`; resolves to the card id. */
  startStream(openId: string, initial: string): Promise<string>
  /** Append a text delta to the streaming card. */
  appendStream(cardId: string, text: string): Promise<void>
  /** Seal the streaming card with the final markdown (streaming off). */
  finishStream(cardId: string, markdown: string): Promise<void>
}
