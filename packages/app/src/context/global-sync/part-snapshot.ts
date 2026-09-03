import type { Part } from "@turenlabs/sdk/v2/client"

/**
 * The part a `message.part.updated` snapshot should actually land.
 *
 * A text part is published while it is still streaming, so a snapshot can arrive carrying an
 * empty `text` for a block the user is already reading. Applying it verbatim clears the block
 * until the next delta re-appends the text, which reads as the response flickering out and back.
 *
 * A snapshot therefore only replaces text when it carries some. When it does not, the streamed
 * text stands, and it is kept on the part itself rather than only in the delta accumulator:
 * `renderable` decides whether the row exists by reading `part.text` while `readPartText` prefers
 * the accumulator, so leaving the two disagreeing hides a block whose text the renderer would
 * happily draw.
 *
 * Deliberately not a general "longest wins": a snapshot that carries text is authoritative even
 * when it is shorter, because that is how an edited or replaced part is meant to land. Only the
 * empty case is treated as "nothing to say yet".
 */
export function retainStreamedText(incoming: Part, streamed: string | undefined): Part {
  const text = (incoming as { text?: unknown }).text
  if (typeof text !== "string" || text.trim()) return incoming
  if (!streamed?.trim()) return incoming
  return { ...incoming, text: streamed } as Part
}

/** The streamed text for a part: the delta accumulator, else whatever the stored part already holds. */
export function streamedText(
  accumulated: Record<string, string | undefined> | undefined,
  stored: Part | undefined,
): string | undefined {
  const id = stored?.id
  const accum = id ? accumulated?.[id] : undefined
  if (accum?.trim()) return accum
  const text = (stored as { text?: unknown } | undefined)?.text
  return typeof text === "string" ? text : undefined
}
