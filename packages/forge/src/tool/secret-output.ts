import { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { Effect } from "effect"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { isRecord } from "@/util/record"

export const WITHHELD = "[Tool output withheld: secret redaction failed]"

/** Withholds every value: live output is never passed through unprotected. */
const unavailable: SecretOutput.Snapshot = {
  text: () => WITHHELD,
  parts: (values) => values.map(() => WITHHELD),
  json: () => ({ error: WITHHELD }),
  boundary: (value) => value.length,
}

// A held suffix at least this long is re-examined only once it has doubled, keeping a long hold linear.
const LONG_HOLD = 64 * 1024

export interface Stream {
  /** Accepts the next captured chunk; returns protected text that is now safe to append. */
  readonly push: (chunk: string) => string
  /** Returns the protected remainder once the stream has ended. */
  readonly end: () => string
}

/**
 * Protects output as it arrives, for everything derived from it: live previews, saved files and
 * final tails. Each push releases the text the snapshot reports as decided -- a chunk edge can split
 * a token, and redacting each chunk alone would publish its first half -- and holds only the suffix
 * that later text could still turn into a finding. A guard without boundaries holds everything
 * until the end; past the redactor's byte budget the rest of the stream is withheld, never raw.
 */
export function stream(guard: SecretOutput.Snapshot): Stream {
  let pending = ""
  let held = 0
  let withheld = false
  let repeated = false
  // Consecutive failed releases collapse into one notice instead of one per chunk.
  const emit = (value: string) => {
    const safe = text(value, guard)
    if (safe === WITHHELD && repeated) return ""
    repeated = safe === WITHHELD
    return safe
  }
  return {
    push: (chunk) => {
      if (withheld) return ""
      pending += chunk
      if (held >= LONG_HOLD && pending.length < held * 2) return ""
      const cut = release(pending, guard)
      if (cut > 0) {
        const head = pending.slice(0, cut)
        pending = pending.slice(cut)
        held = 0
        return emit(head)
      }
      held = pending.length
      if (Buffer.byteLength(pending, "utf8") <= SecretRedaction.MAX_BYTES) return ""
      withheld = true
      pending = ""
      return `\n${WITHHELD}\n`
    },
    end: () => {
      const rest = pending
      pending = ""
      return withheld || rest.length === 0 ? "" : emit(rest)
    },
  }
}

function release(value: string, guard: SecretOutput.Snapshot) {
  try {
    const cut = guard.boundary?.(value) ?? 0
    // Each release is encoded on its own; never end one between the halves of a surrogate pair.
    const code = value.charCodeAt(cut - 1)
    return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut
  } catch {
    return 0
  }
}

/** A protection snapshot for fresh tool output; an outage withholds that output instead of failing. */
export const snapshot = (protection: Effect.Effect<SecretOutput.Snapshot, SecretOutput.Error>) =>
  protection.pipe(Effect.catch(() => Effect.succeed(unavailable)))

export function text(value: string, guard: SecretOutput.Snapshot) {
  try {
    return guard.text(value)
  } catch {
    return WITHHELD
  }
}

/**
 * Display metadata is JSON-compatible rather than strictly plain: dates, class instances and
 * non-finite numbers are normalized the way the persisted JSON would be, and only a node the walk
 * refuses to read is withheld. The whole record is replaced only when a budget is exhausted.
 */
export function record(value: Record<string, unknown>, guard: SecretOutput.Snapshot) {
  try {
    const result = SecretRedaction.lenient(value, (part) => guard.text(part))
    return isRecord(result) ? result : { error: WITHHELD }
  } catch {
    return { error: WITHHELD }
  }
}

export function state(value: SessionV1.ToolState, guard: SecretOutput.Snapshot): SessionV1.ToolState {
  if (value.status === "pending") return value
  const metadata = value.metadata === undefined ? undefined : record(value.metadata, guard)
  if (value.status === "error") return { ...value, metadata, error: text(value.error, guard) }
  if (value.status === "running")
    return { ...value, metadata, title: value.title === undefined ? undefined : text(value.title, guard) }
  return { ...value, metadata: metadata ?? {}, title: text(value.title, guard), output: text(value.output, guard) }
}

/**
 * The state to persist while protection is unavailable. Text already stored for this part is kept
 * -- it was protected when written, and re-saving a historical part (a compaction mark, say) must
 * not destroy it -- and anything new is withheld rather than written raw.
 *
 * The incoming state is read only through its own data properties, and compared through the same
 * hook-free walk that normalizes healthy metadata: no accessor, `toJSON` hook or proxy trap runs.
 * A matching field is written from the stored copy, so no incoming object is retained to be read
 * again when the part is serialized.
 */
export function withheld(value: SessionV1.ToolState, stored: SessionV1.ToolState | undefined): SessionV1.ToolState {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const own: Record<string, unknown> = Object.fromEntries(
    Object.entries(descriptors).flatMap(([key, descriptor]) =>
      descriptor.enumerable && "value" in descriptor ? [[key, descriptor.value]] : [],
    ),
  )
  // A subset of the typed state's own fields; an accessor-backed field is absent here.
  const fields = own as SessionV1.ToolState
  if (fields.status === "pending") return fields
  // Present means set to anything, including an accessor that is never called.
  const present = (key: string) => {
    const descriptor = descriptors[key]
    return descriptor !== undefined && (!("value" in descriptor) || descriptor.value !== undefined)
  }
  const previous: Record<string, unknown> = stored?.status === fields.status ? stored : {}
  const kept = (key: string) => {
    if (previous[key] === undefined || !(key in own)) return undefined
    try {
      const incoming = SecretRedaction.lenient(own[key], (part) => part)
      return JSON.stringify(incoming) === JSON.stringify(previous[key]) ? previous[key] : undefined
    } catch {
      return undefined
    }
  }
  const storedMetadata = kept("metadata")
  const metadata = present("metadata") ? (isRecord(storedMetadata) ? storedMetadata : { error: WITHHELD }) : undefined
  const content = (key: string) => {
    const text = kept(key)
    return typeof text === "string" ? text : WITHHELD
  }
  if (fields.status === "error") return { ...fields, metadata, error: content("error") }
  if (fields.status === "running")
    return { ...fields, metadata, title: present("title") ? content("title") : undefined }
  return { ...fields, metadata: metadata ?? {}, title: content("title"), output: content("output") }
}

export * as ToolOutput from "./secret-output"
