import {
  array,
  choice,
  clip,
  identifier,
  invalid,
  isRecord,
  location,
  modelRef,
  name,
  numeric,
  object,
  optional,
  owner,
  sources,
  string,
  unique,
} from "./primitives"

export const shellStatuses = ["running", "completed", "cancelled", "timed_out", "failed"]

export function session(value: unknown, expectedID?: string) {
  const item = object(value)
  const id = identifier(item.id, "ses_")
  if (expectedID !== undefined && id !== expectedID) invalid("session identity")
  optional(item.parentID, (value) => identifier(value, "ses_"))
  string(item.title, 64000)
  location(item.location)
  const time = object(item.time)
  numeric(time.created)
  numeric(time.updated)
  if (Object.hasOwn(time, "archived")) numeric(time.archived)
  optional(item.agent, name)
  optional(item.model, modelRef)
  optional(item.revert, (value) => revert(value))
}

export function revert(value: unknown, expectedMessageID?: string) {
  const item = object(value)
  const messageID = identifier(item.messageID, "msg_")
  if (expectedMessageID !== undefined && messageID !== expectedMessageID) invalid("revert message identity")
  optional(item.partID, identifier)
  optional(item.snapshot, (value) => string(value, 4096))
  optional(item.diff, (value) => string(value, 8 * 1024 * 1024))
  optional(item.files, (value) => {
    for (const entry of array(value, 2048)) {
      const file = object(entry)
      string(file.path, 4096)
      choice(file.status, ["added", "modified", "deleted"])
      for (const key of ["additions", "deletions"])
        if (!Number.isSafeInteger(numeric(file[key])) || Number(file[key]) < 0) invalid("revert line count")
      string(file.patch, 8 * 1024 * 1024)
    }
  })
}

export function cursor(value: unknown) {
  const item = object(value)
  optional(item.next, (value) => string(value, 4096))
  optional(item.previous, (value) => string(value, 4096))
}

export function task(value: unknown) {
  const item = object(value)
  identifier(item.id, "tsk_")
  for (const key of ["rootSessionID", "parentSessionID", "childSessionID"]) identifier(item[key], "ses_")
  name(item.agent)
  string(item.description)
  optional(item.error, string)
  choice(item.status, ["queued", "starting", "running", "completed", "failed", "cancelled", "interrupted"])
}

export function message(value: unknown, sessionID: string) {
  const item = object(value)
  identifier(item.id, "msg_")
  optional(item.sessionID, (value) => owner(value, sessionID))
  numeric(object(item.time).created)
  choice(item.type, [
    "user",
    "synthetic",
    "system",
    "assistant",
    "shell",
    "agent-switched",
    "model-switched",
    "compaction",
  ])
  if (item.type === "user" || item.type === "synthetic" || item.type === "system") clip(item, "text")
  if (item.type === "user" && item.source !== undefined && !sources.includes(item.source as string))
    invalid("message source")
  if (item.type === "agent-switched") name(item.agent)
  if (item.type === "model-switched") modelRef(item.model)
  if (item.type === "shell") {
    clip(item, "command")
    clip(item, "output")
    optional(item.error, () => clip(item, "error"))
    optional(item.status, (value) => choice(value, shellStatuses))
  }
  if (item.type === "assistant") assistantMessage(item)
}

function assistantMessage(item: Record<string, unknown>) {
  name(item.agent)
  modelRef(item.model)
  optional(item.error, (value) => clip(object(value), "message"))
  // The context meter adds these up.
  optional(item.tokens, (value) => {
    const tokens = object(value)
    for (const count of [
      tokens.input,
      tokens.output,
      tokens.reasoning,
      object(tokens.cache).read,
      object(tokens.cache).write,
    ])
      if (numeric(count) < 0) invalid("token count")
  })
  // The Changes view lists the files a turn touched.
  optional(item.snapshot, (value) =>
    optional(object(value).files, (files) => array(files, 5000).forEach((file) => string(file, 4096))),
  )
  item.content = omit(array(item.content, Infinity), 128, (count) => ({
    id: "omitted_parts",
    type: "text",
    text: `[${count} parts omitted]`,
  }))
  unique(item.content as unknown[], contentPart)
}

/** Keeps the first `maximum` entries and appends a visible marker for the rest. */
function omit(items: unknown[], maximum: number, marker: (count: number) => unknown) {
  if (items.length <= maximum) return items
  return [...items.slice(0, maximum), marker(items.length - maximum)]
}

function contentPart(value: unknown) {
  const part = object(value)
  choice(part.type, ["text", "reasoning", "tool"])
  if (part.type !== "tool") {
    clip(part, "text")
    return
  }
  name(part.name)
  const state = object(part.state)
  choice(state.status, ["pending", "running", "completed", "error"])
  if (state.status === "pending") return
  toolInput(state)
  state.content = omit(array(state.content, Infinity), 128, (count) => ({
    type: "text",
    text: `[${count} outputs omitted]`,
  }))
  for (const value of state.content as unknown[]) {
    const content = object(value)
    choice(content.type, ["text", "file"])
    if (content.type === "text") clip(content, "text")
    else string(content.uri)
  }
  if (state.status === "error") clip(object(state.error), "message")
}

// The one-line tool summary reads only these input fields. A wrong type or an
// oversized value is skipped or clipped, never a reason to reject the page.
const SUMMARY_FIELDS = ["command", "pattern", "query", "url", "filePath", "path", "file"]
const SUMMARY_LIMIT = 1024

function toolInput(state: Record<string, unknown>) {
  if (!isRecord(state.input)) return
  const input = state.input
  for (const key of SUMMARY_FIELDS) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== "string") delete input[key]
    else if (value.length > SUMMARY_LIMIT) input[key] = value.slice(0, SUMMARY_LIMIT)
  }
}
