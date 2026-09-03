import { NodeHttpServer } from "@effect/platform-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, LayerMap, Option } from "effect"
import { sql } from "drizzle-orm"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@turenlabs/core/control-plane/move-session"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationError, LocationServices } from "@turenlabs/core/location-services"
import { ProjectV2 } from "@turenlabs/core/project"
import { Storage } from "@turenlabs/core/storage"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { StoragePaths } from "../../src/server/routes/instance/httpapi/groups/storage"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { securityHandlers } from "../../src/server/routes/instance/httpapi/handlers/security"
import { storageHandlers } from "../../src/server/routes/instance/httpapi/handlers/storage"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { Auth } from "@/auth"

function storageLayer(databasePath: string) {
  const databaseLayer = Database.layerFromPath(databasePath)
  return Layer.merge(databaseLayer, LayerNode.compile(Storage.node, [[Database.node, databaseLayer]]))
}

function apiLayer(password: Option.Option<string>, databasePath = ":memory:") {
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, securityHandlers, storageHandlers]),
      Layer.provide(Layer.mock(Auth.Service)({})),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // Raw HttpApi routes expose an opaque handler context at the request boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(Layer.mock(InstanceStore.Service)({ disposeAll: () => Effect.void })),
    Layer.provide(
      Layer.effect(
        LocationServiceMap.Service,
        LayerMap.make(() => Layer.empty as Layer.Layer<LocationServices, LocationError>),
      ),
    ),
    Layer.provide(Layer.mock(ProjectV2.Service)({})),
    Layer.provide(
      Layer.mock(Installation.Service)({
        method: () => Effect.succeed("npm"),
        latest: () => Effect.succeed("9.9.9"),
        upgrade: () => Effect.void,
      }),
    ),
    Layer.provide(ExtensionRuntime.layer),
    Layer.provide(storageLayer(databasePath)),
    Layer.provide(SecretVault.ephemeral),
    Layer.provide(ServerAuth.Config.configLayer({ password, username: "opencode" })),
  )
}

const it = testEffect(apiLayer(Option.none()))
const itSecret = testEffect(apiLayer(Option.some("secret")))
const itStorage = testEffect(storageLayer(":memory:"))

function query(path: string, fields: Record<string, string>) {
  return `${path}?${new URLSearchParams(fields)}`
}

function set(payload: unknown, authorization?: string) {
  return HttpClientRequest.put(StoragePaths.state).pipe(
    HttpClientRequest.setBody(HttpBody.jsonUnsafe(payload)),
    authorization ? HttpClientRequest.setHeader("authorization", authorization) : (request) => request,
    HttpClient.execute,
  )
}

function importLegacy(payload: unknown) {
  return HttpClientRequest.post(StoragePaths.import).pipe(
    HttpClientRequest.setBody(HttpBody.jsonUnsafe(payload)),
    HttpClient.execute,
  )
}

function replace(payload: unknown) {
  return HttpClientRequest.put(StoragePaths.scope).pipe(
    HttpClientRequest.setBody(HttpBody.jsonUnsafe(payload)),
    HttpClient.execute,
  )
}

function guardedBatch(payload: unknown) {
  return HttpClientRequest.post(StoragePaths.batch).pipe(
    HttpClientRequest.setBody(HttpBody.jsonUnsafe(payload)),
    HttpClient.execute,
  )
}

