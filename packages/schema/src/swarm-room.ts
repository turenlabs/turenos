export * as SwarmRoom from "./swarm-room"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Event } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { Session } from "./session"
import { SessionTask } from "./session-task"

export const postToolName = "room_post"
export const readToolName = "room_read"
export const claimToolName = "room_claim"
export const waitToolName = "room_wait"
export const toolActions = [postToolName, readToolName, claimToolName, waitToolName] as const

const bounded = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const boundedNonEmpty = (maximum: number) => Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(maximum)))
const brandID = <B extends string>(brand: B) => boundedNonEmpty(80).pipe(Schema.brand(brand))

export const MAX_ENTRIES_PER_READ = 100
export const MAX_EVIDENCE_REFS = 16
export const MAX_EVIDENCE_REF_LENGTH = 512
export const MAX_LANES = 64
export const MAX_TEXT_LENGTH = 131_072

const text = boundedNonEmpty(MAX_TEXT_LENGTH)
const title = boundedNonEmpty(256)
const name = boundedNonEmpty(120)

export const ID = brandID("SwarmRoom.ID").pipe(
  statics((schema) => ({ create: () => schema.make("srm_" + ascending()) })),
)
export type ID = typeof ID.Type

/** One durable row in the room stream — a message or a typed coordination record. */
export const EntryID = brandID("SwarmRoom.EntryID").pipe(
  statics((schema) => ({ create: () => schema.make("sre_" + ascending()) })),
)
export type EntryID = typeof EntryID.Type

/** Agent members reuse their Session ID; only humans get a generated `smb_` identity. */
export const MemberID = brandID("SwarmRoom.MemberID").pipe(
  statics((schema) => ({ create: () => schema.make("smb_" + ascending()) })),
)
export type MemberID = typeof MemberID.Type

export const LaneKey = boundedNonEmpty(128).pipe(Schema.brand("SwarmRoom.LaneKey"))
export type LaneKey = typeof LaneKey.Type

/**
 * `message` is untyped chatter; the rest are coordination records. `plan`, `claim`,
 * `release`, and `decision` are what make the room a shared state machine rather
 * than a log: lanes come from `plan` payloads, ownership from `claim`/`release`.
 */
export const Kind = Schema.Literals([
  "message",
  "plan",
  "claim",
  "release",
  "decision",
  "finding",
  "correction",
  "lead",
  "status",
  "question",
])
export type Kind = typeof Kind.Type

/** Kinds that carry coordination authority and must pass a head CAS check. */
export const coordinationKinds = ["plan", "claim", "release", "decision", "correction"] as const

export const ActorType = Schema.Literals(["leader", "worker", "human", "system"])
export type ActorType = typeof ActorType.Type

/** Snapshot of who posted, recorded on the entry so membership can change later. */
export const Actor = Schema.Struct({
  type: ActorType,
  memberID: MemberID,
  sessionID: Session.ID.pipe(optional),
  agent: Agent.ID.pipe(optional),
  name,
}).annotate({ identifier: "SwarmRoom.Actor" })
export interface Actor extends Schema.Schema.Type<typeof Actor> {}

/** One lane in a `plan` payload. `key` is the stable identity `claim` entries reference. */
export const Lane = Schema.Struct({
  key: LaneKey,
  title: title,
  detail: text.pipe(optional),
}).annotate({ identifier: "SwarmRoom.Lane" })
export interface Lane extends Schema.Schema.Type<typeof Lane> {}

export const PlanPayload = Schema.Struct({
  objective: text.pipe(optional),
  lanes: Schema.Array(Lane).pipe(Schema.check(Schema.isMaxLength(MAX_LANES))),
}).annotate({ identifier: "SwarmRoom.PlanPayload" })
export interface PlanPayload extends Schema.Schema.Type<typeof PlanPayload> {}

export const ClaimPayload = Schema.Struct({
  lane: LaneKey,
}).annotate({ identifier: "SwarmRoom.ClaimPayload" })

export const RoomStatus = Schema.Literals(["open", "closed"])

export const Info = Schema.Struct({
  id: ID,
  rootSessionID: Session.ID,
  objective: Schema.String,
  budget: NonNegativeInt,
  explicitBudget: Schema.Boolean,
  /** Monotonic head — both the CAS target and the "read after seq" cursor. */
  head: NonNegativeInt,
  status: RoomStatus,
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
}).annotate({ identifier: "SwarmRoom.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Entry = Schema.Struct({
  id: EntryID,
  roomID: ID,
  seq: PositiveInt,
  actor: Actor,
  kind: Kind,
  text: text,
  payload: Schema.Json.pipe(optional),
  replyTo: EntryID.pipe(optional),
  evidenceRefs: Schema.Array(bounded(MAX_EVIDENCE_REF_LENGTH)).pipe(
    Schema.check(Schema.isMaxLength(MAX_EVIDENCE_REFS)),
    optional,
  ),
  baseRevision: NonNegativeInt,
  timeCreated: NonNegativeInt,
}).annotate({ identifier: "SwarmRoom.Entry" })
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

