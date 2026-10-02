export * as PriorWork from "./prior-work"

import { Schema } from "effect"
import { Agent } from "./agent"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { Session } from "./session"

/**
 * Size limits from `specs/prior-work.md`, measured in UTF-8 bytes. Oversized input is rejected,
 * never truncated.
 */
export const Limits = {
  summaryBytes: 512,
  detailBytes: 8 * 1024,
  methodBytes: 1024,
  assumptions: 16,
  assumptionBytes: 512,
  locations: 32,
  pathBytes: 1024,
  symbolBytes: 512,
  evidence: 16,
  evidenceRefBytes: 1024,
  evidenceNoteBytes: 1024,
  derivedFrom: 8,
  sourceIDBytes: 128,
  nameBytes: 128,
  reasonBytes: 1024,
  keyBytes: 128,
  searchTextBytes: 256,
  revisionBytes: 16 * 1024,
  pageSize: 50,
} as const

/**
 * Filter `expected` annotation shared by every byte limit, so a decode failure can be reported as
 * `too_large` without reading the rejected value.
 */
export const BYTE_LIMIT = "PriorWork.byteLimit"

const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const maxBytes = (maximum: number) =>
  Schema.makeFilter<string>((value) => bytes(value) <= maximum, { expected: BYTE_LIMIT })
const text = (maximum: number) => Schema.String.check(maxBytes(maximum))
const required = (maximum: number) => Schema.String.check(Schema.isMinLength(1), maxBytes(maximum))

export const RecordID = Schema.String.check(Schema.isStartsWith("pwr_"), Schema.isMaxLength(64)).pipe(
  Schema.brand("PriorWork.RecordID"),
  statics((schema) => ({ create: () => schema.make("pwr_" + ascending()) })),
)
export type RecordID = typeof RecordID.Type

export const RepositoryID = Schema.String.check(Schema.isStartsWith("pwb_"), Schema.isMaxLength(64)).pipe(
  Schema.brand("PriorWork.RepositoryID"),
  statics((schema) => ({ create: () => schema.make("pwb_" + ascending()) })),
)
export type RepositoryID = typeof RepositoryID.Type

export const EventID = Schema.String.check(Schema.isStartsWith("pwe_"), Schema.isMaxLength(64)).pipe(
  Schema.brand("PriorWork.EventID"),
  statics((schema) => ({ create: () => schema.make("pwe_" + ascending()) })),
)
export type EventID = typeof EventID.Type

export const Kind = Schema.Literals(["finding", "lead", "refutation", "coverage"]).annotate({
  identifier: "PriorWork.Kind",
})
export type Kind = typeof Kind.Type

export const State = Schema.Literals(["active", "retracted", "deleted"]).annotate({ identifier: "PriorWork.State" })
export type State = typeof State.Type

/** Historical entry kinds a record can be adopted from. */
export const SourceKind = Schema.Literals(["board_note", "room_entry"]).annotate({ identifier: "PriorWork.SourceKind" })
export type SourceKind = typeof SourceKind.Type

export const Assumption = Schema.Struct({
  text: required(Limits.assumptionBytes),
  status: Schema.Literals(["known", "unknown"]),
}).annotate({ identifier: "PriorWork.Assumption" })
export interface Assumption extends Schema.Schema.Type<typeof Assumption> {}

const Line = PositiveInt

/** Repository-root-relative anchors: a file span or a whole directory. */
export const Location = Schema.Union([
  Schema.Struct({
    path: required(Limits.pathBytes),
    start_line: optional(Line),
    end_line: optional(Line),
    symbol: optional(required(Limits.symbolBytes)),
  }).check(
    Schema.makeFilter(
      (value) =>
        value.start_line === undefined ||
        value.end_line === undefined ||
        value.start_line <= value.end_line || { path: ["end_line"], issue: "end_line precedes start_line" },
    ),
  ),
  Schema.Struct({ directory: required(Limits.pathBytes) }),
]).annotate({ identifier: "PriorWork.Location" })
export type Location = typeof Location.Type

