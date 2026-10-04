import type { MessagesListOutput } from "@turenlabs/client"
import { display } from "../messages"

type Shell = Extract<MessagesListOutput["data"][number], { type: "shell" }>

/** "completed", "failed · exit 1": a zero exit stays completed, any other code reads as failed. */
function shellStatus(message: Shell) {
  const status = display(message.status ?? "running", 32)
  if (message.exitCode === undefined || message.exitCode === 0 || status === "running") return status
  return `${status === "completed" ? "failed" : status} · exit ${message.exitCode}`
}

export function shellBlock(message: Shell) {
  const output = display(message.output)
  const finished = message.status !== undefined && message.status !== "running"
  return [
    `[${shellStatus(message)}] $ ${display(message.command)}`,
    output.trim() || (finished ? "(no output)" : ""),
    ...(message.error ? [display(message.error, 1000)] : []),
  ]
    .filter(Boolean)
    .join("\n")
}

/** The one-line status for a finished shell command, or undefined while it is running or unknown. */
export function shellOutcome(message: Shell) {
  const failed = message.status === "failed" || (message.status === "completed" && !!message.exitCode)
  if (!failed) return undefined
  return `Shell command failed${message.exitCode ? ` (exit ${message.exitCode})` : ""}. Open history for details.`
}
