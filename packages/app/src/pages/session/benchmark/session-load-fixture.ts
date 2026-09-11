import type { SessionMessage, SessionMessageAssistant, SessionMessageAssistantTool } from "@turenlabs/sdk/v2/client"

/**
 * A synthetic session shaped like the one users complain about.
 *
 * The profile below is not invented: it is the measured shape of `ses_0416aacddffew300GPndBgYIvM`
 * ("Revamp V2") in a real `forge-dev.db`, read straight out of `session_message`:
 *
 *   1952 messages, 228.7 MiB of `data`, largest single message 20.0 MiB
 *   1842 assistant / 103 user / 4 compaction / 3 system
 *   63 messages over 1 MiB carry 184.8 MiB — 81% of the bytes in 3% of the messages
 *
 * The concentration has one cause. `read` on an image returns the file base64-encoded, and the
 * transcript stores that payload *twice* per call: once as a `data:` URI in `state.content[]` and
 * once as raw base64 in `state.structured.content`. Eight such calls in one assistant message is
 * the 20 MiB outlier. Reproducing that duplication matters — a fixture that stored the bytes once
 * would understate every stage downstream of the fetch, and the whole point of the harness is to
 * find which stage the bytes actually hurt.
 *
 * Generation is seeded, so two runs on two machines produce byte-identical input and the
 * before/after numbers are comparable.
 */
export type SessionLoadProfile = {
  readonly messages: number
  readonly userShare: number
  readonly compactions: number
  /** Message byte buckets, as [share of messages, bytes each]. Shares are normalised. */
  readonly buckets: ReadonlyArray<{ readonly share: number; readonly bytes: number }>
}

/** The measured "Revamp V2" profile. Totals 1952 messages / ~228 MiB. */
export const revampV2Profile: SessionLoadProfile = {
  messages: 1952,
  userShare: 103 / 1952,
  compactions: 4,
  buckets: [
    { share: 136, bytes: 500 },
    { share: 1132, bytes: 4_900 },
    { share: 547, bytes: 22_300 },
    { share: 74, bytes: 380_000 },
    { share: 47, bytes: 2_300_000 },
    { share: 8, bytes: 5_800_000 },
    { share: 7, bytes: 8_000_000 },
    { share: 1, bytes: 20_900_000 },
  ],
}

/** The same shape at 1/16 scale: same distribution, small enough for a committed test. */
export const smallProfile: SessionLoadProfile = {
  messages: 122,
  userShare: 103 / 1952,
  compactions: 1,
  buckets: [
    { share: 9, bytes: 500 },
    { share: 71, bytes: 4_900 },
    { share: 34, bytes: 22_300 },
    { share: 5, bytes: 120_000 },
    { share: 3, bytes: 400_000 },
  ],
}

/** Deterministic 32-bit PRNG (mulberry32). Seeded so fixtures are byte-identical across runs. */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const PROSE =
  "The runner now drains the durable stream before projecting, so a snapshot that lands mid-transition " +
  "no longer reads as a navigation away. That was the silent-blank bug. "

/**
 * Payload builders. Both are cheap to produce and expensive to move, which is the property the
 * benchmark needs: cost must land in parse/transform/store, not in fixture construction.
 */
function base64Blob(bytes: number, next: () => number) {
  const seed = Array.from({ length: 96 }, () => BASE64_ALPHABET[Math.floor(next() * 64)]).join("")
  return seed.repeat(Math.ceil(bytes / seed.length)).slice(0, Math.max(bytes, 0))
}

function prose(bytes: number) {
  return PROSE.repeat(Math.ceil(bytes / PROSE.length)).slice(0, Math.max(bytes, 0))
}

function identifier(prefix: string, index: number) {
  return `${prefix}_${index.toString(36).padStart(10, "0")}`
}

/**
 * One `read` tool call on an image, with the payload stored on both branches the real transcript
 * stores it on. `structured.content` and the `data:` URI in `state.content` are separate strings
 * of the same length, exactly as the database has them.
 */
function imageReadTool(id: string, bytes: number, created: number, next: () => number): SessionMessageAssistantTool {
  const payload = base64Blob(Math.floor(bytes / 2), next)
  const name = `screenshot_${id}.png`
  return {
    type: "tool",
    id,
    name: "read",
    state: {
      status: "completed",
      input: { path: `/tmp/${name}` },
      content: [
        { type: "text", text: `Read image ${name}` },
        { type: "file", uri: `data:image/png;base64,${payload}`, mime: "image/png", name: `/tmp/${name}` },
      ],
      outputPaths: [],
      structured: {
        uri: `file:///private/tmp/${name}`,
        name,
        content: payload,
        encoding: "base64",
        mime: "image/png",
      },
    },
    time: { created, ran: created, completed: created + 40 },
  } as SessionMessageAssistantTool
}

function textTool(id: string, bytes: number, created: number): SessionMessageAssistantTool {
  return {
    type: "tool",
    id,
    name: "grep",
    state: {
      status: "completed",
      input: { pattern: "session", path: "packages/core" },
      content: [{ type: "text", text: prose(bytes) }],
      outputPaths: [],
      structured: { matches: Math.floor(bytes / 80) },
    },
    time: { created, ran: created, completed: created + 12 },
  } as SessionMessageAssistantTool
}