export const Evidence = Schema.Struct({
  kind: Schema.Literals(["file", "command", "url", "record"]),
  ref: required(Limits.evidenceRefBytes),
  note: optional(text(Limits.evidenceNoteBytes)),
}).annotate({ identifier: "PriorWork.Evidence" })
export interface Evidence extends Schema.Schema.Type<typeof Evidence> {}

/** One exact record revision. */
export const RevisionRef = Schema.Struct({
  record_id: RecordID,
  revision: PositiveInt,
}).annotate({ identifier: "PriorWork.RevisionRef" })
export interface RevisionRef extends Schema.Schema.Type<typeof RevisionRef> {}

export const SourceRef = Schema.Struct({
  source: SourceKind,
  source_id: required(Limits.sourceIDBytes),
}).annotate({ identifier: "PriorWork.SourceRef" })
export interface SourceRef extends Schema.Schema.Type<typeof SourceRef> {}

/**
 * What a refutation challenges: one exact revision, or an adopted-source entry whose record does
 * not exist yet. An unresolved challenge is resolved by a new revision when its source is adopted.
 */
export const Challenges = Schema.Union([
  Schema.Struct({ resolved: RevisionRef }),
  Schema.Struct({ unresolved: SourceRef }),
]).annotate({ identifier: "PriorWork.Challenges" })
export type Challenges = typeof Challenges.Type

/**
 * Strict canonical anchor form for prepared input: a nonempty POSIX repository-root-relative path
 * with no absolute or drive prefix, NUL, backslash, empty segment, trailing slash, `.`/`..`
 * segment, or `.git` component. Stored/output decoding stays lenient; legacy malformed anchors
 * become unknown applicability rather than read failures.
 */
export const canonicalAnchor = (value: string) =>
  value.isWellFormed() &&
  !/[\0\\]/.test(value) &&
  !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")

const anchorOf = (location: Location) => ("path" in location ? location.path : location.directory)

/**
 * The prepared, model-readable fields of one revision. Everything else (repository binding,
 * recorder, origin, capture, observation) is filled by the server.
 */
export const Prepared = Schema.Struct({
  kind: Kind,
  summary: required(Limits.summaryBytes).check(
    Schema.makeFilter((value) => !/[\r\n]/.test(value), { expected: "a single line" }),
  ),
  detail: text(Limits.detailBytes),
  method: required(Limits.methodBytes),
  assumptions: Schema.Array(Assumption).check(Schema.isMaxLength(Limits.assumptions)),
  locations: Schema.Array(Location).check(Schema.isMaxLength(Limits.locations)),
  evidence: Schema.Array(Evidence).check(Schema.isMaxLength(Limits.evidence)),
  challenges: optional(Challenges),
  derived_from: Schema.Array(RevisionRef).check(Schema.isMaxLength(Limits.derivedFrom)),
})
  .check(
    Schema.makeFilter(
      (value) =>
        (value.kind === "refutation") === (value.challenges !== undefined) || {
          path: ["challenges"],
          issue: "challenges are required for refutations and not allowed otherwise",
        },
    ),
  )
  .check(
    Schema.makeFilter((value) => {
      const index = value.locations.findIndex((location) => !canonicalAnchor(anchorOf(location)))
      if (index === -1) return true
      const location = value.locations[index]!
      return { path: ["locations", index, "path" in location ? "path" : "directory"], issue: "noncanonical anchor" }
    }),
  )
  .check(Schema.makeFilter((value) => bytes(JSON.stringify(value)) <= Limits.revisionBytes, { expected: BYTE_LIMIT }))
  .annotate({ identifier: "PriorWork.Prepared" })
export interface Prepared extends Schema.Schema.Type<typeof Prepared> {}

export const AgentActor = Schema.Struct({
  actor: Schema.Literal("agent"),
  session_id: Session.ID,
  agent: Agent.ID,
}).annotate({ identifier: "PriorWork.AgentActor" })
export interface AgentActor extends Schema.Schema.Type<typeof AgentActor> {}

export const HumanActor = Schema.Struct({
  actor: Schema.Literal("human"),
  name: optional(required(Limits.nameBytes)),
}).annotate({ identifier: "PriorWork.HumanActor" })
export interface HumanActor extends Schema.Schema.Type<typeof HumanActor> {}

