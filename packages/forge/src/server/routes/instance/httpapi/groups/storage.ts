import { Storage } from "@turenlabs/core/storage"
import { NonNegativeInt } from "@turenlabs/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { described } from "./metadata"

export const MAX_STORAGE_SCOPE_LENGTH = 256
export const MAX_STORAGE_KEY_LENGTH = 512
export const MAX_STORAGE_VALUE_LENGTH = 1024 * 1024
export const MAX_STORAGE_IMPORT_ENTRIES = 10_000
export const MAX_STORAGE_IMPORT_BYTES = 256 * 1024 * 1024
export const MAX_STORAGE_REPLACE_ENTRIES = 10_000
export const MAX_STORAGE_REPLACE_BYTES = 256 * 1024 * 1024
export const MAX_STORAGE_BATCH_ENTRIES = 20_005
export const MAX_STORAGE_BATCH_BYTES = 2 * 1024 * 1024
export const STORAGE_PUBLIC_SCOPE_PREFIXES = ["desktop/store/"] as const
export const STORAGE_PUBLIC_MIGRATION_PREFIXES = ["desktop.electron-store.", "desktop.legacy."] as const

const StorageScope = Storage.Scope.check(
  Schema.isPattern(/^desktop\/store\//),
  Schema.isMaxLength(MAX_STORAGE_SCOPE_LENGTH),
)
const StorageKey = Storage.Key.check(Schema.isMaxLength(MAX_STORAGE_KEY_LENGTH))
const StorageValue = Schema.String.check(Schema.isMaxLength(MAX_STORAGE_VALUE_LENGTH))
const MigrationName = Schema.NonEmptyString.check(
  Schema.isPattern(/^desktop\.(?:electron-store|legacy)\./),
  Schema.isMaxLength(256),
)
const SourceFingerprint = Schema.NonEmptyString.check(Schema.isMaxLength(256))
const SourceVersion = Schema.NonEmptyString.check(Schema.isMaxLength(128))

const StorageAddressQuery = Schema.Struct({
  scope: StorageScope,
  key: StorageKey,
}).annotate({ identifier: "StorageAddressQuery" })

const StorageRemoveQuery = Schema.Struct({
  scope: StorageScope,
  key: StorageKey,
  expectedRevision: Schema.NumberFromString.pipe(Schema.decodeTo(Storage.Revision), Schema.optional),
}).annotate({ identifier: "StorageRemoveQuery" })

const StorageScopeQuery = Schema.Struct({
  scope: StorageScope,
}).annotate({ identifier: "StorageScopeQuery" })

const StorageReceiptQuery = Schema.Struct({
  name: MigrationName,
}).annotate({ identifier: "StorageReceiptQuery" })

export const StorageSetInput = Schema.Struct({
  scope: StorageScope,
  key: StorageKey,
  value: StorageValue,
  expectedRevision: Schema.optional(Schema.NullOr(Storage.Revision)),
}).annotate({ identifier: "StorageSetInput" })

export const StorageImportEntry = Schema.Struct({
  scope: StorageScope,
  key: StorageKey,
  value: StorageValue,
}).annotate({ identifier: "StorageImportEntry" })

export const StorageImportInput = Schema.Struct({
  name: MigrationName,
  sourceFingerprint: SourceFingerprint,
  sourceVersion: SourceVersion,
  entries: Schema.Array(StorageImportEntry).check(Schema.isMaxLength(MAX_STORAGE_IMPORT_ENTRIES)),
}).annotate({ identifier: "StorageImportInput" })

export const StorageReplaceEntry = Schema.Struct({
  key: StorageKey,
  value: StorageValue,
}).annotate({ identifier: "StorageReplaceEntry" })

export const StorageReplaceInput = Schema.Struct({
  scope: StorageScope,
  entries: Schema.Array(StorageReplaceEntry).check(Schema.isMaxLength(MAX_STORAGE_REPLACE_ENTRIES)),
}).annotate({ identifier: "StorageReplaceInput" })

export const StorageGuardedBatchInput = Schema.Struct({
  guards: Schema.Array(
    Schema.Struct({
      scope: StorageScope,
      key: StorageKey,
      expectedRevision: Schema.NullOr(Storage.Revision),
    }),
  ).check(Schema.isMaxLength(MAX_STORAGE_BATCH_ENTRIES)),
  sets: Schema.Array(
    Schema.Struct({
      scope: StorageScope,
      key: StorageKey,
      value: StorageValue,
    }),
  ).check(Schema.isMaxLength(MAX_STORAGE_BATCH_ENTRIES)),
  removes: Schema.Array(Schema.Struct({ scope: StorageScope, key: StorageKey })).check(
    Schema.isMaxLength(MAX_STORAGE_BATCH_ENTRIES),
  ),
}).annotate({ identifier: "StorageGuardedBatchInput" })

const StorageGetResult = Schema.Struct({
  state: Schema.NullOr(Storage.State),
}).annotate({ identifier: "StorageGetResult" })

const StorageListResult = Schema.Struct({
  items: Schema.Array(Storage.State),
}).annotate({ identifier: "StorageListResult" })

const StorageRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
}).annotate({ identifier: "StorageRemoveResult" })