/**
 * Assistant messages carry the byte weight. Under ~1 MiB they are prose and grep output; above it
 * they are image reads, because that is the only thing in the real transcript that reaches those
 * sizes and the double-storage is what makes them cost what they cost.
 */
function assistantMessage(id: string, bytes: number, created: number, next: () => number): SessionMessageAssistant {
  const content: SessionMessageAssistant["content"] = [
    { type: "text", id: `${id}_text`, text: prose(Math.min(bytes, 900)) },
  ]
  let remaining = bytes - 900
  let index = 0
  while (remaining > 0) {
    const chunk = Math.min(remaining, 3_400_000)
    const toolID = `${id}_tool_${index}`
    content.push(chunk > 1_000_000 ? imageReadTool(toolID, chunk, created, next) : textTool(toolID, chunk, created))
    remaining -= chunk
    index += 1
  }
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5", variant: undefined } as SessionMessageAssistant["model"],
    time: { created, completed: created + 1_200 },
    content,
    finish: "stop",
    cost: 0.0184,
    tokens: { input: 24_100, output: 1_820, reasoning: 640, cache: { read: 180_400, write: 12_000 } },
  }
}

/**
 * Expand the bucket profile into one byte target per message, then interleave user turns and
 * compactions through it. Ordering matters: the big messages are spread across the timeline
 * rather than clustered, so a window taken from either end sees a representative slice.
 */
/**
 * Mirrors the lean-page transform in `packages/server/src/handlers/message.ts` — the
 * `session.messages?lean=true` payload a real page server emits. Duplicated here rather than
 * imported because the app package must not depend on the server; the constants must match.
 */
const LEAN_TOOL_BODY_BYTES = 64 * 1024
const LEAN_STRUCTURED_KEEP_BYTES = 256

const leanByteSize = (value: unknown) => (value === undefined ? 0 : JSON.stringify(value).length)

export function leanSessionMessage(message: SessionMessage): SessionMessage {
  if (message.type !== "assistant") return message
  let trimmed = false
  const content = message.content.map((item) => {
    if (item.type !== "tool" || (item.state.status !== "completed" && item.state.status !== "error")) return item
    const state = item.state
    const bytes =
      leanByteSize(state.content) +
      leanByteSize(state.structured) +
      leanByteSize("result" in state ? state.result : undefined) +
      leanByteSize("attachments" in state ? state.attachments : undefined)
    if (bytes <= LEAN_TOOL_BODY_BYTES) return item
    trimmed = true
    return {
      ...item,
      truncated: { bytes },
      state: {
        ...state,
        content: [],
        structured: leanByteSize(state.structured) <= LEAN_STRUCTURED_KEEP_BYTES ? state.structured : {},
        ...(state.status === "completed" ? { result: undefined, attachments: undefined } : {}),
        ...(state.status === "error" ? { result: undefined } : {}),
      },
    }
  })
  return trimmed ? { ...message, content } : message
}

export function generateSessionMessages(profile: SessionLoadProfile = revampV2Profile, seed = 0x5e551071) {
  const next = random(seed)
  const sizes: number[] = []
  profile.buckets.forEach((bucket) => {
    for (let index = 0; index < bucket.share; index += 1) sizes.push(bucket.bytes)
  })
  while (sizes.length < profile.messages) sizes.push(profile.buckets[1]?.bytes ?? 4_900)
  sizes.length = profile.messages

  // Deterministic shuffle so large messages are distributed, not contiguous.
  for (let index = sizes.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    const value = sizes[index]!
    sizes[index] = sizes[swap]!
    sizes[swap] = value
  }

  const userEvery = Math.max(2, Math.round(1 / profile.userShare))
  // Compactions are placed at explicit interior indices rather than by modulus. A modulus also
  // fires near the very end of the transcript, and since `presentSessionV2Messages` treats a
  // compaction as the visible-history boundary (`messages.length = 0`), a late one would leave the
  // projection two messages long and silently flatten every stage the benchmark is trying to time.
  const compactionAt = new Set(
    Array.from({ length: profile.compactions }, (_, index) =>
      Math.floor(((index + 1) * profile.messages) / (profile.compactions + 1)),
    ),
  )
  const messages: SessionMessage[] = []
  let created = 1_760_000_000_000

  for (let index = 0; index < profile.messages; index += 1) {
    created += 900
    const id = identifier("msg", index)
    if (index === 0 || index % userEvery === 0) {
      messages.push({
        id,
        type: "user",
        text: prose(Math.min(sizes[index]!, 2_000)),
        time: { created },
      } as SessionMessage)
      continue
    }
    if (compactionAt.has(index)) {
      messages.push({
        id,
        type: "compaction",
        reason: "auto",
        summary: prose(6_000),
        recent: prose(2_000),
        time: { created },
      } as SessionMessage)
      continue
    }
    messages.push(assistantMessage(id, sizes[index]!, created, next))
  }

  // The transcript must open on a user turn: `presentSessionV2Messages` drops assistant messages
  // that have no preceding user message, so a fixture starting on an assistant would silently
  // shrink and understate every stage.
  return messages
}

/** Total wire bytes of a message list, as the HTTP layer would send them. */
export function messageBytes(messages: readonly SessionMessage[]) {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0)
}
