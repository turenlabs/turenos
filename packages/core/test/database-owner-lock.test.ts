import { describe, expect, test } from "bun:test"
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import SQLite from "bun:sqlite"
import { Database } from "@turenlabs/core/database/database"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Storage } from "@turenlabs/core/storage"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { tmpdir } from "./fixture/tmpdir"

describe("Database owner lock", () => {
  test("excludes another process until the lock-owning process exits", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "instance.sqlite")
    const readyFile = path.join(tmp.path, "ready")
    const worker = fileURLToPath(new URL("./fixture/database-owner-lock-worker.ts", import.meta.url))
    const child = Bun.spawn([process.execPath, worker, filename, readyFile], { stdout: "ignore", stderr: "pipe" })
    let ready = false
    for (let attempt = 0; attempt < 500 && !ready; attempt++) {
      try {
        await access(readyFile)
        ready = true
      } catch {
        await Bun.sleep(10)
      }
    }
    if (!ready) {
      const exitCode = await child.exited
      const stderr = await new Response(child.stderr).text()
      throw new Error(`owner-lock worker did not acquire the lock (exit ${exitCode}): ${stderr}`)
    }

    const error = await Database.acquireOwnerLock(filename).then(
      (release) => {
        release()
        return undefined
      },
      (cause) => cause,
    )
    expect(error).toMatchObject({ message: `Database is already owned by another server: ${filename}` })
    expect(await child.exited).toBe(0)

    const release = await Database.acquireOwnerLock(filename)
    release()
  })

  test("shares one process lock across independent layer scopes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "instance.sqlite")
    const [releaseA, releaseB] = await Promise.all([
      Database.acquireOwnerLock(filename),
      Database.acquireOwnerLock(filename),
    ])
    releaseA()

    const releaseChild = await Database.acquireOwnerLock(filename)
    releaseB()
    releaseChild()
  })

  test("does not create a lock database for memory databases", async () => {
    const release = await Database.acquireOwnerLock(":memory:")
    release()
  })

  test("reads the owner record from storage_state created before tombstones", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "instance.sqlite")
    const raw = new SQLite(filename)
    raw.run(
      "CREATE TABLE storage_state (scope text NOT NULL, key text NOT NULL, value text NOT NULL, revision integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, PRIMARY KEY (scope, key))",
    )
    raw.run("INSERT INTO storage_state VALUES ('internal/server-owner', 'record', ?, 1, 1, 1)", [
      JSON.stringify({ serverID: "old-server", keyID: "old-key", mode: "quick-connect", pid: 1, startedAt: 1 }),
    ])
    raw.close()

    const owner = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* ServerOwner.read(yield* Database.openExisting(filename))
      }).pipe(Effect.scoped),
    )
    expect(owner).toMatchObject({ serverID: "old-server", mode: "quick-connect" })
  })

  test("checks a persistent owner before database migrations", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "instance.sqlite")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            LayerNode.compile(Storage.node, [[Database.node, Database.layerFromPath(filename)]]),
          )
          const storage = Context.get(context, Storage.Service)
          yield* storage.set({
            scope: Storage.Scope.make("internal/server-owner"),
            key: Storage.Key.make("record"),
            value: JSON.stringify({
              serverID: "persistent-server",
              keyID: "host-key",
              mode: "persistent",
              pid: 1,
              startedAt: 1,
            }),
          })
        }),
      ),
    )

    const release = await Database.acquireOwnerLock(filename, { mode: "quick-connect", keyID: "host-key" })
    try {
      const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("another persistent server")
    } finally {
      release()
    }

    const unlocked = await Effect.runPromiseExit(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    expect(Exit.isFailure(unlocked)).toBe(true)
    if (Exit.isFailure(unlocked)) expect(Cause.pretty(unlocked.cause)).toContain("another persistent server")
  })
})
