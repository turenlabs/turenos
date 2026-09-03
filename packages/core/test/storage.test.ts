import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Storage } from "@turenlabs/core/storage"
import { StorageStateTable } from "@turenlabs/core/storage/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Storage.node))

describe("Storage", () => {
  it.effect("stores, reads, updates, and removes raw values", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const address = {
        scope: Storage.Scope.make("storage-test/crud"),
        key: Storage.Key.make("value"),
      }

      expect(yield* storage.get(address)).toBeUndefined()
      const created = yield* storage.set({ ...address, value: "first" })
      expect(created).toMatchObject({ ...address, value: "first", revision: 1 })
      expect(yield* storage.get(address)).toEqual(created)

      const updated = yield* storage.set({ ...address, value: "second" })
      expect(updated).toMatchObject({ ...address, value: "second", revision: 2 })

      expect(yield* storage.remove(address)).toBe(true)
      expect(yield* storage.get(address)).toBeUndefined()
      expect(yield* storage.remove(address)).toBe(false)
    }),
  )

  it.effect("isolates scopes and lists keys in stable order", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const first = Storage.Scope.make("storage-test/list-first")
      const second = Storage.Scope.make("storage-test/list-second")
      yield* storage.set({ scope: first, key: Storage.Key.make("b"), value: "second" })
      yield* storage.set({ scope: second, key: Storage.Key.make("a"), value: "other" })
      yield* storage.set({ scope: first, key: Storage.Key.make("a"), value: "first" })

      expect((yield* storage.list({ scope: first })).map((item) => [item.key, item.value])).toEqual([
        ["a", "first"],
        ["b", "second"],
      ])
      expect((yield* storage.list({ scope: second })).map((item) => [item.key, item.value])).toEqual([["a", "other"]])
    }),
  )

  it.effect("queries a bounded prefix page with a stable cursor", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const scope = Storage.Scope.make("storage-test/query")
      yield* Effect.forEach(
        ["item/003", "other/001", "item/001", "item/002"],
        (key) => storage.set({ scope, key: Storage.Key.make(key), value: key }),
        { discard: true },
      )

      const first = yield* storage.query({ scope, prefix: "item/", limit: 2 })
      expect(first.map((item) => String(item.key))).toEqual(["item/001", "item/002"])
      const second = yield* storage.query({
        scope,
        prefix: "item/",
        limit: 2,
        cursor: { key: first.at(-1)!.key, timeCreated: first.at(-1)!.timeCreated },
      })
      expect(second.map((item) => String(item.key))).toEqual(["item/003"])
    }),
  )

  it.effect("does not bump revision or timestamps for exact no-op writes", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const input = {
        scope: Storage.Scope.make("storage-test/no-op"),
        key: Storage.Key.make("value"),
        value: "same",
      }
      const created = yield* storage.set(input)

      expect(yield* storage.set(input)).toEqual(created)
      expect(
        yield* storage.compareAndSwap({
          ...input,
          expectedRevision: created.revision,
        }),
      ).toEqual(created)

      const changed = yield* storage.compareAndSwap({
        ...input,
        value: "changed",
        expectedRevision: created.revision,
      })
      expect(changed.revision).toBe(created.revision + 1)
    }),
  )

  it.effect("creates with null CAS and reports stale revisions", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const input = {
        scope: Storage.Scope.make("storage-test/cas"),
        key: Storage.Key.make("value"),
        value: "created",
      }
      const created = yield* storage.compareAndSwap({ ...input, expectedRevision: null })
      const conflict = yield* storage
        .compareAndSwap({ ...input, value: "stale", expectedRevision: 0 })
        .pipe(Effect.flip)

      expect(conflict).toBeInstanceOf(Storage.RevisionConflict)
      expect(conflict).toMatchObject({
        scope: input.scope,
        key: input.key,
        expected: 0,
        actual: created.revision,
      })
      expect(yield* storage.get(input)).toEqual(created)
    }),
  )

  it.effect("never revalidates a stale revision after remove, clear, and recreation", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const address = {
        scope: Storage.Scope.make("storage-test/delete-recreate-aba"),
        key: Storage.Key.make("value"),
      }
      const created = yield* storage.set({ ...address, value: "first" })

      expect(yield* storage.remove(address)).toBe(true)
      expect(yield* storage.get(address)).toBeUndefined()
      const recreated = yield* storage.set({ ...address, value: "second" })
      expect(recreated.revision).toBeGreaterThan(created.revision)
      expect(recreated.timeCreated).toBe(created.timeCreated)

      const stale = yield* storage
        .compareAndSwap({ ...address, value: "stale", expectedRevision: created.revision })
        .pipe(Effect.flip)
      expect(stale).toMatchObject({ expected: created.revision, actual: recreated.revision })
      expect(yield* storage.clear(address.scope)).toBe(1)
      expect(yield* storage.get(address)).toBeUndefined()

      const reactivated = yield* storage.compareAndSwap({ ...address, value: "third", expectedRevision: null })
      expect(reactivated.revision).toBeGreaterThan(recreated.revision)
      expect(reactivated.timeCreated).toBe(created.timeCreated)
      expect(
        yield* storage.removeIfRevision({ ...address, expectedRevision: created.revision }).pipe(Effect.flip),
      ).toMatchObject({
        expected: created.revision,
        actual: reactivated.revision,
      })
    }),
  )

  it.effect("preserves exact replacements and never revalidates omitted revisions", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const scope = Storage.Scope.make("storage-test/replace-aba")
      const firstKey = Storage.Key.make("first")
      const secondKey = Storage.Key.make("second")
      const first = yield* storage.set({ scope, key: firstKey, value: "one" })
      const second = yield* storage.set({ scope, key: secondKey, value: "two" })

      expect(
        yield* storage.replace({
          scope,
          entries: [
            { key: firstKey, value: "one" },
            { key: secondKey, value: "two" },
          ],
        }),
      ).toBe(2)
      expect(yield* storage.get({ scope, key: firstKey })).toEqual(first)
      expect(yield* storage.get({ scope, key: secondKey })).toEqual(second)

      yield* storage.replace({ scope, entries: [{ key: firstKey, value: "changed" }] })
      const changed = yield* storage.get({ scope, key: firstKey })
      expect(changed?.revision).toBe(first.revision + 1)
      expect(yield* storage.get({ scope, key: secondKey })).toBeUndefined()

      yield* storage.replace({
        scope,
        entries: [
          { key: firstKey, value: "changed" },
          { key: secondKey, value: "restored" },
        ],
      })
      const restored = yield* storage.get({ scope, key: secondKey })
      expect(restored?.revision).toBeGreaterThan(second.revision)
      expect(restored?.timeCreated).toBe(second.timeCreated)
      expect(
        yield* storage
          .compareAndSwap({ scope, key: secondKey, value: "stale", expectedRevision: second.revision })
          .pipe(Effect.flip),
      ).toMatchObject({ expected: second.revision, actual: restored?.revision })
    }),
  )

  it.effect("guards removals by revision and atomically replaces or clears one scope", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const scope = Storage.Scope.make("storage-test/batch")
      const retainedScope = Storage.Scope.make("storage-test/retained")
      const key = Storage.Key.make("value")
      const created = yield* storage.set({ scope, key, value: "first" })
      yield* storage.set({ scope: retainedScope, key, value: "retained" })

      const conflict = yield* storage
        .removeIfRevision({ scope, key, expectedRevision: Storage.Revision.make(created.revision + 1) })
        .pipe(Effect.flip)
      expect(conflict).toMatchObject({ expected: created.revision + 1, actual: created.revision })
      expect((yield* storage.get({ scope, key }))?.value).toBe("first")

      expect(
        yield* storage.replace({
          scope,
          entries: [
            { key: Storage.Key.make("a"), value: "one" },
            { key: Storage.Key.make("b"), value: "two" },
          ],
        }),
      ).toBe(2)
      expect((yield* storage.list({ scope })).map((item) => [item.key, item.value])).toEqual([
        ["a", "one"],
        ["b", "two"],
      ])
      expect((yield* storage.list({ scope: retainedScope }))[0]?.value).toBe("retained")
      expect(yield* storage.clear(scope)).toBe(2)
      expect(yield* storage.list({ scope })).toEqual([])
    }),
  )

  it.effect("atomically applies multi-scope sets and removals through one Storage operation", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const first = Storage.Scope.make("storage-test/batch-first")
      const second = Storage.Scope.make("storage-test/batch-second")
      const retained = Storage.Key.make("retained")
      const removed = Storage.Key.make("removed")
      yield* storage.set({ scope: first, key: retained, value: "before" })
      yield* storage.set({ scope: second, key: removed, value: "delete-me" })

      expect(
        yield* storage.batch({
          sets: [
            { scope: first, key: retained, value: "after" },
            { scope: second, key: Storage.Key.make("created"), value: "new" },
          ],
          removes: [{ scope: second, key: removed }],
        }),
      ).toBe(3)
      expect((yield* storage.get({ scope: first, key: retained }))?.value).toBe("after")
      expect(yield* storage.get({ scope: second, key: removed })).toBeUndefined()

      expect(
        yield* storage.batch({
          sets: [{ scope: first, key: retained, value: "after" }],
          removes: [{ scope: second, key: removed }],
        }),
      ).toBe(0)
    }),
  )

  it.effect("atomically applies guarded mutations or preserves every prior value on conflict", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const scope = Storage.Scope.make("storage-test/guarded-batch")
      const pointer = Storage.Key.make("current")
      const index = Storage.Key.make("index")
      const chunk = Storage.Key.make("generation/chunk")
      const current = yield* storage.set({ scope, key: pointer, value: "old" })
      const ledger = yield* storage.set({ scope, key: index, value: "old-index" })
      yield* storage.set({ scope, key: chunk, value: "payload" })

      expect(
        yield* storage.guardedBatch({
          guards: [
            { scope, key: pointer, expectedRevision: current.revision },
            { scope, key: index, expectedRevision: ledger.revision },
          ],
          sets: [
            { scope, key: pointer, value: "new" },
            { scope, key: index, value: "new-index" },
          ],
          removes: [{ scope, key: chunk }],
        }),
      ).toBe(3)
      expect((yield* storage.get({ scope, key: pointer }))?.value).toBe("new")
      expect((yield* storage.get({ scope, key: index }))?.value).toBe("new-index")
      expect(yield* storage.get({ scope, key: chunk })).toBeUndefined()

      const conflict = yield* storage
        .guardedBatch({
          guards: [{ scope, key: pointer, expectedRevision: current.revision }],
          sets: [{ scope, key: index, value: "must-not-write" }],
          removes: [{ scope, key: pointer }],
        })
        .pipe(Effect.flip)
      expect(conflict).toMatchObject({ key: pointer, expected: current.revision })
      expect((yield* storage.get({ scope, key: pointer }))?.value).toBe("new")
      expect((yield* storage.get({ scope, key: index }))?.value).toBe("new-index")
    }),
  )

  it.effect("rolls back imported rows when an importer is interrupted", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const address = {
        scope: Storage.Scope.make("storage-test/import-rollback"),
        key: Storage.Key.make("value"),
      }
      const timestamp = Date.now()
      const result = yield* storage
        .importLegacy(
          {
            name: "storage-test.import-rollback",
            sourceFingerprint: "rollback-fingerprint",
            sourceVersion: "1",
          },
          (tx) =>
            tx
              .insert(StorageStateTable)
              .values({
                ...address,
                value: "must-roll-back",
                revision: 1,
                time_created: timestamp,
                time_updated: timestamp,
              })
              .run()
              .pipe(Effect.orDie, Effect.andThen(Effect.die("interrupted import"))),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* storage.get(address)).toBeUndefined()
      expect(yield* storage.migrationReceipt("storage-test.import-rollback")).toBeUndefined()
    }),
  )

  it.effect("records import receipts atomically and rejects changed sources", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const input = {
        name: "storage-test.import-receipt",
        sourceFingerprint: "fingerprint-a",
        sourceVersion: "1",
      }
      const address = {
        scope: Storage.Scope.make("storage-test/import-receipt"),
        key: Storage.Key.make("value"),
      }
      const imported = yield* storage.importEntries(input, [{ ...address, value: "imported" }])

      expect(imported.applied).toBe(true)
      expect(imported.receipt).toMatchObject({
        name: input.name,
        sourceFingerprint: input.sourceFingerprint,
        sourceVersion: input.sourceVersion,
        rowCount: 1,
      })
      expect(typeof imported.receipt.timeVerified).toBe("number")
      expect(yield* storage.get(address)).toMatchObject({ value: "imported" })

      const repeated = yield* storage.importEntries(input, [{ ...address, value: "must-not-overwrite" }])
      expect(repeated).toEqual({ applied: false, receipt: imported.receipt })
      expect(yield* storage.migrationReceipt(input.name)).toEqual(imported.receipt)

      const conflict = yield* storage
        .importEntries({ ...input, sourceFingerprint: "fingerprint-b" }, [{ ...address, value: "conflict" }])
        .pipe(Effect.flip)
      expect(conflict).toBeInstanceOf(Storage.MigrationConflict)
      expect(conflict).toMatchObject({
        name: input.name,
        recordedFingerprint: "fingerprint-a",
        recordedVersion: "1",
        attemptedFingerprint: "fingerprint-b",
        attemptedVersion: "1",
      })
    }),
  )

  it.effect("does not resurrect deliberately deleted destinations during legacy import", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const address = {
        scope: Storage.Scope.make("storage-test/import-tombstone"),
        key: Storage.Key.make("value"),
      }
      const created = yield* storage.set({ ...address, value: "current" })
      expect(yield* storage.remove(address)).toBe(true)

      const imported = yield* storage.importEntries(
        {
          name: "storage-test.import-tombstone",
          sourceFingerprint: "deleted-destination",
          sourceVersion: "1",
        },
        [{ ...address, value: "legacy" }],
      )
      expect(imported.receipt.rowCount).toBe(0)
      expect(yield* storage.get(address)).toBeUndefined()

      const reactivated = yield* storage.set({ ...address, value: "intentional" })
      expect(reactivated.revision).toBeGreaterThan(created.revision)
    }),
  )
})