const StorageClearResult = Schema.Struct({
  removed: NonNegativeInt,
}).annotate({ identifier: "StorageClearResult" })

const StorageReplaceResult = Schema.Struct({
  written: NonNegativeInt,
}).annotate({ identifier: "StorageReplaceResult" })

const StorageReceiptResult = Schema.Struct({
  receipt: Schema.NullOr(Storage.MigrationReceipt),
}).annotate({ identifier: "StorageReceiptResult" })

export class StorageRevisionConflictError extends Schema.TaggedErrorClass<StorageRevisionConflictError>()(
  "StorageRevisionConflictError",
  {
    scope: StorageScope,
    key: StorageKey,
    expected: Schema.NullOr(Storage.Revision),
    actual: Schema.NullOr(Storage.Revision),
  },
  { httpApiStatus: 409 },
) {}

export class StorageMigrationConflictError extends Schema.TaggedErrorClass<StorageMigrationConflictError>()(
  "StorageMigrationConflictError",
  { name: MigrationName },
  { httpApiStatus: 409 },
) {}

export const StoragePaths = {
  state: "/global/storage",
  list: "/global/storage/list",
  scope: "/global/storage/scope",
  batch: "/global/storage/batch",
  receipt: "/global/storage/import/receipt",
  import: "/global/storage/import",
} as const

export const StorageApi = HttpApi.make("storage").add(
  HttpApiGroup.make("storage")
    .add(
      HttpApiEndpoint.get("get", StoragePaths.state, {
        query: StorageAddressQuery,
        success: described(StorageGetResult, "Stored state, or null when the key is absent"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.get",
          summary: "Get stored state",
          description: "Read one public client-state value and its revision.",
        }),
      ),
      HttpApiEndpoint.get("list", StoragePaths.list, {
        query: StorageScopeQuery,
        success: described(StorageListResult, "Stored states in stable key order"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.list",
          summary: "List stored state",
          description: "List all public client-state values in one scope.",
        }),
      ),
      HttpApiEndpoint.put("set", StoragePaths.state, {
        payload: StorageSetInput,
        success: described(Storage.State, "Stored state after the write"),
        error: [InvalidRequestError, StorageRevisionConflictError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.set",
          summary: "Set stored state",
          description:
            "Write one public client-state value. Omit expectedRevision for an unconditional write, use null for create-only, or provide a revision for compare-and-swap.",
        }),
      ),
      HttpApiEndpoint.delete("remove", StoragePaths.state, {
        query: StorageRemoveQuery,
        success: described(StorageRemoveResult, "Whether the stored key was removed"),
        error: StorageRevisionConflictError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.remove",
          summary: "Remove stored state",
          description: "Remove one public client-state value, optionally guarded by its expected revision.",
        }),
      ),
      HttpApiEndpoint.put("replace", StoragePaths.scope, {
        payload: StorageReplaceInput,
        success: described(StorageReplaceResult, "Number of stored keys written"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.replace",
          summary: "Replace a stored scope",
          description: "Atomically replace every value in one public client-state scope with a bounded batch.",
        }),
      ),
      HttpApiEndpoint.post("guardedBatch", StoragePaths.batch, {
        payload: StorageGuardedBatchInput,
        success: described(StorageReplaceResult, "Number of stored keys changed"),
        error: [InvalidRequestError, StorageRevisionConflictError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.guardedBatch",
          summary: "Apply a guarded storage batch",
          description:
            "Atomically apply a bounded set/remove batch only when every guarded value still has its expected revision.",
        }),
      ),
      HttpApiEndpoint.delete("clear", StoragePaths.scope, {
        query: StorageScopeQuery,
        success: described(StorageClearResult, "Number of stored keys removed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.clear",
          summary: "Clear stored state",
          description: "Remove every public client-state value in one scope.",
        }),
      ),
      HttpApiEndpoint.get("receipt", StoragePaths.receipt, {
        query: StorageReceiptQuery,
        success: described(StorageReceiptResult, "Legacy import receipt, or null when not imported"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.receipt",
          summary: "Get an import receipt",
          description: "Check whether a named legacy storage source has already been imported.",
        }),
      ),
      HttpApiEndpoint.post("import", StoragePaths.import, {
        payload: StorageImportInput,
        success: described(Storage.ImportResult, "Atomic legacy import result"),
        error: [InvalidRequestError, StorageMigrationConflictError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "storage.import",
          summary: "Import legacy storage",
          description:
            "Atomically import a bounded legacy key batch and its receipt. Existing destination values remain authoritative.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "storage", description: "Root-scoped public client-state routes." })),
)
