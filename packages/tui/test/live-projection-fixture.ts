import type { MessagesListOutput } from "@turenlabs/client"
import { createLiveProjection, type LiveEvent } from "../src/live-projection"
import type { Session } from "../src/server"

export type Assistant = Extract<MessagesListOutput["data"][number], { type: "assistant" }>

export const session: Session = {
  id: "ses_selected",
  projectID: "project",
  title: "Synthetic",
  location: { directory: "/synthetic" },
  time: { created: 1, updated: 1 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

let sequence = 0

export function event(type: string, data: Record<string, unknown> = {}, eventID = `evt_${++sequence}`): LiveEvent {
  return {
    id: eventID,
    type: `session.next.${type}`,
    data: {
      sessionID: session.id,
      assistantMessageID: "msg_assistant",
      timestamp: 2,
      ...data,
    },
  }
}

export function assistant(text = "", kind: "text" | "reasoning" = "text"): Assistant {
  return {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { id: "test", providerID: "test" },
    time: { created: 1 },
    content: [{ id: "part", type: kind, text }],
  }
}

export function parts(projection: ReturnType<typeof createLiveProjection>) {
  const message = projection.messages().find((message) => message.type === "assistant")
  if (message?.type !== "assistant") throw new Error("Expected assistant")
  return message.content
}

export function text(projection: ReturnType<typeof createLiveProjection>) {
  const part = parts(projection)[0]
  if (!part || part.type === "tool") throw new Error("Expected text or reasoning")
  return part.text
}

export function start(projection: ReturnType<typeof createLiveProjection>, messageID = "msg_assistant") {
  return projection.apply(
    event("step.started", { assistantMessageID: messageID, agent: "build", model: { id: "test", providerID: "test" } }),
  )
}
