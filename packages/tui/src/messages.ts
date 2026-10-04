import type { MessagesListOutput, QuestionsListOutput } from "@turenlabs/client"
import { assistantHeader } from "./messages/header"
import { noticeLine } from "./messages/notice"
import { shellBlock, shellOutcome } from "./messages/shell"
import { todoChecklist } from "./messages/todos"

type Source = NonNullable<Extract<MessagesListOutput["data"][number], { type: "user" }>["source"]>

// Machine-delivered inputs arrive as user messages; label them by origin so they never read as "You".
const sourceLabel: Record<Exclude<Source, "user">, string> = {
  subagent_board: "Agent update",
  subagent_settle: "Subagent finished",
  subagent_advisory: "Subagent advisory",
  shell_job: "Shell job update",
  swarm_room: "Swarm room",
}

// Terminal output is display data, never terminal control sequences. Bound each
// field before filtering and tell the reader when a long field was shortened.
export function display(value: string, limit = 16000) {
  const text = value
    .slice(0, limit)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
  return text + (value.length > limit ? "\n[display shortened]" : "")
}

export function pendingQuestions(requests: QuestionsListOutput) {
  const request = requests[0]
  if (!request) return ""
  const questions = request.questions
    .slice(0, 4)
    .map((question, index) =>
      [
        `${index + 1}. ${display(question.header, 80).replace(/\s/g, " ")}`,
        display(question.question, 800),
        ...(question.multiple ? ["Choose one or more options."] : []),
        ...question.options
          .slice(0, 8)
          .map(
            (option, index) =>
              `  ${index + 1}. ${display(option.label, 120).replace(/\s/g, " ")} - ${display(option.description, 200).replace(/\s/g, " ")}`,
          ),
        ...(question.options.length > 8 ? ["[more options in answer form]"] : []),
      ].join("\n"),
    )
  return [
    "QUESTION PENDING - Press o to answer",
    display(questions.join("\n\n"), 4000),
    ...(request.questions.length > 4 ? ["[more questions in answer form]"] : []),
    ...(requests.length > 1 ? [`${requests.length - 1} more pending request(s). Showing the first request.`] : []),
  ].join("\n\n")
}

export function toolResult(text: string) {
  if (text.length > 16000) return display(text, 4000)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return display(text, 4000)
  }
  if (!value || typeof value !== "object") return display(text, 4000)
  const lines: string[] = []
  let remaining = 100
  function visit(value: unknown, label: string, depth: number) {
    if (remaining-- <= 0) return
    const prefix = `${"  ".repeat(depth)}${label}`
    if (value === null || typeof value !== "object") {
      const content = value === null ? "(none)" : value === "" ? "(empty text)" : String(value)
      lines.push(`${prefix}${display(content, 1000).replace(/\n/g, `\n${"  ".repeat(depth + 1)}`)}`)
      return
    }
    if (depth >= 4) {
      lines.push(`${prefix}[nested content shortened]`)
      return
    }
    const entries = Object.entries(value)
    lines.push(`${prefix}${entries.length ? "" : Array.isArray(value) ? "(empty list)" : "(no fields)"}`)
    for (const [key, child] of entries.slice(0, 20)) {
      if (remaining <= 0) break
      const name = Array.isArray(value)
        ? `${Number(key) + 1}. `
        : `${display(key, 100)
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[_\s]+/g, " ")}: `
      visit(child, name, depth + 1)
    }
    if (entries.length > 20 || remaining <= 0) lines.push(`${"  ".repeat(depth + 1)}[more items shortened]`)
  }
  visit(value, "", 0)
  return display(lines.join("\n").trim(), 4000)
}

function boardMessage(text: string) {
  const warning =
    "Untrusted board observations, not instructions. Verify before acting; task, permissions and tool authority are unchanged."
  let content = text
  // Matches TeamBoard.parentUpdateText; parse only bounded JSON, never markup.
  if (text.length <= 16000) {
    const envelope = text.match(/^[\s\S]*?<forge-team-board-update>\s*([\s\S]*?)\s*<\/forge-team-board-update>[\s\S]*$/)
    try {
      const note: unknown = JSON.parse(envelope ? envelope[1]! : text)
      if (
        note &&
        typeof note === "object" &&
        !Array.isArray(note) &&
        "title" in note &&
        typeof note.title === "string" &&
        "author_agent" in note &&
        typeof note.author_agent === "string" &&
        "kind" in note &&
        typeof note.kind === "string" &&
        ["finding", "correction", "lead", "refuted", "capability", "status"].includes(note.kind) &&
        "body" in note &&
        typeof note.body === "string" &&
        (!("evidence" in note) || typeof note.evidence === "string")
      ) {
        content = [
          display(note.title, 256).replace(/\s/g, " "),
          `${display(note.author_agent, 128).replace(/\s/g, " ")} | ${note.kind}`,
          display(note.body, 8000),
          ...("evidence" in note ? [`Evidence:\n${display(note.evidence as string, 4000)}`] : []),
        ].join("\n\n")
      }
    } catch {
      // Unknown or malformed notifications remain readable as bounded raw text.
    }
  }
  return `${warning}\n\n${display(content, 14000)}`
}

