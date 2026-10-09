import type { MessagesListOutput } from "@turenlabs/client"
import { display } from "../messages"
import { codeSpan, literal } from "./literal"

type Shell = Extract<MessagesListOutput["data"][number], { type: "shell" }>

/** "completed", "failed · exit 1": a zero exit stays completed, any other code reads as failed. */
function shellStatus(message: Shell) {
  // The status is one of the fixed words the response validation allows.
  const status = display(message.status ?? "running", 32)
  if (message.exitCode === undefined || message.exitCode === 0 || status === "running") return status
  return `${status === "completed" ? "failed" : status} · exit ${message.exitCode}`
}

/**
 * `rich` is the dashboard's Markdown view: the command and output are shown literally there, and untouched otherwise.
 * A long output is folded there like a tool result until `expanded` (Ctrl+O).
 */
export function shellBlock(message: Shell, rich = false, expanded = false) {
  const output = display(message.output)
  const finished = message.status !== undefined && message.status !== "running"
  const status = `[${shellStatus(message)}] $`
  if (!rich)
    return [
      `${status} ${display(message.command)}`,
      output.trim() || (finished ? "(no output)" : ""),
      ...(message.error ? [display(message.error, 1000)] : []),
    ]
      .filter(Boolean)
      .join("\n")
  return [
    shellCommand(status, message.command),
    output.trim() ? literal(message.output, 16000, { rich, expanded }) : finished ? "(no output)" : "",
    ...(message.error ? [literal(message.error, 1000)] : []),
  ]
    .filter(Boolean)
    .join("\n")
}

/** The status and command on one line when the command is one line; a multi-line command sits in a block below it. */
function shellCommand(status: string, command: string) {
  const text = display(command).trim()
  if (!text) return status
  if (!text.includes("\n")) return `${status} ${codeSpan(text)}`
  return `${status}\n${literal(command)}`
}

/** The one-line status for a finished shell command, or undefined while it is running or unknown. */
export function shellOutcome(message: Shell) {
  const failed = message.status === "failed" || (message.status === "completed" && !!message.exitCode)
  if (!failed) return undefined
  return `Shell command failed${message.exitCode ? ` (exit ${message.exitCode})` : ""}. Open history for details.`
}
