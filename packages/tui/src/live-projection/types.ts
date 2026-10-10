import type { MessagesListOutput } from "@turenlabs/client"
import type { Session } from "../server"

export type LiveEvent = { id: string; type: string; data: unknown; durable?: unknown }
export type Messages = MessagesListOutput["data"]
export type Assistant = Extract<Messages[number], { type: "assistant" }>
export type Part = Assistant["content"][number]
export type Tool = Extract<Part, { type: "tool" }>
export type Overlay = {
  info: Assistant
  settled: boolean
  parts: Map<string, { part: Part; ended: boolean; snapshot?: Part; changed?: boolean }>
}

/** Live overlays on top of the caller's last validated snapshot. */
export type Projection = {
  session: Session
  base: Messages
  active: Map<string, Overlay>
  seen: Set<string>
  partCount: number
}

/** Event payload after the session, message id and timestamp checks. */
export type Data = Record<string, unknown> & { assistantMessageID: string; timestamp: number }

/** A validated event's effect on one message, ready to store in its overlay. */
export type Change = { info: Assistant; settled: boolean; next?: Part; ended?: boolean; partKey?: string }

export const MAX_MESSAGES = 30
export const MAX_PARTS = 128
export const MAX_TEXT = 65_536
export const MAX_EVENTS = 4096
