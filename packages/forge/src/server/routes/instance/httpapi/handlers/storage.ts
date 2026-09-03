import { Storage } from "@turenlabs/core/storage"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { InvalidRequestError } from "../errors"
import {
  MAX_STORAGE_BATCH_BYTES,
  MAX_STORAGE_BATCH_ENTRIES,
  MAX_STORAGE_IMPORT_BYTES,
  MAX_STORAGE_REPLACE_BYTES,
  MAX_STORAGE_VALUE_LENGTH,
  StorageMigrationConflictError,
  StorageRevisionConflictError,
} from "../groups/storage"

export const storageHandlers = HttpApiBuilder.group(RootHttpApi, "storage", (handlers) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service

    return handlers
      .handle("get", (ctx) => storage.get(ctx.query).pipe(Effect.map((state) => ({ state: state ?? null }))))
      .handle("list", (ctx) => storage.list(ctx.query).pipe(Effect.map((items) => ({ items }))))
      .handle("set", (ctx) => {
        if (new TextEncoder().encode(ctx.payload.value).byteLength > MAX_STORAGE_VALUE_LENGTH) {
          return new InvalidRequestError({
            message: `storage value exceeds ${MAX_STORAGE_VALUE_LENGTH} bytes`,
            field: "value",
          })
        }
        if (!("expectedRevision" in ctx.payload)) return storage.set(ctx.payload)
        return storage
          .compareAndSwap({
            scope: ctx.payload.scope,
            key: ctx.payload.key,
            value: ctx.payload.value,
            expectedRevision: ctx.payload.expectedRevision ?? null,
          })
          .pipe(
            Effect.catchTag(
              "Storage.RevisionConflict",
              (error) =>
                new StorageRevisionConflictError({
                  scope: error.scope,
                  key: error.key,
                  expected: error.expected,
                  actual: error.actual,
                }),
            ),
          )
      })
      .handle("remove", (ctx) => {
        if (ctx.query.expectedRevision === undefined) {
          return storage.remove(ctx.query).pipe(Effect.map((removed) => ({ removed })))
        }
        return storage
          .removeIfRevision({
            scope: ctx.query.scope,
            key: ctx.query.key,
            expectedRevision: ctx.query.expectedRevision,
          })
          .pipe(
            Effect.map((removed) => ({ removed })),
            Effect.catchTag(
              "Storage.RevisionConflict",
              (error) =>
                new StorageRevisionConflictError({
                  scope: error.scope,
                  key: error.key,
                  expected: error.expected,
                  actual: error.actual,
                }),
            ),
          )
      })
      .handle("replace", (ctx) => {
        const keys = new Set(ctx.payload.entries.map((entry) => entry.key))
        if (keys.size !== ctx.payload.entries.length) {
          return new InvalidRequestError({
            message: "storage scope replacement contains duplicate keys",
            field: "entries",
          })
        }
        const byteLengths = ctx.payload.entries.map((entry) => new TextEncoder().encode(entry.value).byteLength)
        if (byteLengths.some((bytes) => bytes > MAX_STORAGE_VALUE_LENGTH)) {
          return new InvalidRequestError({
            message: `storage scope replacement contains a value exceeding ${MAX_STORAGE_VALUE_LENGTH} bytes`,
            field: "entries",
          })
        }
        const bytes = byteLengths.reduce((total, length) => total + length, 0)
        if (bytes > MAX_STORAGE_REPLACE_BYTES) {
          return new InvalidRequestError({
            message: `storage scope replacement values exceed ${MAX_STORAGE_REPLACE_BYTES} bytes`,
            field: "entries",
          })
        }
        return storage.replace(ctx.payload).pipe(Effect.map((written) => ({ written })))
      })
      .handle("guardedBatch", (ctx) => {
        const mutations = [
          ...ctx.payload.sets.map((entry) => JSON.stringify([entry.scope, entry.key])),
          ...ctx.payload.removes.map((entry) => JSON.stringify([entry.scope, entry.key])),
        ]
        const guards = ctx.payload.guards.map((entry) => JSON.stringify([entry.scope, entry.key]))
        if (ctx.payload.guards.length === 0) {
          return new InvalidRequestError({ message: "guarded storage batch requires a guard", field: "guards" })
        }
        if (
          ctx.payload.guards.length + ctx.payload.sets.length + ctx.payload.removes.length >
          MAX_STORAGE_BATCH_ENTRIES
        ) {
          return new InvalidRequestError({
            message: `guarded storage batch exceeds ${MAX_STORAGE_BATCH_ENTRIES} entries`,
            field: "guards",
          })
        }
        if (new Set(guards).size !== guards.length || new Set(mutations).size !== mutations.length) {
          return new InvalidRequestError({
            message: "guarded storage batch contains duplicate addresses",
            field: "guards",
          })
        }
        const bytes = ctx.payload.sets.reduce(
          (total, entry) => total + new TextEncoder().encode(entry.value).byteLength,
          0,
        )
        if (bytes > MAX_STORAGE_BATCH_BYTES) {
          return new InvalidRequestError({
            message: `guarded storage batch values exceed ${MAX_STORAGE_BATCH_BYTES} bytes`,
            field: "sets",
          })
        }
        return storage.guardedBatch(ctx.payload).pipe(
          Effect.map((written) => ({ written })),
          Effect.catchTag(
            "Storage.RevisionConflict",
            (error) =>
              new StorageRevisionConflictError({
                scope: error.scope,
                key: error.key,
                expected: error.expected,
                actual: error.actual,
              }),
          ),
        )
      })
      .handle("clear", (ctx) => storage.clear(ctx.query.scope).pipe(Effect.map((removed) => ({ removed }))))
      .handle("receipt", (ctx) =>
        storage.migrationReceipt(ctx.query.name).pipe(Effect.map((receipt) => ({ receipt: receipt ?? null }))),
      )
      .handle("import", (ctx) => {
        if (ctx.payload.entries.some((entry) => !entry.scope.startsWith("desktop/store/"))) {
          return new InvalidRequestError({
            message: "legacy storage import name does not match its scope family",
            field: "entries",
          })
        }
        const addresses = new Set(ctx.payload.entries.map((entry) => JSON.stringify([entry.scope, entry.key])))
        if (addresses.size !== ctx.payload.entries.length) {
          return new InvalidRequestError({
            message: "legacy storage import contains duplicate scope and key entries",
            field: "entries",
          })
        }
        const byteLengths = ctx.payload.entries.map((entry) => new TextEncoder().encode(entry.value).byteLength)
        if (byteLengths.some((bytes) => bytes > MAX_STORAGE_VALUE_LENGTH)) {
          return new InvalidRequestError({
            message: `legacy storage import contains a value exceeding ${MAX_STORAGE_VALUE_LENGTH} bytes`,
            field: "entries",
          })
        }

        const bytes = byteLengths.reduce((total, length) => total + length, 0)
        if (bytes > MAX_STORAGE_IMPORT_BYTES) {
          return new InvalidRequestError({
            message: `legacy storage import values exceed ${MAX_STORAGE_IMPORT_BYTES} bytes`,
            field: "entries",
          })
        }

        return storage
          .importEntries(
            {
              name: ctx.payload.name,
              sourceFingerprint: ctx.payload.sourceFingerprint,
              sourceVersion: ctx.payload.sourceVersion,
            },
            ctx.payload.entries,
          )
          .pipe(
            Effect.catchTag(
              "Storage.MigrationConflict",
              (error) => new StorageMigrationConflictError({ name: error.name }),
            ),
          )
      })
  }),
)
