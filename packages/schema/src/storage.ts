export * as Storage from "./storage"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

export const Scope = Schema.NonEmptyString.pipe(Schema.brand("Storage.Scope"))
export type Scope = typeof Scope.Type

export const Key = Schema.NonEmptyString.pipe(Schema.brand("Storage.Key"))
export type Key = typeof Key.Type

export const Revision = NonNegativeInt
export type Revision = typeof Revision.Type

export const Address = Schema.Struct({
  scope: Scope,
  key: Key,
}).annotate({ identifier: "Storage.Address" })
export type Address = typeof Address.Type

export const State = Schema.Struct({
  scope: Scope,
  key: Key,
  value: Schema.String,
  revision: Revision,
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
}).annotate({ identifier: "Storage.State" })
export type State = typeof State.Type

export const ListInput = Schema.Struct({
  scope: Scope,
}).annotate({ identifier: "Storage.ListInput" })
export type ListInput = typeof ListInput.Type

export const SetInput = Schema.Struct({
  scope: Scope,
  key: Key,
  value: Schema.String,
}).annotate({ identifier: "Storage.SetInput" })
export type SetInput = typeof SetInput.Type

export const CompareAndSwapInput = Schema.Struct({
  scope: Scope,
  key: Key,
  value: Schema.String,
  expectedRevision: Schema.NullOr(Revision),
}).annotate({ identifier: "Storage.CompareAndSwapInput" })
export type CompareAndSwapInput = typeof CompareAndSwapInput.Type

export class RevisionConflict extends Schema.TaggedErrorClass<RevisionConflict>()("Storage.RevisionConflict", {
  scope: Scope,
  key: Key,
  expected: Schema.NullOr(Revision),
  actual: Schema.NullOr(Revision),
}) {
  override get message() {
    return `Storage revision conflict for ${this.scope}/${this.key}: expected ${this.expected}, actual ${this.actual}`
  }
}

export const MigrationReceipt = Schema.Struct({
  name: Schema.NonEmptyString,
  sourceFingerprint: Schema.NullOr(Schema.String),
  sourceVersion: Schema.NullOr(Schema.String),
  rowCount: Schema.NullOr(NonNegativeInt),
  timeCompleted: NonNegativeInt,
  timeVerified: Schema.NullOr(NonNegativeInt),
}).annotate({ identifier: "Storage.MigrationReceipt" })
export type MigrationReceipt = typeof MigrationReceipt.Type

export const ImportInput = Schema.Struct({
  name: Schema.NonEmptyString,
  sourceFingerprint: Schema.String,
  sourceVersion: Schema.String,
}).annotate({ identifier: "Storage.ImportInput" })
export type ImportInput = typeof ImportInput.Type

export const ImportResult = Schema.Struct({
  applied: Schema.Boolean,
  receipt: MigrationReceipt,
}).annotate({ identifier: "Storage.ImportResult" })
export type ImportResult = typeof ImportResult.Type

export class MigrationConflict extends Schema.TaggedErrorClass<MigrationConflict>()("Storage.MigrationConflict", {
  name: Schema.NonEmptyString,
  recordedFingerprint: Schema.NullOr(Schema.String),
  recordedVersion: Schema.NullOr(Schema.String),
  attemptedFingerprint: Schema.String,
  attemptedVersion: Schema.String,
}) {
  override get message() {
    return `Storage migration ${this.name} was already completed from a different source`
  }
}
