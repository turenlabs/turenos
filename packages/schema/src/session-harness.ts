export * as SessionHarness from "./session-harness"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, RelativePath, optional, statics } from "./schema"

export const MAX_ID_LENGTH = 128
export const MAX_SUMMARY_LENGTH = 4_000
export const MAX_DESCRIPTION_LENGTH = 2_000
export const MAX_PATH_LENGTH = 4_096
export const MAX_CHANGE_CONTENT_LENGTH = 256_000
export const MAX_CHANGES = 128
export const MAX_PROPOSALS = 128
export const MAX_SNAPSHOTS = 32
export const MAX_SNAPSHOT_BYTES = 1_000_000
export const MAX_STATE_BYTES = 64_000_000
export const MAX_REVIEWER_REQUESTS = 32
export const MAX_REVIEWER_REQUEST_LENGTH = 4_000
export const MAX_REVIEWER_RUNS = 50
export const MAX_TOOLS = 64
export const MAX_VALIDATION_MESSAGES = 64
export const MAX_GUIDANCE = 24
export const MAX_GUIDANCE_LENGTH = 600

const bounded = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const boundedNonEmpty = (maximum: number) => Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(maximum)))
// 64 is the hard ceiling in Tool.validateName. Exceeding it makes ToolRegistry.materialize die,
// which would kill every provider turn in the session, so reject the name here instead.
const harnessToolName = boundedNonEmpty(64).pipe(Schema.check(Schema.isPattern(/^harness_[A-Za-z0-9_-]+$/)))
const boundedArray = <S extends Schema.Top>(schema: S, maximum: number) =>
  Schema.Array(schema).pipe(Schema.check(Schema.isMaxLength(maximum)))

export const ProposalID = boundedNonEmpty(MAX_ID_LENGTH).pipe(
  Schema.brand("SessionHarness.ProposalID"),
  statics((schema) => ({ create: () => schema.make(`hpr_${ascending()}`) })),
)
export type ProposalID = typeof ProposalID.Type

export const Version = PositiveInt.pipe(Schema.brand("SessionHarness.Version"))
export type Version = typeof Version.Type

export const ProposalStatus = Schema.Literals([
  "draft",
  "pending",
  "approved",
  "applied",
  "rejected",
  "failed",
]).annotate({ identifier: "SessionHarness.ProposalStatus" })
export type ProposalStatus = typeof ProposalStatus.Type

export const SnapshotStatus = Schema.Literals(["active", "superseded", "rolledBack"]).annotate({
  identifier: "SessionHarness.SnapshotStatus",
})
export type SnapshotStatus = typeof SnapshotStatus.Type

export const SnapshotSource = Schema.Literals(["default", "proposal", "reload", "rollback"]).annotate({
  identifier: "SessionHarness.SnapshotSource",
})
export type SnapshotSource = typeof SnapshotSource.Type

export const ValidationStatus = Schema.Literals(["pending", "passed", "failed"]).annotate({
  identifier: "SessionHarness.ValidationStatus",
})
export type ValidationStatus = typeof ValidationStatus.Type

