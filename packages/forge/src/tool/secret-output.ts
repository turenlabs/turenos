import { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { Effect } from "effect"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { isRecord } from "@/util/record"

export const WITHHELD = "[Tool output withheld: secret redaction failed]"

/** Withholds every value: live output is never passed through unprotected. */
const unavailable: SecretOutput.Snapshot = {
  text: () => WITHHELD,
  json: () => ({ error: WITHHELD }),
  boundary: (value) => value.length,
}

/** Releases held output once this much is pending, so a long stream is written as it runs. */
const STREAM_FLUSH = 256 * 1024

export interface Stream {
  /** Accepts the next captured chunk; returns protected text that is now safe to append. */
  readonly push: (chunk: string) => string
  /** Returns the protected remainder once the stream has ended. */
  readonly end: () => string
}

/**
 * Protects output that is appended to a file as it arrives. Text is held until the snapshot
 * reports a boundary no credential can straddle -- a chunk edge can split a token, and redacting
 * each chunk alone would miss both halves. A guard without boundaries holds everything until the
 * end; past the redactor's byte budget the rest of the stream is withheld rather than written raw.
 */
export function stream(guard: SecretOutput.Snapshot): Stream {
  let pending = ""
  let withheld = false
  return {
    push: (chunk) => {
      if (withheld) return ""
      pending += chunk
      if (pending.length < STREAM_FLUSH) return ""
      const cut = release(pending, guard)
      if (cut > 0) {
        const head = pending.slice(0, cut)
        pending = pending.slice(cut)
        return text(head, guard)
      }
      if (Buffer.byteLength(pending, "utf8") <= SecretRedaction.MAX_BYTES) return ""
      withheld = true
      pending = ""
      return `\n${WITHHELD}\n`
    },
    end: () => {
      const rest = pending
      pending = ""
      return withheld || rest.length === 0 ? "" : text(rest, guard)
    },
  }
}

function release(value: string, guard: SecretOutput.Snapshot) {
  try {
    return guard.boundary?.(value) ?? 0
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
 * exactly as stored -- it was protected when written, and re-saving a historical part (a compaction
 * mark, say) must not destroy it. Anything new is withheld rather than written raw.
 */
export function withheld(value: SessionV1.ToolState, stored: SessionV1.ToolState | undefined): SessionV1.ToolState {
  if (value.status === "pending") return value
  const kept = <A>(next: A, previous: unknown) => {
    try {
      return previous !== undefined && JSON.stringify(next) === JSON.stringify(previous) ? next : undefined
    } catch {
      return undefined
    }
  }
  const previous = stored?.status === value.status ? (stored as Record<string, unknown>) : {}
  const metadata =
    value.metadata === undefined ? undefined : (kept(value.metadata, previous.metadata) ?? { error: WITHHELD })
  if (value.status === "error") return { ...value, metadata, error: kept(value.error, previous.error) ?? WITHHELD }
  if (value.status === "running")
    return {
      ...value,
      metadata,
      title: value.title === undefined ? undefined : (kept(value.title, previous.title) ?? WITHHELD),
    }
  return {
    ...value,
    metadata: metadata ?? {},
    title: kept(value.title, previous.title) ?? WITHHELD,
    output: kept(value.output, previous.output) ?? WITHHELD,
  }
}

export * as ToolOutput from "./secret-output"
