export * as Memory from "./memory"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { optional, statics } from "./schema"

export const MAX_TITLE_LENGTH = 512
export const MAX_BODY_BYTES = 256_000
export const MAX_NAME_LENGTH = 256
export const MAX_SLUG_LENGTH = 128
export const MAX_PATH_LENGTH = 4_096
export const MAX_SYMBOL_LENGTH = 512
export const MAX_SEARCH_LENGTH = 32_000
export const MAX_SEARCH_TERMS = 512
export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 200

export const WingID = Schema.String.check(Schema.isStartsWith("wng_")).pipe(
  Schema.brand("Memory.WingID"),
  statics((schema) => ({ create: () => schema.make(`wng_${ascending()}`) })),
)
export type WingID = typeof WingID.Type

export const RoomID = Schema.String.check(Schema.isStartsWith("rom_")).pipe(
  Schema.brand("Memory.RoomID"),
  statics((schema) => ({ create: () => schema.make(`rom_${ascending()}`) })),
)
export type RoomID = typeof RoomID.Type

export const DrawerID = Schema.String.check(Schema.isStartsWith("drw_")).pipe(
  Schema.brand("Memory.DrawerID"),
  statics((schema) => ({ create: () => schema.make(`drw_${ascending()}`) })),
)
export type DrawerID = typeof DrawerID.Type

export const WingKind = Schema.Literals(["project", "person", "engagement"])
export type WingKind = typeof WingKind.Type

export const DrawerKind = Schema.Literals(["note", "fact", "decision", "observation"])
export type DrawerKind = typeof DrawerKind.Type

export const Source = Schema.Literals(["agent", "human", "import"])
export type Source = typeof Source.Type

const Title = Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH))
const Body = Schema.String.check(Schema.isMaxLength(MAX_BODY_BYTES))
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NAME_LENGTH))
const Slug = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SLUG_LENGTH))

export const Anchor = Schema.Struct({
  repo: Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH)).pipe(optional),
  path: Schema.String.check(Schema.isMaxLength(MAX_PATH_LENGTH)).pipe(optional),
  commit: Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH)).pipe(optional),
  symbol: Schema.String.check(Schema.isMaxLength(MAX_SYMBOL_LENGTH)).pipe(optional),
})
export type Anchor = typeof Anchor.Type

export const Provenance = Schema.Struct({
  assertedBy: Name,
  source: Source,
  sessionID: Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH)).pipe(optional),
  commit: Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH)).pipe(optional),
})
export type Provenance = typeof Provenance.Type

export const Wing = Schema.Struct({
  id: WingID,
  kind: WingKind,
  key: Name,
  name: Name,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "Memory.Wing" })
export type Wing = typeof Wing.Type

export const Room = Schema.Struct({
  id: RoomID,
  wingID: WingID,
  slug: Slug,
  name: Name,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "Memory.Room" })
export type Room = typeof Room.Type

export const Drawer = Schema.Struct({
  id: DrawerID,
  wingID: WingID,
  roomID: RoomID,
  kind: DrawerKind,
  title: Title,
  body: Body,
  anchor: Anchor,
  provenance: Provenance,
  timeValidFrom: Schema.Number,
  timeValidUntil: Schema.Number.pipe(optional),
  supersededBy: DrawerID.pipe(optional),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "Memory.Drawer" })
export type Drawer = typeof Drawer.Type

export const Result = Schema.Struct({
  drawer: Drawer,
  /** Higher is better. TurenOS negates FTS5's lower-is-better BM25 value. */
  score: Schema.Number,
}).annotate({ identifier: "Memory.Result" })
export type Result = typeof Result.Type

export const WingInput = Schema.Struct({
  kind: WingKind,
  key: Name,
  name: Name,
})

export const RoomInput = Schema.Struct({
  wingID: WingID,
  slug: Slug,
  name: Name,
})

export const DrawerInput = Schema.Struct({
  wingID: WingID,
  roomID: RoomID,
  kind: DrawerKind,
  title: Title,
  body: Body,
  anchor: Anchor.pipe(optional),
  validFrom: Schema.Number.pipe(optional),
  supersedes: DrawerID.pipe(optional),
})

export const DrawerUpdate = Schema.Struct({
  expectedTimeUpdated: Schema.Number,
  wingID: WingID,
  roomID: RoomID,
  kind: DrawerKind,
  title: Title,
  body: Body,
  anchor: Anchor.pipe(optional),
})