export const Timestamps = Schema.Struct({
  created: DateTimeUtcFromMillis,
  updated: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionHarness.Timestamps" })
export interface Timestamps extends Schema.Schema.Type<typeof Timestamps> {}

export const Validation = Schema.Struct({
  status: ValidationStatus,
  errors: boundedArray(boundedNonEmpty(MAX_DESCRIPTION_LENGTH), MAX_VALIDATION_MESSAGES),
  warnings: boundedArray(boundedNonEmpty(MAX_DESCRIPTION_LENGTH), MAX_VALIDATION_MESSAGES),
}).annotate({ identifier: "SessionHarness.Validation" })
export interface Validation extends Schema.Schema.Type<typeof Validation> {}

/**
 * Why one automatic review ended. The reviewer has several legitimate no-op exits, and without a
 * recorded outcome "working but nothing to propose" is indistinguishable from "silently broken".
 */
export const ReviewerRunOutcome = Schema.Literals([
  "unchanged",
  "no_output",
  "unparseable",
  "duplicate",
  "proposed",
  "applied",
  "unsafe",
  "failed",
  "timeout",
]).annotate({ identifier: "SessionHarness.ReviewerRunOutcome" })
export type ReviewerRunOutcome = typeof ReviewerRunOutcome.Type

export const ReviewerRun = Schema.Struct({
  reviewerSessionID: bounded(MAX_ID_LENGTH),
  outcome: ReviewerRunOutcome,
  detail: bounded(MAX_SUMMARY_LENGTH).pipe(optional),
  timestamp: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionHarness.ReviewerRun" })
export interface ReviewerRun extends Schema.Schema.Type<typeof ReviewerRun> {}

export const ReviewerRequest = Schema.Struct({
  id: boundedNonEmpty(MAX_ID_LENGTH),
  request: boundedNonEmpty(MAX_REVIEWER_REQUEST_LENGTH),
  timestamps: Timestamps,
}).annotate({ identifier: "SessionHarness.ReviewerRequest" })
export interface ReviewerRequest extends Schema.Schema.Type<typeof ReviewerRequest> {}

export const ChangeOperation = Schema.Literals(["add", "modify", "delete"]).annotate({
  identifier: "SessionHarness.ChangeOperation",
})
export type ChangeOperation = typeof ChangeOperation.Type

export const HarnessChange = Schema.Struct({
  path: RelativePath.pipe(Schema.check(Schema.isMaxLength(MAX_PATH_LENGTH))),
  operation: ChangeOperation,
  summary: bounded(MAX_SUMMARY_LENGTH).pipe(optional),
  patch: bounded(MAX_CHANGE_CONTENT_LENGTH).pipe(optional),
  content: bounded(MAX_CHANGE_CONTENT_LENGTH).pipe(optional),
}).annotate({ identifier: "SessionHarness.Change" })
export interface HarnessChange extends Schema.Schema.Type<typeof HarnessChange> {}

export const HarnessTool = Schema.Struct({
  name: harnessToolName,
  description: bounded(MAX_DESCRIPTION_LENGTH),
  source: RelativePath.pipe(optional),
  readOnly: Schema.Boolean,
  enabled: Schema.Boolean,
}).annotate({ identifier: "SessionHarness.Tool" })
export interface HarnessTool extends Schema.Schema.Type<typeof HarnessTool> {}

/**
 * A standing instruction injected into the agent's system prompt every turn.
 *
 * Listing a tool tells the model the tool exists; it does not make the model reach for it at the
 * moment it matters, when a familiar path like grep is right there. Guidance names the situation
 * ("about to edit mem.rs") alongside the directive, so the reminder fires where the decision is.
 * Optional because snapshots written before it existed decode without it.
 */
export const HarnessGuidance = Schema.Struct({
  directive: boundedNonEmpty(MAX_GUIDANCE_LENGTH),
  appliesTo: bounded(MAX_PATH_LENGTH).pipe(optional),
}).annotate({ identifier: "SessionHarness.Guidance" })
export interface HarnessGuidance extends Schema.Schema.Type<typeof HarnessGuidance> {}

export const HarnessSnapshot = Schema.Struct({
  version: Version,
  parent: Version.pipe(optional),
  status: SnapshotStatus,
  source: SnapshotSource,
  changes: boundedArray(HarnessChange, MAX_CHANGES),
  tools: boundedArray(HarnessTool, MAX_TOOLS),
  guidance: boundedArray(HarnessGuidance, MAX_GUIDANCE).pipe(optional),
  validation: Validation,
  timestamps: Timestamps,
}).annotate({ identifier: "SessionHarness.Snapshot" })
export interface HarnessSnapshot extends Schema.Schema.Type<typeof HarnessSnapshot> {}

export const HarnessProposal = Schema.Struct({
  id: ProposalID,
  baseVersion: NonNegativeInt,
  summary: boundedNonEmpty(MAX_SUMMARY_LENGTH),
  changes: boundedArray(HarnessChange, MAX_CHANGES),
  tools: boundedArray(HarnessTool, MAX_TOOLS).pipe(optional),
  guidance: boundedArray(HarnessGuidance, MAX_GUIDANCE).pipe(optional),
  status: ProposalStatus,
  appliedVersion: Version.pipe(optional),
  validation: Validation,
  timestamps: Timestamps,
}).annotate({ identifier: "SessionHarness.Proposal" })
export interface HarnessProposal extends Schema.Schema.Type<typeof HarnessProposal> {}

export const State = Schema.Struct({
  snapshot: Schema.NullOr(HarnessSnapshot),
  proposals: boundedArray(HarnessProposal, MAX_PROPOSALS),
  reviewerRequests: boundedArray(ReviewerRequest, MAX_REVIEWER_REQUESTS),
  reviewerRuns: boundedArray(ReviewerRun, MAX_REVIEWER_RUNS),
}).annotate({ identifier: "SessionHarness.State" })
export interface State extends Schema.Schema.Type<typeof State> {}

export const ProposalInput = Schema.Struct({
  id: ProposalID.pipe(optional),
  baseVersion: NonNegativeInt,
  summary: boundedNonEmpty(MAX_SUMMARY_LENGTH),
  // Optional so a proposal can carry only tools or only guidance. The stored proposal still holds a
  // list, so an absent one means "no file changes" rather than "leave the existing ones alone".
  changes: boundedArray(HarnessChange, MAX_CHANGES).pipe(optional),
  tools: boundedArray(HarnessTool, MAX_TOOLS).pipe(optional),
  guidance: boundedArray(HarnessGuidance, MAX_GUIDANCE).pipe(optional),
}).annotate({ identifier: "SessionHarness.ProposalInput" })
export interface ProposalInput extends Schema.Schema.Type<typeof ProposalInput> {}

export const ProposalStatusInput = Schema.Struct({
  status: ProposalStatus,
  validation: Validation.pipe(optional),
}).annotate({ identifier: "SessionHarness.ProposalStatusInput" })
export interface ProposalStatusInput extends Schema.Schema.Type<typeof ProposalStatusInput> {}

export const ReviewerRequestInput = Schema.Struct({
  id: boundedNonEmpty(MAX_ID_LENGTH).pipe(optional),
  request: boundedNonEmpty(MAX_REVIEWER_REQUEST_LENGTH),
}).annotate({ identifier: "SessionHarness.ReviewerRequestInput" })
export interface ReviewerRequestInput extends Schema.Schema.Type<typeof ReviewerRequestInput> {}

export const ReloadInput = Schema.Struct({
  baseVersion: Version,
}).annotate({ identifier: "SessionHarness.ReloadInput" })
export interface ReloadInput extends Schema.Schema.Type<typeof ReloadInput> {}

export const RollbackInput = Schema.Struct({
  baseVersion: Version,
  version: Version,
}).annotate({ identifier: "SessionHarness.RollbackInput" })
export interface RollbackInput extends Schema.Schema.Type<typeof RollbackInput> {}
