import type { MessagesListOutput } from "@turenlabs/client"
import { display } from "../messages"

type Assistant = Extract<MessagesListOutput["data"][number], { type: "assistant" }>

/** "build · sandbox/scripted (fast) · 12s": the agent, the model when known, and how long the turn took. */
export function assistantHeader(message: Assistant, rich = false) {
  const model = message.model
  const known = model.providerID !== "unknown" || model.id !== "unknown"
  const agent = display(message.agent, 256)
  return [
    rich ? chip(agent) : agent,
    ...(known
      ? [
          `${display(model.providerID, 256)}/${display(model.id, 512)}${model.variant ? ` (${display(model.variant, 256)})` : ""}`,
        ]
      : []),
    ...duration(message.time),
  ].join(" · ")
}

/** Whole seconds between creation and completion; nothing when a timestamp is missing or implausible. */
function duration(time: Assistant["time"]) {
  if (typeof time.completed !== "number" || typeof time.created !== "number") return []
  const seconds = Math.round((time.completed - time.created) / 1000)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) return []
  if (seconds < 60) return [`${seconds}s`]
  if (seconds < 3600) return [`${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`]
  return [`${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`]
}

/** A label as a Markdown code span, which the dashboard draws as an accent chip; plain text keeps the words. */
export function chip(text: string) {
  return text && !text.includes("`") ? `\`${text}\`` : text
}