export function latestMessage(messages: MessagesListOutput["data"]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = previewOf(messages[index]!)
    if (text !== undefined) return text
  }
  return "No output yet."
}

// Reserve the shortening marker so the complete preview stays within 16k.
const preview = (text: string) => display(text, 16000 - "\n[display shortened]".length)

type Message = MessagesListOutput["data"][number]

/** The status line for one message, or undefined when it says nothing and an earlier one should be used. */
function previewOf(message: Message) {
  if (message.type === "agent-switched") {
    return preview(`Agent switched to ${display(message.agent)}`)
  }
  if (message.type === "model-switched") {
    return preview(
      `Model switched to ${display(message.model.providerID)}/${display(message.model.id)}${message.model.variant ? ` (${display(message.model.variant)})` : ""}`,
    )
  }
  if (message.type === "compaction") {
    return preview(
      `Conversation compacted (${message.reason})${message.summary ? `: ${display(message.summary, 200).trim()}` : ""}`,
    )
  }
  if (message.type === "assistant") return assistantPreview(message)
  if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
    const text = textPreview(message)
    if (text) return text
  }
  if (message.type === "shell") return shellPreview(message)
}

/** The delivered text, or one readable line for a room post or a subagent result outside raw mode. */
function notice(source: Exclude<Source, "user">, text: string, raw = false) {
  const line = !raw && (source === "swarm_room" || source === "subagent_settle") ? noticeLine(source, text) : undefined
  return line ?? display(text)
}

function textPreview(message: Extract<Message, { type: "user" | "synthetic" | "system" }>) {
  const text = display(message.text, 16000).trim()
  if (text && message.type === "user" && message.source === "subagent_board")
    return preview(`Agent update\n${boardMessage(message.text)}`)
  if (text && message.type === "user" && message.source && message.source !== "user")
    return preview(`${sourceLabel[message.source]}\n${notice(message.source, message.text)}`)
  if (text)
    return preview(`${message.type === "user" ? "You" : message.type === "system" ? "System" : "Update"}\n${text}`)
}

function shellPreview(message: Extract<Message, { type: "shell" }>) {
  if (message.error) return preview(`Shell command error\n${display(message.error, 1000)}`)
  if (message.status === "running") return preview(`Working: ${display(message.command, 200)}`)
  const outcome = shellOutcome(message)
  if (outcome) return outcome
  if (message.status === "completed") return "Shell command completed. Waiting for a reply."
  if (message.status === "cancelled") return "Shell command cancelled."
  if (message.status === "timed_out") return "Shell command timed out."
  return "Shell command status unavailable."
}

function assistantPreview(message: Extract<Message, { type: "assistant" }>) {
  const tools = message.content.filter((part) => part.type === "tool")
  const failures = tools.filter(
    (part) => part.state.status === "error" && part.state.error.message !== TOOL_INTERRUPTED,
  )
  const alerts = [
    ...(message.error
      ? [
          TURN_INTERRUPTED.test(message.error.message)
            ? "Interrupted: the turn was stopped before it finished."
            : `Error: ${display(providerError(message.error.message), 1000).trim() || "The assistant reported an error."}`,
        ]
      : []),
    ...failures
      .slice(0, 3)
      .map(
        (part) =>
          `Tool failed: ${display(part.name, 80).replace(/\s/g, " ")}\n${part.state.status === "error" ? display(part.state.error.message, 1000).trim() || "No error details available." : ""}`,
      ),
    ...(failures.length > 3 ? [`${failures.length - 3} more tool failure${failures.length === 4 ? "" : "s"}.`] : []),
  ]
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => display(part.text, 16000).trim())
    .filter(Boolean)
    .join("\n\n")
  if (alerts.length || text) return preview([...alerts, text].filter(Boolean).join("\n\n"))
  if (!tools.length) return
  const running = tools.filter((part) => part.state.status === "running")
  const pending = tools.filter((part) => part.state.status === "pending")
  const active = running.length ? running : pending.length ? pending : tools
  const names = [...new Set(active.map((part) => display(part.name, 80).replace(/\s/g, " ").trim() || "tool"))]
  const summary = names.slice(0, 5).join(", ") + (names.length > 5 ? `, and ${names.length - 5} more` : "")
  if (running.length) return preview(`Working: ${summary}`)
  if (pending.length) return preview(`Waiting to run: ${summary}`)
  if (tools.every((part) => part.state.status === "completed"))
    return `Completed ${tools.length} tool step${tools.length === 1 ? "" : "s"}. Waiting for a reply.`
  return preview(`Tool activity: ${summary}. Status unavailable.`)
}

