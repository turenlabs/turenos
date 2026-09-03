import type { SnapshotFileDiff } from "@turenlabs/sdk/v2"
import type { PartGroup } from "@turenlabs/session-ui/message-part"
import { Data, Equal } from "effect"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export namespace TimelineRow {
  /**
   * `separate` is the transcript's density rule, recovered from the deleted TUI
   * (`setPreLayoutSiblingMargin` in packages/tui/src/util/layout.ts). Spacing is
   * always owned by the *follower*, never the leader, so gaps can never double
   * and "close this gap" stays a single decision at one node. A row asks for one
   * blank line above it only at a structural boundary — see density.ts.
   */
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
    separate: boolean
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
    separate: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
    separate: boolean
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    separate: boolean
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    reasoningHeading?: string
    separate: boolean
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
    separate: boolean
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    text: string
    separate: boolean
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
    separate: boolean
  }> {}
  /**
   * A compaction that produced no checkpoint.
   *
   * Its own row rather than an `Error`: the two coexist on exactly the session this exists for --
   * a turn that failed on an overflow, followed by a `/compact` that could not fix it -- and
   * `Error` is keyed one-per-turn, so reusing it would silently drop one of the two notices.
   */
  export class CompactionFailure extends Data.TaggedClass("CompactionFailure")<{
    userMessageID: string
    text: string
    separate: boolean
  }> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | Thinking
    | DiffSummary
    | Error
    | Retry
    | CompactionFailure

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
      case "CompactionFailure":
        return `compaction-failure:${row.userMessageID}`
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }
}