describe("storage HttpApi", () => {
  itSecret.live("requires root authentication", () =>
    Effect.gen(function* () {
      const missing = yield* HttpClient.get(query(StoragePaths.receipt, { name: "desktop.electron-store.auth-test" }))
      const authorized = yield* HttpClientRequest.get(
        query(StoragePaths.receipt, { name: "desktop.electron-store.auth-test" }),
      ).pipe(
        HttpClientRequest.setHeader(
          "authorization",
          ServerAuth.header({ username: "opencode", password: "secret" }) ?? "",
        ),
        HttpClient.execute,
      )

      expect(missing.status).toBe(401)
      expect(authorized.status).toBe(200)
      expect(yield* authorized.json).toEqual({ receipt: null })
    }),
  )

  it.live("gets, lists, removes, and clears isolated scopes", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/preferences"
      const otherScope = "desktop/store/window"
      expect((yield* set({ scope, key: "b", value: "second" })).status).toBe(200)
      expect((yield* set({ scope, key: "a", value: "first" })).status).toBe(200)
      expect((yield* set({ scope: otherScope, key: "a", value: "other" })).status).toBe(200)

      const listed = yield* HttpClient.get(query(StoragePaths.list, { scope }))
      expect(listed.status).toBe(200)
      expect(yield* listed.json).toMatchObject({
        items: [
          { scope, key: "a", value: "first", revision: 1 },
          { scope, key: "b", value: "second", revision: 1 },
        ],
      })

      const removed = yield* HttpClientRequest.delete(query(StoragePaths.state, { scope, key: "a" })).pipe(
        HttpClient.execute,
      )
      expect(yield* removed.json).toEqual({ removed: true })

      const cleared = yield* HttpClientRequest.delete(query(StoragePaths.scope, { scope })).pipe(HttpClient.execute)
      expect(yield* cleared.json).toEqual({ removed: 1 })

      const missing = yield* HttpClient.get(query(StoragePaths.state, { scope, key: "b" }))
      expect(yield* missing.json).toEqual({ state: null })

      const retained = yield* HttpClient.get(query(StoragePaths.state, { scope: otherScope, key: "a" }))
      expect(yield* retained.json).toMatchObject({ state: { value: "other" } })
    }),
  )

  it.live("atomically replaces a scope with multiple individually bounded values", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/replace-large"
      expect((yield* set({ scope, key: "old", value: "old-value" })).status).toBe(200)
      const entries = Array.from({ length: 3 }, (_, index) => ({
        key: `chunk-${index}`,
        value: `${index}${"x".repeat(450_000)}`,
      }))
      expect(new TextEncoder().encode(entries.map((entry) => entry.value).join("")).byteLength).toBeGreaterThan(
        1024 * 1024,
      )

      const response = yield* replace({ scope, entries })
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ written: 3 })
      const listed = yield* HttpClient.get(query(StoragePaths.list, { scope }))
      expect(yield* listed.json).toMatchObject({ items: entries })
    }),
  )

  it.live("rejects duplicate replacement keys before preserving the prior scope", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/replace-validation"
      expect((yield* set({ scope, key: "retained", value: "database-authority" })).status).toBe(200)
      const response = yield* replace({
        scope,
        entries: [
          { key: "duplicate", value: "one" },
          { key: "duplicate", value: "two" },
        ],
      })
      expect(response.status).toBe(400)
      const listed = yield* HttpClient.get(query(StoragePaths.list, { scope }))
      expect(yield* listed.json).toMatchObject({ items: [{ key: "retained", value: "database-authority" }] })
    }),
  )

  it.live("atomically applies a bounded guarded batch and rolls back stale guards", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/state-guarded"
      const pointer = yield* set({ scope, key: "current", value: "old" })
      const index = yield* set({ scope, key: "index", value: "old-index" })
      expect((yield* set({ scope, key: "chunk", value: "payload" })).status).toBe(200)
      const pointerState = (yield* pointer.json) as { revision: number }
      const indexState = (yield* index.json) as { revision: number }

      const committed = yield* guardedBatch({
        guards: [
          { scope, key: "current", expectedRevision: pointerState.revision },
          { scope, key: "index", expectedRevision: indexState.revision },
        ],
        sets: [
          { scope, key: "current", value: "new" },
          { scope, key: "index", value: "new-index" },
        ],
        removes: [{ scope, key: "chunk" }],
      })
      expect(committed.status).toBe(200)
      expect(yield* committed.json).toEqual({ written: 3 })

      const conflict = yield* guardedBatch({
        guards: [{ scope, key: "current", expectedRevision: pointerState.revision }],
        sets: [{ scope, key: "index", value: "must-not-write" }],
        removes: [{ scope, key: "current" }],
      })
      expect(conflict.status).toBe(409)
      const listed = yield* HttpClient.get(query(StoragePaths.list, { scope }))
      expect(yield* listed.json).toMatchObject({
        items: [
          { key: "current", value: "new" },
          { key: "index", value: "new-index" },
        ],
      })
    }),
  )

  it.live("uses optional revisions for compare-and-swap without reflecting values in conflicts", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/redaction"
      const key = "secret"
      const created = yield* set({ scope, key, value: "stored-secret-value", expectedRevision: null })
      expect(created.status).toBe(200)
      expect(yield* created.json).toMatchObject({ scope, key, value: "stored-secret-value", revision: 1 })

      const updated = yield* set({ scope, key, value: "updated-secret-value" })
      expect(updated.status).toBe(200)
      expect(yield* updated.json).toMatchObject({ scope, key, value: "updated-secret-value", revision: 2 })

      const conflict = yield* set({ scope, key, value: "attempted-secret-value", expectedRevision: 0 })
      const body = yield* conflict.json
      const serialized = JSON.stringify(body)

      expect(conflict.status).toBe(409)
      expect(body).toEqual({
        _tag: "StorageRevisionConflictError",
        scope,
        key,
        expected: 0,
        actual: 2,
      })
      expect(serialized).not.toContain("stored-secret-value")
      expect(serialized).not.toContain("updated-secret-value")
      expect(serialized).not.toContain("attempted-secret-value")
    }),
  )

  it.live("guards removals with the renderer revision", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/remove-cas"
      const key = "theme"
      expect((yield* set({ scope, key, value: "first" })).status).toBe(200)
      expect((yield* set({ scope, key, value: "renderer-a" })).status).toBe(200)

      const conflict = yield* HttpClientRequest.delete(
        query(StoragePaths.state, { scope, key, expectedRevision: "1" }),
      ).pipe(HttpClient.execute)
      expect(conflict.status).toBe(409)
      expect(yield* conflict.json).toEqual({
        _tag: "StorageRevisionConflictError",
        scope,
        key,
        expected: 1,
        actual: 2,
      })
      const retained = yield* HttpClient.get(query(StoragePaths.state, { scope, key }))
      expect(yield* retained.json).toMatchObject({ state: { value: "renderer-a", revision: 2 } })
    }),
  )

  it.live("imports destination-wins batches and records an atomic receipt", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/legacy"
      expect((yield* set({ scope, key: "existing", value: "database-authority" })).status).toBe(200)
      const payload = {
        name: "desktop.electron-store.test",
        sourceFingerprint: "sha256:first",
        sourceVersion: "1",
        entries: [
          { scope, key: "existing", value: "legacy-overwrite" },
          { scope, key: "new", value: "legacy-new" },
        ],
      }

      const imported = yield* importLegacy(payload)
      expect(imported.status).toBe(200)
      expect(yield* imported.json).toMatchObject({
        applied: true,
        receipt: {
          name: payload.name,
          sourceFingerprint: payload.sourceFingerprint,
          sourceVersion: payload.sourceVersion,
          rowCount: 1,
        },
      })

      const existing = yield* HttpClient.get(query(StoragePaths.state, { scope, key: "existing" }))
      const added = yield* HttpClient.get(query(StoragePaths.state, { scope, key: "new" }))
      expect(yield* existing.json).toMatchObject({ state: { value: "database-authority", revision: 1 } })
      expect(yield* added.json).toMatchObject({ state: { value: "legacy-new", revision: 1 } })

      const receipt = yield* HttpClient.get(query(StoragePaths.receipt, { name: payload.name }))
      expect(yield* receipt.json).toMatchObject({ receipt: { name: payload.name, rowCount: 1 } })

      const repeated = yield* importLegacy(payload)
      expect(yield* repeated.json).toMatchObject({ applied: false, receipt: { rowCount: 1 } })

      const changed = yield* importLegacy({
        ...payload,
        sourceFingerprint: "sha256:changed",
        entries: [{ scope, key: "existing", value: "changed-secret-value" }],
      })
      const body = yield* changed.json
      const serialized = JSON.stringify(body)
      expect(changed.status, serialized).toBe(409)
      expect(body).toEqual({ _tag: "StorageMigrationConflictError", name: payload.name })
      expect(serialized).not.toContain("database-authority")
      expect(serialized).not.toContain("changed-secret-value")
    }),
  )

  it.live("imports a bounded legacy snapshot larger than the old eight MiB limit", () =>
    Effect.gen(function* () {
      const scope = "desktop/store/legacy-large"
      const entries = Array.from({ length: 18 }, (_, index) => ({
        scope,
        key: `chunk-${index.toString().padStart(2, "0")}`,
        value: `${index}:${"x".repeat(500_000)}`,
      }))
      expect(entries.reduce((total, entry) => total + entry.value.length, 0)).toBeGreaterThan(8 * 1024 * 1024)

      const response = yield* importLegacy({
        name: "desktop.electron-store.legacy-large",
        sourceFingerprint: "sha256:legacy-large",
        sourceVersion: "electron-store-v2",
        entries,
      })
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ applied: true, receipt: { rowCount: 18 } })
      const stored = yield* HttpClient.get(query(StoragePaths.state, { scope, key: "chunk-17" }))
      const serialized = JSON.stringify(yield* stored.json)
      expect(serialized.length).toBeGreaterThan(500_000)
      expect(serialized).toContain('"key":"chunk-17"')
    }),
  )

  it.live("rejects duplicate import addresses and bounded fields", () =>
    Effect.gen(function* () {
      const duplicate = yield* importLegacy({
        name: "desktop.electron-store.duplicate",
        sourceFingerprint: "sha256:duplicate",
        sourceVersion: "1",
        entries: [
          { scope: "desktop/store/duplicate", key: "same", value: "one" },
          { scope: "desktop/store/duplicate", key: "same", value: "two" },
        ],
      })
      expect(duplicate.status).toBe(400)

      const longScope = yield* set({ scope: `desktop/store/${"s".repeat(257)}`, key: "value", value: "bounded" })
      expect(longScope.status).toBe(400)

      const longValue = yield* set({
        scope: "desktop/store/bounds",
        key: "value",
        value: "v".repeat(1024 * 1024 + 1),
      })
      expect(longValue.status).toBe(400)

      const multiByteValue = yield* set({
        scope: "desktop/store/bounds",
        key: "unicode-value",
        value: "🧱".repeat(300_000),
      })
      expect(multiByteValue.status).toBe(400)
    }),
  )

  it.live("rejects internal scopes and mixed public-internal import batches", () =>
    Effect.gen(function* () {
      const terminal = yield* set({ scope: "terminal/state/preferences", key: "theme", value: "system" })
      expect(terminal.status).toBe(400)

      const internal = yield* set({ scope: "internal/security", key: "token", value: "must-not-write" })
      expect(internal.status).toBe(400)

      const mixed = yield* importLegacy({
        name: "desktop.electron-store.mixed-scope",
        sourceFingerprint: "sha256:mixed",
        sourceVersion: "1",
        entries: [
          { scope: "desktop/store/public", key: "value", value: "public-value" },
          { scope: "internal/security", key: "token", value: "internal-value" },
        ],
      })
      expect(mixed.status).toBe(400)

      const state = yield* HttpClient.get(query(StoragePaths.state, { scope: "desktop/store/public", key: "value" }))
      expect(yield* state.json).toEqual({ state: null })

      const receipt = yield* HttpClient.get(query(StoragePaths.receipt, { name: "desktop.electron-store.mixed-scope" }))
      expect(yield* receipt.json).toEqual({ receipt: null })
    }),
  )

  it.live("isolates public migration receipts from internal and cross-client namespaces", () =>
    Effect.gen(function* () {
      const internal = yield* importLegacy({
        name: "internal-auth-json-v1",
        sourceFingerprint: "sha256:internal",
        sourceVersion: "1",
        entries: [{ scope: "terminal/state/attack", key: "value", value: "must-not-write" }],
      })
      expect(internal.status).toBe(400)

      const internalReceipt = yield* HttpClient.get(query(StoragePaths.receipt, { name: "internal-auth-json-v1" }))
      expect(internalReceipt.status).toBe(400)

      const crossClient = yield* importLegacy({
        name: "terminal.cross-client",
        sourceFingerprint: "sha256:cross-client",
        sourceVersion: "1",
        entries: [{ scope: "desktop/store/preferences", key: "value", value: "must-not-write" }],
      })
      expect(crossClient.status).toBe(400)

      const state = yield* HttpClient.get(
        query(StoragePaths.state, { scope: "desktop/store/preferences", key: "value" }),
      )
      expect(yield* state.json).toEqual({ state: null })
    }),
  )

  it.live("allows only bounded desktop legacy receipts in the desktop scope family", () =>
    Effect.gen(function* () {
      const accepted = yield* importLegacy({
        name: "desktop.legacy.product-settings.v1",
        sourceFingerprint: "sha256:desktop-product",
        sourceVersion: "desktop-product-state-v1",
        entries: [{ scope: "desktop/store/product-state-v1", key: "pinch-zoom-enabled", value: "true" }],
      })
      expect(accepted.status).toBe(200)

      const mismatch = yield* importLegacy({
        name: "desktop.legacy.scope-mismatch.v1",
        sourceFingerprint: "sha256:scope-mismatch",
        sourceVersion: "1",
        entries: [{ scope: "terminal/state/preferences", key: "secret", value: "must-not-write" }],
      })
      const body = yield* mismatch.json
      expect(mismatch.status).toBe(400)
      expect(JSON.stringify(body)).not.toContain("must-not-write")

      const state = yield* HttpClient.get(
        query(StoragePaths.state, { scope: "terminal/state/preferences", key: "secret" }),
      )
      expect(state.status).toBe(400)
      const receipt = yield* HttpClient.get(query(StoragePaths.receipt, { name: "desktop.legacy.scope-mismatch.v1" }))
      expect(yield* receipt.json).toEqual({ receipt: null })
    }),
  )

  itStorage.live("rolls back an interrupted scope replacement", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const { db } = yield* Database.Service
      const scope = Storage.Scope.make("desktop/store/interrupted")
      yield* storage.set({ scope, key: Storage.Key.make("retained"), value: "old-value" })
      yield* db.run(sql`
        CREATE TRIGGER interrupt_storage_replace
        BEFORE INSERT ON storage_state
        WHEN NEW.key = 'interrupt'
        BEGIN
          SELECT RAISE(ABORT, 'interrupted');
        END
      `)

      const exit = yield* storage
        .replace({
          scope,
          entries: [
            { key: Storage.Key.make("partial"), value: "new-value" },
            { key: Storage.Key.make("interrupt"), value: "new-value" },
          ],
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect((yield* storage.get({ scope, key: Storage.Key.make("retained") }))?.value).toBe("old-value")
      expect(yield* storage.get({ scope, key: Storage.Key.make("partial") })).toBeUndefined()
    }),
  )
})

test("storage HTTP survives a real file database close and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-storage-http-"))
  const databasePath = join(directory, "forge.db")
  const scope = "desktop/store/restart-large"
  try {
    await Effect.gen(function* () {
      const response = yield* replace({
        scope,
        entries: [
          { key: "meta", value: "metadata" },
          { key: "chunk-0", value: "x".repeat(600_000) },
          { key: "chunk-1", value: "y".repeat(600_000) },
        ],
      })
      expect(response.status).toBe(200)
    }).pipe(Effect.scoped, Effect.provide(apiLayer(Option.none(), databasePath)), Effect.runPromise)

    await Effect.gen(function* () {
      const response = yield* HttpClient.get(query(StoragePaths.list, { scope }))
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { items: Array<{ key: string; value: string }> }
      expect(body.items.map((item) => item.key)).toEqual(["chunk-0", "chunk-1", "meta"])
      expect(body.items.reduce((total, item) => total + item.value.length, 0)).toBe(1_200_008)
    }).pipe(Effect.scoped, Effect.provide(apiLayer(Option.none(), databasePath)), Effect.runPromise)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
