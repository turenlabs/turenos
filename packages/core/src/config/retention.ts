export * as ConfigRetention from "./retention"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

/** Days before an archived session's payloads are reduced to previews. */
export const DEFAULT_ARCHIVED_SESSION_DAYS = 30
/** Days before a stored tool payload is reduced to its preview, archived or not. */
export const DEFAULT_TOOL_OUTPUT_DAYS = 14
/**
 * Ceiling on either window. Ten years is well past the point where a larger number means anything
 * other than "never", and `0` already spells that explicitly.
 */
export const MAX_DAYS = 3650

/** `0` is the explicit opt-out, which is why both fields are `NonNegativeInt` rather than positive. */
export const DISABLED = 0

// Deliberately unbounded beyond `NonNegativeInt`: `Config.loadFile` drops any document it cannot
// decode, so a `Schema` range check on a user-facing value would silently delete the rest of the
// user's config on a typo. Ranges are clamped in `retention.ts` instead.
export class Info extends Schema.Class<Info>("ConfigV2.Retention")({
  archivedSessionDays: NonNegativeInt.pipe(Schema.optional).annotate({
    description: `Days after a session is archived before its tool payloads and shell output are reduced to previews. Titles, user prompts, and assistant text are always kept. Defaults to ${DEFAULT_ARCHIVED_SESSION_DAYS}; \`0\` disables it; values above ${MAX_DAYS} are clamped.`,
  }),
  toolOutputDays: NonNegativeInt.pipe(Schema.optional).annotate({
    description: `Days a stored tool payload is kept in full, in any session, before it is reduced to its preview. Defaults to ${DEFAULT_TOOL_OUTPUT_DAYS}; \`0\` disables it; values above ${MAX_DAYS} are clamped.`,
  }),
}) {}
