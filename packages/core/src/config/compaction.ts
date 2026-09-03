export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

// Deliberately unbounded beyond `NonNegativeInt`: `Config.loadFile` drops any document it cannot
// decode, so a `Schema` range check on a user-facing value would silently delete the rest of the
// user's config on a typo. Ranges are clamped in `session/compaction.ts` instead.
export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
  /** Whole recent conversational turns to keep out of the summary. `0` disables turn alignment. */
  turns: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  /** Also clear stale re-derivable tool inputs (write/edit/apply_patch bodies) from replay. */
  pruneInputs: Schema.Boolean.pipe(Schema.optional),
  /** Also clear stale media attachments (pasted screenshots) from replay past the protect window. */
  pruneMedia: Schema.Boolean.pipe(Schema.optional),
  /** Clear older tool results whose content is byte-identical to a newer one (re-reads). */
  dedupOutputs: Schema.Boolean.pipe(Schema.optional),
  /**
   * Carry an append-only ledger of durable facts on each checkpoint alongside the summary.
   *
   * On by default: the A/B over the owner's production corpus measured 44.2% fact recall against
   * 20.0% for the summary alone (+121%) for +44% context tokens, the best recall-per-token of the
   * five strategies swept, and the only one whose recall does not decay across nine compaction
   * generations. Costs one extra, short summarizer-model call per compaction.
   */
  ledger: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
}) {}