/** Trusted invocation context. Never taken from model input. */
export const Actor = Schema.Union([AgentActor, HumanActor]).annotate({ identifier: "PriorWork.Actor" })
export type Actor = typeof Actor.Type

/** Original observer of an outcome. For live records this is the recorder. */
export const Author = Schema.Struct({
  actor: Schema.Literals(["agent", "human"]),
  agent: optional(Agent.ID),
  name: optional(required(Limits.nameBytes)),
}).annotate({ identifier: "PriorWork.Author" })
export interface Author extends Schema.Schema.Type<typeof Author> {}

export const Source = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("live") }),
  Schema.Struct({ kind: SourceKind, source_id: required(Limits.sourceIDBytes), root_session_id: Session.ID }),
]).annotate({ identifier: "PriorWork.Source" })
export type Source = typeof Source.Type

/** Trusted adoption provenance, supplied by the caller that verified access to the source entry. */
export const AdoptOrigin = Schema.Struct({
  author: Author,
  source: SourceKind,
  source_id: required(Limits.sourceIDBytes),
  root_session_id: Session.ID,
  source_session_id: optional(Session.ID),
  time_observed: NonNegativeInt,
}).annotate({ identifier: "PriorWork.AdoptOrigin" })
export interface AdoptOrigin extends Schema.Schema.Type<typeof AdoptOrigin> {}

/** Upper bound on one stored baseline, independent of the 16 KiB prepared fields. */
export const CAPTURE_BYTES = 32 * 1024

const ObjectID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

/**
 * Result for one original anchor, indexed by position in the recording revision's `locations`.
 * Never repeats the anchor path. A directory's `contains_symlink` is computed from its enumerated
 * subtree; an equal directory containing a link cannot prove its targets unchanged.
 */
export const CaptureAnchor = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("entry"),
    mode: Schema.Literals(["100644", "100755", "120000"]),
    oid: ObjectID,
  }),
  Schema.Struct({ state: Schema.Literal("tree"), oid: ObjectID, contains_symlink: Schema.Boolean }),
  Schema.Struct({ state: Schema.Literal("absent") }),
  Schema.Struct({
    state: Schema.Literal("unknown"),
    reason: Schema.Literals(["noncanonical", "excluded", "symlink_parent", "outside_universe", "indeterminate"]),
  }),
]).annotate({ identifier: "PriorWork.CaptureAnchor" })
export type CaptureAnchor = typeof CaptureAnchor.Type

export const CaptureUnavailableReason = Schema.Literals([
  "disabled",
  "platform",
  "git_capability",
  "identity",
  "lock",
  "timeout",
  "entry_limit",
  "read_limit",
  "output_limit",
  "scratch_limit",
  "race",
  "special_file",
  "unmerged",
  "sparse_checkout",
  "partial_clone",
  "object_format",
  "process",
  "io",
  "metadata_limit",
]).annotate({ identifier: "PriorWork.CaptureUnavailableReason" })
export type CaptureUnavailableReason = typeof CaptureUnavailableReason.Type

/**
 * Versioned whole-repository comparison fingerprint attempted when a live record is first
 * created and carried forward unchanged by every later revision. Raw-byte identifiers are
 * comparison metadata, not file contents, and never prove Git-normalized content or safety.
 */
export const Capture = Schema.Union([
  Schema.Struct({
    scheme: Schema.Literal("fp_v1"),
    capture_revision: Schema.Literal(1),
    status: Schema.Literal("available"),
    object_format: Schema.Literal("sha1"),
    head: optional(Schema.Struct({ commit: ObjectID, tree: ObjectID })),
    root: ObjectID,
    completeness: Schema.Union([
      Schema.Struct({ state: Schema.Literal("complete") }),
      Schema.Struct({
        state: Schema.Literal("partial"),
        reasons: Schema.Array(
          Schema.Literals([
            "oversized",
            "unreadable",
            "path_encoding",
            "gitlink",
            "embedded_repository",
            "symlink_parent",
            "alias",
          ]),
        ).check(Schema.isMaxLength(7)),
        excluded: NonNegativeInt,
        /** At most 8 samples, each at most 1 KiB of JSON-encoded bytes. Oversized samples are omitted. */
        samples: Schema.Array(
          Schema.String.check(Schema.makeFilter((value) => bytes(JSON.stringify(value)) <= 1024)),
        ).check(Schema.isMaxLength(8)),
        omitted: Schema.Boolean,
      }),
    ]),
    anchors: Schema.Array(CaptureAnchor).check(Schema.isMaxLength(Limits.locations)),
  }),
  Schema.Struct({
    scheme: Schema.Literal("fp_v1"),
    capture_revision: Schema.Literal(1),
    status: Schema.Literal("unavailable"),
    reason: CaptureUnavailableReason,
  }),
]).annotate({ identifier: "PriorWork.Capture" })
export type Capture = typeof Capture.Type