export const MemberState = Schema.Literals(["active", "parked", "settled", "blocked", "left"])

/**
 * Agent members are derived from the session task graph (leader = root session,
 * worker = task-owned child); only humans and system markers are durable rows.
 */
export const Member = Schema.Struct({
  id: MemberID,
  roomID: ID,
  type: ActorType,
  sessionID: Session.ID.pipe(optional),
  taskID: SessionTask.ID.pipe(optional),
  agent: Agent.ID.pipe(optional),
  name,
  state: MemberState,
  joinedAt: NonNegativeInt,
}).annotate({ identifier: "SwarmRoom.Member" })
export interface Member extends Schema.Schema.Type<typeof Member> {}

export const LaneStatus = Schema.Literals(["open", "claimed", "done", "blocked"])

/** Projected from the entry stream: latest plan defines lanes, latest claim/release/status sets each lane's state. */
export const LaneState = Schema.Struct({
  key: LaneKey,
  title: Schema.String,
  detail: Schema.String.pipe(optional),
  status: LaneStatus,
  claimedBy: MemberID.pipe(optional),
  claimedByName: Schema.String.pipe(optional),
  updatedSeq: NonNegativeInt,
}).annotate({ identifier: "SwarmRoom.LaneState" })
export interface LaneState extends Schema.Schema.Type<typeof LaneState> {}

export const State = Schema.Struct({
  room: Info,
  members: Schema.Array(Member),
  lanes: Schema.Array(LaneState),
}).annotate({ identifier: "SwarmRoom.State" })
export interface State extends Schema.Schema.Type<typeof State> {}

export const EntryPage = Schema.Struct({
  entries: Schema.Array(Entry),
  head: NonNegativeInt,
  hasMore: Schema.Boolean,
}).annotate({ identifier: "SwarmRoom.EntryPage" })
export interface EntryPage extends Schema.Schema.Type<typeof EntryPage> {}

export const PostInput = Schema.Struct({
  kind: Kind.pipe(optional),
  text: text.annotate({ description: "Entry text; for coordination kinds, a one-line summary" }),
  payload: Schema.Json.pipe(optional),
  replyTo: EntryID.pipe(optional),
  to: name.pipe(optional).annotate({
    description: "Address a lane key or member name — advisories flag the entry for that member",
  }),
  evidenceRefs: Schema.Array(bounded(MAX_EVIDENCE_REF_LENGTH)).pipe(
    Schema.check(Schema.isMaxLength(MAX_EVIDENCE_REFS)),
    optional,
  ),
  baseRevision: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SwarmRoom.PostInput" })
export interface PostInput extends Schema.Schema.Type<typeof PostInput> {}

export const ClaimInput = Schema.Struct({
  lane: LaneKey,
  baseRevision: NonNegativeInt,
}).annotate({ identifier: "SwarmRoom.ClaimInput" })
export interface ClaimInput extends Schema.Schema.Type<typeof ClaimInput> {}

export const HumanPostInput = Schema.Struct({
  text: text,
  name: name.pipe(optional),
  replyTo: EntryID.pipe(optional),
}).annotate({ identifier: "SwarmRoom.HumanPostInput" })
export interface HumanPostInput extends Schema.Schema.Type<typeof HumanPostInput> {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "SwarmRoomNotFoundError",
  { resource: Schema.String },
  { httpApiStatus: 404 },
) {}
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "SwarmRoomConflictError",
  { message: Schema.String, head: NonNegativeInt },
  { httpApiStatus: 409 },
) {}
export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()(
  "SwarmRoomInvalidStateError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
  "SwarmRoomForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}
export type Failure = NotFoundError | ConflictError | InvalidStateError | ForbiddenError

export const Posted = Event.define({
  type: "swarm.room.posted",
  schema: { roomID: ID, rootSessionID: Session.ID, entry: Entry },
})
export const Connected = Event.define({
  type: "swarm.room.connected",
  schema: { roomID: ID, rootSessionID: Session.ID, head: NonNegativeInt },
})
export const Events = Schema.Union([Posted, Connected]).annotate({ identifier: "SwarmRoom.Events" })
export const Definitions = Event.inventory(Posted, Connected)
