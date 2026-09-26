import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { VaultVerification } from "@turenlabs/core/database/vault-verification"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { CredentialTable } from "@turenlabs/core/credential/sql"
import { AccountTable } from "@turenlabs/core/account/sql"
import { tmpdir } from "./fixture/tmpdir"

const right = { keyID: "host-key", key: new Uint8Array(32).fill(1) }
const wrong = { keyID: "host-key", key: new Uint8Array(32).fill(2) }

function seed(filename: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const vault = SecretVault.make(right)
    yield* db
      .insert(CredentialTable)
      .values({ id: "cred_1" as never, label: "api", value: yield* vault.seal("credential", "cred_1", '{"type":"api"}') })
      .run()
    yield* db
      .insert(AccountTable)
      .values({
        id: "acc_1" as never,
        email: "a@example.com",
        url: "https://example.com",
        access_token: yield* vault.seal("internal/account/acc_1", "access-token", "at"),
        refresh_token: yield* vault.seal("internal/account/acc_1", "refresh-token", "rt"),
      })
      .run()
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.runPromise)
}

function start(filename: string, key: SecretVault.Key) {
  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* VaultVerification.verify(Database.primary(database.db), database.databaseUUID, SecretVault.make(key))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

describe("VaultVerification", () => {
  test("rejects wrong key bytes when secrets exist only outside storage_state", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "forge.db")
    await seed(filename)

    const exit = await start(filename, wrong)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("cannot open existing secrets in: credential, account")

    expect(Exit.isSuccess(await start(filename, right))).toBe(true)
    const again = await start(filename, wrong)
    expect(Exit.isFailure(again)).toBe(true)
    if (Exit.isFailure(again)) expect(Cause.pretty(again.cause)).toContain("Database secret verification failed")
  })

  test("verifies inside the database layer when the owner lock carries the key", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "forge.db")
    await seed(filename)

    const release = await Database.acquireOwnerLock(filename, { mode: "quick-connect", keyID: wrong.keyID, key: wrong })
    try {
      const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("the key is incorrect")
    } finally {
      release()
    }
  })

  test("reports stores and key IDs without writing", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "forge.db")
    await seed(filename)

    const report = await Effect.gen(function* () {
      const database = yield* Database.Service
      return yield* VaultVerification.inspect(Database.primary(database.db), database.databaseUUID, SecretVault.make(right))
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.runPromise)
    expect(report).toEqual({
      keyIDs: ["host-key"],
      stores: [
        { store: "credential", sealed: 1, opened: true },
        { store: "account", sealed: 2, opened: true },
      ],
      verification: "missing",
    })
  })
})