/**
 * Whether a recorded revision's original observation context still matches the reader's
 * worktree. `unchanged_since_recording` never means verified, safe, checked at this tree, or a
 * reason to skip investigation.
 */
export const Applicability = Schema.Struct({
  record_id: RecordID,
  revision: PositiveInt,
  status: Schema.Literals(["unchanged_since_recording", "stale", "unknown"]),
  reason: Schema.Literals([
    "no_baseline",
    "baseline_unavailable",
    "current_unavailable",
    "incompatible",
    "partial",
    "record_deleted",
    "root_changed",
    "root_unchanged",
    "anchor_changed",
    "anchor_unknown",
    "anchors_unchanged",
  ]),
}).annotate({ identifier: "PriorWork.Applicability" })
export interface Applicability extends Schema.Schema.Type<typeof Applicability> {}

export const ApplicabilityRequest = Schema.Struct({
  refs: Schema.Array(RevisionRef).check(Schema.isMaxLength(Limits.pageSize)),
}).annotate({ identifier: "PriorWork.ApplicabilityRequest" })
export interface ApplicabilityRequest extends Schema.Schema.Type<typeof ApplicabilityRequest> {}

/** Where the check ran, only as far as the server can prove. Always `unknown` in v1. */
export const Observation = Schema.Struct({
  basis: Schema.Literals(["unknown", "captured"]),
}).annotate({ identifier: "PriorWork.Observation" })
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const RecordedBy = Schema.Struct({
  actor: Schema.Literals(["agent", "human"]),
  session_id: optional(Session.ID),
  agent: optional(Agent.ID),
  name: optional(required(Limits.nameBytes)),
}).annotate({ identifier: "PriorWork.RecordedBy" })
export interface RecordedBy extends Schema.Schema.Type<typeof RecordedBy> {}

export const Revision = Schema.Struct({
  recordID: RecordID,
  revision: PositiveInt,
  summary: Schema.String,
  detail: Schema.String,
  method: Schema.String,
  assumptions: Schema.Array(Assumption),
  locations: Schema.Array(Location),
  evidence: Schema.Array(Evidence),
  challenges: optional(Challenges),
  derivedFrom: Schema.Array(RevisionRef),
  recordingCapture: optional(Capture),
  observation: Observation,
  recordedBy: RecordedBy,
  timeRecorded: NonNegativeInt,
}).annotate({ identifier: "PriorWork.Revision" })
export interface Revision extends Schema.Schema.Type<typeof Revision> {}

/** Metadata and head summary. `summary` is absent once a record is deleted. */
export const Summary = Schema.Struct({
  id: RecordID,
  repositoryID: RepositoryID,
  kind: Kind,
  state: State,
  headRevision: PositiveInt,
  summary: optional(Schema.String),
  author: Author,
  source: Source,
  sourceSessionID: optional(Session.ID),
  timeObserved: NonNegativeInt,
  timeCreated: NonNegativeInt,
}).annotate({ identifier: "PriorWork.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const Detail = Schema.Struct({
  record: Summary,
  revision: optional(Revision),
}).annotate({ identifier: "PriorWork.Detail" })
export interface Detail extends Schema.Schema.Type<typeof Detail> {}

export const Written = Schema.Struct({
  id: RecordID,
  revision: PositiveInt,
  /** True when an exact retry of an idempotent request returned the original result. */
  replayed: Schema.Boolean,
}).annotate({ identifier: "PriorWork.Written" })
export interface Written extends Schema.Schema.Type<typeof Written> {}