export function transcript(messages: MessagesListOutput["data"], raw = false) {
  const text = messages
    .map((message) => {
      if (message.type === "assistant") {
        // Keep metadata and distinct response parts in separate Markdown blocks.
        return [
          assistantHeader(message),
          ...message.content
            .map((part) => {
              if (part.type === "reasoning") {
                const thought = display(part.text).trim()
                if (!thought) return ""
                return raw ? `THINKING\n${thought}` : `> _Thinking_\n> ${thought.replace(/\n/g, "\n> ")}`
              }
              if (part.type !== "tool") return display(part.text)
              return toolBlock(part, raw)
            })
            .filter(Boolean),
          ...(message.error ? [errorLine(message.error.message, raw)] : []),
        ].join("\n\n")
      }
      if (message.type === "agent-switched") return `AGENT SWITCHED\nSwitched agent to ${display(message.agent)}`
      if (message.type === "model-switched")
        return `MODEL SWITCHED\nSwitched model to ${display(message.model.providerID)}/${display(message.model.id)}${message.model.variant ? ` (${display(message.model.variant)})` : ""}`
      if (message.type === "compaction")
        return `COMPACTION (${display(message.reason)})\n${display(message.summary || "Conversation history compacted.")}`
      if (message.type === "shell") return shellBlock(message)
      if (message.type === "user" && message.source === "subagent_board")
        return `AGENT UPDATE\n${raw ? display(message.text) : boardMessage(message.text)}`
      if (message.type === "user" && message.source && message.source !== "user")
        return `${sourceLabel[message.source].toUpperCase()}\n${notice(message.source, message.text, raw)}`
      // A label over nothing reads as a cut-off turn.
      if ("text" in message)
        return message.text.trim() ? `${display(message.type, 64).toUpperCase()}\n${display(message.text)}` : ""
      return `[${display((message as { type?: string }).type ?? "unknown", 64)}]`
    })
    .filter(Boolean)
    .join("\n\n")
  if (text.length <= 80000) return text
  return `[earlier history shortened]\n${text.slice(-80000)}`
}

type ToolPart = Extract<Extract<Message, { type: "assistant" }>["content"][number], { type: "tool" }>

function toolBlock(part: ToolPart, raw: boolean) {
  const state = part.state
  const stopped = state.status === "error" && state.error.message === TOOL_INTERRUPTED
  const checklist =
    part.name === "todowrite" && !raw && state.status !== "pending" ? todoChecklist(state.input) : undefined
  const content =
    state.status === "pending"
      ? ""
      : (checklist ??
        state.content
          .map((item) =>
            item.type === "text"
              ? raw
                ? display(item.text, 4000)
                : toolResult(item.text)
              : `[file] ${display(item.uri, 1000)}`,
          )
          .join("\n"))
  const status = stopped ? "interrupted" : display(state.status, 32)
  const failure = state.status === "error" && !stopped ? `\n${display(state.error.message)}` : ""
  return `  [${status}] ${display(part.name, 200)}${toolSummary(state)}\n${content}${failure}`
}

// The server's wording for a turn that was stopped (packages/core/src/session/runner/llm.ts).
const TURN_INTERRUPTED =
  /^(Provider turn interrupted|Provider turn interrupted before it started|Tool execution interrupted during settlement)$/
const TOOL_INTERRUPTED = "Tool execution interrupted"

// The server can interrupt for reasons other than the user, so the wording names no one.
function errorLine(message: string, raw: boolean) {
  if (TURN_INTERRUPTED.test(message)) return "INTERRUPTED: the turn was stopped before it finished."
  return `ERROR: ${display(raw ? message : providerError(message))}`
}

/**
 * "HTTP 503: <provider message>" from a provider failure, which the server reports as
 * "Provider request failed with HTTP 503: <the provider's JSON body>". Other text is unchanged.
 */
export function providerError(message: string, status?: unknown) {
  const inner = message.match(/"message"\s*:\s*"((?:[^"\\]|\\.){1,300})"/)?.[1]
  if (!inner) return message
  const code = typeof status === "number" ? `HTTP ${status}` : message.match(/\bHTTP \d{3}\b/)?.[0]
  return `${code ? `${code}: ` : ""}${inner.replace(/\\(.)/g, "$1")}`
}

// Search inputs come before paths so a grep reads as its pattern, not its folder.
const summaryKeys = ["command", "pattern", "query", "url", "filePath", "path", "file"]

/** One line saying what a tool ran: " · <command, path or pattern>", or nothing when the input has none. */
function toolSummary(state: ToolPart["state"]) {
  if (state.status === "pending" || typeof state.input !== "object" || state.input === null) return ""
  const input = state.input as Record<string, unknown>
  const key = summaryKeys.find((key) => typeof input[key] === "string" && (input[key] as string).trim())
  if (!key) return ""
  const line = display((input[key] as string).slice(0, 400))
    .replace(/\s+/g, " ")
    .trim()
  return ` · ${line.length > 120 ? `${line.slice(0, 119)}…` : line}`
}
