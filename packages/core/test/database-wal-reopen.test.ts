import { describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import SQLite from "bun:sqlite"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

describe("Database reopen", () => {
  test("opens a WAL database whose -shm and -wal files were removed on a clean close", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "forge.db")
    const identity = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return (yield* Database.Service).databaseUUID
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )

    const first = await identity()
    // macOS SQLite keeps both side files after the last connection closes; other builds, such as
    // the one an earlier TurenOS release or the sqlite3 CLI uses, delete them. Simulate the latter.
    const writer = new SQLite(filename)
    expect(writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 })
    expect(writer.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    writer.close()
    rmSync(`${filename}-shm`, { force: true })
    rmSync(`${filename}-wal`, { force: true })
    expect(existsSync(`${filename}-shm`)).toBe(false)
    expect(existsSync(`${filename}-wal`)).toBe(false)

    expect(await identity()).toBe(first)
  })

  test.each(["owner", "key"] as const)(
    "rejects the wrong %s without changing files when SHM is missing",
    async (kind) => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "forge.db")
      const key = { keyID: "wal-test-key", key: new Uint8Array(32).fill(1) }
      const release = await Database.acquireOwnerLock(filename, {
        mode: kind === "owner" ? "persistent" : "quick-connect",
        serverID: "wal-test-server",
        keyID: key.keyID,
        key,
      })
      try {
        await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
      } finally {
        release()
      }

      for (const residual of [false, true]) {
        if (residual) {
          // An abrupt process exit keeps committed WAL frames for recovery.
          const child = Bun.spawnSync([
            process.execPath,
            "-e",
            'const db = new (require("bun:sqlite").Database)(process.argv[1]); db.run("PRAGMA wal_autocheckpoint = 0"); db.run("UPDATE storage_state SET time_updated = time_updated + 1"); process.kill(process.pid, "SIGKILL")',
            filename,
          ])
          expect(child.signalCode).toBe("SIGKILL")
          expect(Bun.file(`${filename}-wal`).size).toBeGreaterThan(0)
        }
        rmSync(`${filename}-shm`, { force: true })
        if (!residual) rmSync(`${filename}-wal`, { force: true })
        const before = await Bun.file(filename).bytes()
        const wal = residual ? await Bun.file(`${filename}-wal`).bytes() : undefined
        const deny = await Database.acquireOwnerLock(filename, {
          mode: "quick-connect",
          keyID: key.keyID,
          key: kind === "key" ? { ...key, key: new Uint8Array(32).fill(2) } : key,
        })
        try {
          const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
          expect(Exit.isFailure(exit)).toBe(true)
          if (!residual && Exit.isFailure(exit))
            expect(Cause.pretty(exit.cause)).toContain(
              kind === "key" ? "Database secret verification failed" : "another persistent server",
            )
          expect(await Bun.file(filename).bytes()).toEqual(before)
          if (wal) expect(await Bun.file(`${filename}-wal`).bytes()).toEqual(wal)
        } finally {
          deny()
        }
      }
    },
  )
})
