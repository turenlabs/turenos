export * as Whiteboard from "./whiteboard"

import { Schema } from "effect"
import { Event } from "./event"
import { NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"

const Identity = Schema.NonEmptyString.check(Schema.isMaxLength(128))
export const Element = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "Whiteboard.Element" })
export type Element = typeof Element.Type
export const File = Schema.Struct({
  id: Identity,
  mimeType: Schema.String,
  dataURL: Schema.String,
  created: Schema.Number,
  lastRetrieved: optional(Schema.Number),
}).annotate({ identifier: "Whiteboard.File" })
export interface File extends Schema.Schema.Type<typeof File> {}
export const Snapshot = Schema.Struct({
  sessionID: SessionID,
  revision: NonNegativeInt,
  elements: Schema.Array(Element),
  files: Schema.Record(Schema.String, File),
  updatedAt: Schema.Number,
}).annotate({ identifier: "Whiteboard.Snapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Patch = Schema.Struct({
  elements: Schema.Array(Element),
  files: optional(Schema.Record(Schema.String, File)),
  baseRevision: optional(NonNegativeInt),
}).annotate({ identifier: "Whiteboard.Patch" })
export interface Patch extends Schema.Schema.Type<typeof Patch> {}
export const Actor = Schema.Struct({
  id: Identity,
  name: Identity,
  kind: Schema.Literals(["human", "agent"]),
}).annotate({ identifier: "Whiteboard.Actor" })
export interface Actor extends Schema.Schema.Type<typeof Actor> {}
export const PresenceInput = Schema.Struct({
  clientID: Identity,
  username: Identity,
  pointer: optional(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  selectedElementIds: optional(Schema.Array(Identity).check(Schema.isMaxLength(5000))),
}).annotate({ identifier: "Whiteboard.PresenceInput" })
export interface PresenceInput extends Schema.Schema.Type<typeof PresenceInput> {}
export const Participant = Schema.Struct({ ...PresenceInput.fields, updatedAt: Schema.Number }).annotate({
  identifier: "Whiteboard.Participant",
})
export interface Participant extends Schema.Schema.Type<typeof Participant> {}
export const PresenceSnapshot = Schema.Struct({ participants: Schema.Array(Participant) }).annotate({
  identifier: "Whiteboard.PresenceSnapshot",
})
export interface PresenceSnapshot extends Schema.Schema.Type<typeof PresenceSnapshot> {}
export const UpdateRequest = Schema.Struct({ patch: Patch, clientID: Identity, username: Identity }).annotate({
  identifier: "Whiteboard.UpdateRequest",
})
export interface UpdateRequest extends Schema.Schema.Type<typeof UpdateRequest> {}
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "WhiteboardNotFoundError",
  { sessionID: SessionID },
  { httpApiStatus: 404 },
) {}
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "WhiteboardValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "WhiteboardConflictError",
  { sessionID: SessionID, expectedRevision: NonNegativeInt, actualRevision: NonNegativeInt, message: Schema.String },
  { httpApiStatus: 409 },
) {}
export const Updated = Event.define({
  type: "session.whiteboard.updated",
  durable: { version: 1, aggregate: "sessionID" },
  schema: { sessionID: SessionID, revision: NonNegativeInt, actor: Actor },
})
export const Presence = Event.define({
  type: "session.whiteboard.presence",
  schema: { sessionID: SessionID, ...PresenceSnapshot.fields },
})
export const Connected = Event.define({
  type: "session.whiteboard.connected",
  schema: { sessionID: SessionID, revision: NonNegativeInt },
})
export const Events = Schema.Union([Updated, Presence, Connected]).annotate({ identifier: "Whiteboard.Events" })
export const Definitions = Event.inventory(Updated, Presence, Connected)