const Key = required(Limits.keyBytes)

/**
 * Create a record, or, with `target`, write a new revision of one whose current head is
 * `target.head` (compare-and-swap). `key` makes the request idempotent for the calling Session.
 */
export const RecordRequest = Schema.Struct({
  key: optional(Key),
  target: optional(Schema.Struct({ id: RecordID, head: PositiveInt })),
  prepared: Prepared,
}).annotate({ identifier: "PriorWork.RecordRequest" })
export interface RecordRequest extends Schema.Schema.Type<typeof RecordRequest> {}

/** Create a record from a historical entry the trusted caller has verified access to. */
export const AdoptRequest = Schema.Struct({
  key: optional(Key),
  origin: AdoptOrigin,
  prepared: Prepared,
}).annotate({ identifier: "PriorWork.AdoptRequest" })
export interface AdoptRequest extends Schema.Schema.Type<typeof AdoptRequest> {}

export const RetractRequest = Schema.Struct({
  id: RecordID,
  reason: required(Limits.reasonBytes),
}).annotate({ identifier: "PriorWork.RetractRequest" })
export interface RetractRequest extends Schema.Schema.Type<typeof RetractRequest> {}

export const GetRequest = Schema.Struct({
  id: RecordID,
  revision: optional(PositiveInt),
}).annotate({ identifier: "PriorWork.GetRequest" })
export interface GetRequest extends Schema.Schema.Type<typeof GetRequest> {}

export const SearchInput = Schema.Struct({
  kind: optional(Kind),
  /** Repository-relative path or directory prefix matched against record locations. */
  path: optional(required(Limits.pathBytes)),
  author: optional(
    Schema.Struct({
      actor: optional(Schema.Literals(["agent", "human"])),
      agent: optional(Agent.ID),
      name: optional(required(Limits.nameBytes)),
    }),
  ),
  text: optional(required(Limits.searchTextBytes)),
  limit: optional(PositiveInt.check(Schema.isLessThanOrEqualTo(Limits.pageSize))),
  cursor: optional(RecordID),
}).annotate({ identifier: "PriorWork.SearchInput" })
export interface SearchInput extends Schema.Schema.Type<typeof SearchInput> {}

export const Page = Schema.Struct({
  items: Schema.Array(Summary),
  cursor: optional(RecordID),
}).annotate({ identifier: "PriorWork.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

/**
 * Rejected input. Content-free by construction: a fixed reason plus schema key paths, never a
 * submitted value or a submitted object key.
 */
export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("PriorWork.InvalidInput", {
  reason: Schema.Literals(["placeholder", "too_large", "malformed"]),
  paths: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Prior work input rejected (${this.reason})${this.paths.length ? ` at ${this.paths.join(", ")}` : ""}`
  }
}

/** Content-free: names the request key whose reference was not found, not the submitted ID. */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("PriorWork.NotFound", {
  path: Schema.String,
}) {
  override get message() {
    return `Prior work reference not found at ${this.path}`
  }
}

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("PriorWork.Conflict", {
  reason: Schema.Literals([
    "stale_head",
    "idempotency_mismatch",
    "already_adopted",
    "record_not_active",
    "repository_changed",
  ]),
}) {
  override get message() {
    return `Prior work conflict (${this.reason})`
  }
}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()("PriorWork.Forbidden", {
  reason: Schema.Literals(["not_recorder", "human_only", "kind_immutable"]),
}) {
  override get message() {
    return `Prior work action refused (${this.reason})`
  }
}

/**
 * The Location cannot hold prior work: the global non-Git project, a non-Git directory, or a
 * repository whose common directory reports no stable filesystem incarnation.
 */
export class Unsupported extends Schema.TaggedErrorClass<Unsupported>()("PriorWork.Unsupported", {
  reason: Schema.Literals(["global_project", "not_git", "unbound"]),
}) {
  override get message() {
    return `Prior work is unavailable for this location (${this.reason})`
  }
}

export type Failure = InvalidInput | NotFound | Conflict | Forbidden | Unsupported
