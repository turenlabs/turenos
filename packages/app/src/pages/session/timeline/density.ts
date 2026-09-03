import type { Part } from "@turenlabs/sdk/v2"
import type { PartGroup } from "@turenlabs/session-ui/message-part"

/**
 * The transcript's density rule, recovered from the deleted TUI
 * (`setPreLayoutSiblingMargin`, packages/tui/src/util/layout.ts at 3b2694a11).
 *
 * The TUI gave a row one blank line above it iff its preceding sibling was in
 * `alwaysSeparate` — prose, reasoning, an error, a ruled panel, the user turn —
 * or had rendered taller than one line. Everything else, meaning a run of
 * single-line tool rows, stacked flush. Spacing was always owned by the
 * *follower*, never the leader, so gaps could never double and "close this gap"
 * stayed a single decision at one node.
 *
 * Two of those clauses are pure structure and port exactly. The third,
 * `previous.height > 1`, is a measurement of the *rendered* row and deliberately
 * does not: reading it back would mean deciding spacing after layout, which is
 * precisely what the TUI's pre-layout hook existed to avoid, and here it would
 * feed a measured height straight back into the virtualiser that measured it.
 * On a wide desktop window a tool row is single-line by construction, so the
 * clause is close to vacuous anyway. An expanded tool body is the one case it
 * would still have caught; the desktop gives those their own chrome instead.
 *
 * "boundary" is the TurnGap row: it *is* the blank line, so neither it nor the
 * row after it asks for another one.
 */
export type TimelineRowKind = "boundary" | "block" | "inline"

const BLOCK_PART_TYPES = new Set(["text", "reasoning", "compaction"])

export function separateFrom(previous: TimelineRowKind | undefined, current: TimelineRowKind) {
  if (previous === undefined) return false
  if (current === "boundary" || previous === "boundary") return false
  return current === "block" || previous === "block"
}

/**
 * A grouped assistant row reads as a block when it renders prose, and as a
 * single-line tool row otherwise. The context cluster (read/glob/grep/list) is
 * one collapsed line however many calls it holds, so it counts as inline.
 */
export function assistantPartKind(group: PartGroup, part: Part | undefined): TimelineRowKind {
  if (group.type === "context") return "inline"
  if (!part) return "inline"
  return BLOCK_PART_TYPES.has(part.type) ? "block" : "inline"
}
