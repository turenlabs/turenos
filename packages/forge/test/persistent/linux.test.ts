import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, symlink } from "node:fs/promises"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { VaultVerification } from "@turenlabs/core/database/vault-verification"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { PersistentLinux } from "@/persistent/linux"
import { tmpdir } from "../fixture/fixture"

const plan: PersistentLinux.Plan = {
  user: "turen",
  home: "/home/turen",
  dataRoot: "/var/lib/turenos",
  port: 4096,
  serverID: "srv_test",
  forgeBin: "/usr/local/bin/forge",
  group: "turenos-operators",
  unitPath: "/etc/systemd/system/turenos.service",
  attachPath: "/etc/turenos/attach.json",
  credstore: "/etc/credstore",
  credstoreEncrypted: "/etc/credstore.encrypted",
}

const facts: PersistentLinux.Facts = {
  platform: "linux",
  root: true,
  pid1: "systemd",
  systemdVersion: 255,
  systemdCreds: true,
  tpm2: false,
  user: { name: "turen", home: "/home/turen", uid: 1000, gid: 1000 },
  existingUnit: undefined,
  keyCredential: false,
  passwordCredential: false,
  database: false,
  dataRootOwner: undefined,
  dataRootLink: false,
  dataRootParentSafe: true,
  forgeBinSafe: true,
  portInUse: false,
  serviceActive: false,
}

describe("PersistentLinux", () => {
  test("the unit pins the data root and reads secrets only through systemd credentials", () => {
    const text = PersistentLinux.unit(plan)
    expect(text).toContain(
      "ExecStart=/usr/local/bin/forge serve --key-source systemd-credentials --hostname 127.0.0.1 --port 4096",
    )
    expect(text).toContain("Environment=FORGE_DB=/var/lib/turenos/data/forge/forge.db")
    expect(text).toContain(
      "LoadCredentialEncrypted=forge-secret-vault-key:/etc/credstore.encrypted/forge-secret-vault-key",
    )
    expect(text).toContain("Environment=FORGE_SERVER_PASSWORD_CREDENTIAL=forge-server-password")
    expect(text).not.toMatch(/FORGE_SECRET_VAULT_KEY=|FORGE_SERVER_PASSWORD=/)
    expect(PersistentLinux.installed(text).serverID).toBe("srv_test")
  })

  test("reads back the installed settings so a re-run keeps them", () => {
    expect(PersistentLinux.installed(PersistentLinux.unit(plan))).toEqual({
      serverID: "srv_test",
      user: "turen",
      dataRoot: "/var/lib/turenos",
      port: 4096,
      forgeBin: "/usr/local/bin/forge",
    })
    expect(PersistentLinux.installed(undefined).serverID).toBeUndefined()
  })

  test("refuses a port another process holds, but not the installed service's own", () => {
    expect(PersistentLinux.evaluate({ ...facts, portInUse: true }, plan).problems).toEqual([
      "127.0.0.1:4096 is already in use; choose another --port",
    ])
    const running = { ...facts, portInUse: true, serviceActive: true, existingUnit: PersistentLinux.unit(plan) }
    expect(PersistentLinux.evaluate(running, plan).problems).toEqual([])
    expect(PersistentLinux.evaluate(running, { ...plan, port: 4099 }).problems).toEqual([
      "127.0.0.1:4099 is already in use; choose another --port",
    ])
  })

  test("refuses values that could inject unit lines, a root service, and an unsafe data root", () => {
    const problems = (input: Partial<PersistentLinux.Plan>, extra: Partial<PersistentLinux.Facts> = {}) =>
      PersistentLinux.evaluate({ ...facts, ...extra }, { ...plan, ...input }).problems
    expect(problems({ dataRoot: "/var/lib/x\nExecStartPre=/bin/sh" })).toHaveLength(1)
    expect(problems({ dataRoot: "/var/lib/../etc" })).toHaveLength(1)
    expect(problems({ forgeBin: "forge" })).toHaveLength(1)
    expect(problems({ serverID: "srv x" })).toHaveLength(1)
    expect(problems({ user: "turen\nUser=root" })).toHaveLength(1)
    expect(problems({ port: 80 })).toHaveLength(1)
    expect(problems({}, { user: { name: "root", home: "/root", uid: 0, gid: 0 } })).toEqual([
      "the service must not run as root; choose an unprivileged --user",
    ])
    expect(problems({}, { dataRootParentSafe: false })).toHaveLength(1)
    expect(problems({}, { dataRootLink: true })).toHaveLength(1)
    expect(problems({}, { forgeBinSafe: false })).toEqual([
      "/usr/local/bin/forge must be a root-owned file in directories writable only by root; pass --forge-bin",
    ])
  })

  test("the data root cannot redirect root through planted links", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "server")
    await mkdir(path.join(root, "data"), { recursive: true })
    await symlink(tmp.path, path.join(root, "data", "forge"))
    await expect(PersistentLinux.claimDataRoot(root).catch((error: Error) => error.message)).resolves.toContain(
      "refusing to follow it",
    )
  })

  test("the attach record names the loopback listener", () => {
    expect(JSON.parse(PersistentLinux.attachRecord(plan, "pw"))).toEqual({
      version: 1,
      serverID: "srv_test",
      url: "http://127.0.0.1:4096",
      username: "forge",
      password: "pw",
    })
  })

  test("preflight refuses unsupported hosts and foreign units without falling back", () => {
    expect(PersistentLinux.evaluate(facts, plan).problems).toEqual([])
    expect(PersistentLinux.parseSystemdVersion("systemd 252 (252.22-1~deb12u1)\n+PAM +AUDIT")).toBe(252)
    const problems = PersistentLinux.evaluate(
      {
        ...facts,
        root: false,
        systemdVersion: 245,
        systemdCreds: false,
        existingUnit: "Environment=FORGE_SERVER_ID=srv_other",
      },
      plan,
    ).problems
    expect(problems).toContain("setup must run as root (for example with sudo)")
    expect(problems.some((problem) => problem.includes("systemd 245 is too old"))).toBe(true)
    expect(problems.some((problem) => problem.includes("refusing to fall back"))).toBe(true)
    expect(problems.some((problem) => problem.includes("different server"))).toBe(true)
    expect(PersistentLinux.evaluate({ ...facts, dataRootOwner: 995 }, plan).problems).toEqual([
      "/var/lib/turenos already exists and belongs to another account; choose another --data-root",
    ])
    expect(PersistentLinux.evaluate({ ...facts, dataRootOwner: 1000 }, plan).problems).toEqual([])
  })

  test("an imported quick-connect database is copied read-only, verified, and promoted", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "quick.db")
    const target = path.join(tmp.path, "pinned.db")
    const key = { keyID: "desktop-key", key: new Uint8Array(32).fill(3) }
    await Effect.gen(function* () {
      const database = yield* Database.Service
      const db = Database.primary(database.db)
      yield* VaultVerification.verify(db, database.databaseUUID, SecretVault.make(key))
      yield* ServerOwner.claim(db, { mode: "quick-connect", keyID: key.keyID })
    }).pipe(Effect.provide(Database.layerFromPath(source)), Effect.scoped, Effect.runPromise)

    const report = await VaultVerification.inspectFile(source, key)
    expect(report).toMatchObject({ keyIDs: ["desktop-key"], verification: "valid", owner: { mode: "quick-connect" } })
    const wrong = await VaultVerification.inspectFile(source, { keyID: "desktop-key", key: new Uint8Array(32).fill(4) })
    expect(wrong.verification).toBe("invalid")

    await Effect.gen(function* () {
      const db = yield* Database.openReadonly(source)
      yield* db.run(sql`VACUUM INTO ${target}`).pipe(Effect.orDie)
    }).pipe(Effect.scoped, Effect.runPromise)
    await Effect.gen(function* () {
      yield* ServerOwner.promote(yield* Database.openExisting(target), { serverID: "srv_test", keyID: key.keyID })
    }).pipe(Effect.scoped, Effect.runPromise)

    const release = await Database.acquireOwnerLock(target, {
      mode: "persistent",
      serverID: "srv_test",
      keyID: key.keyID,
      key,
    })
    try {
      const owner = await Effect.gen(function* () {
        return yield* ServerOwner.read(Database.primary((yield* Database.Service).db))
      }).pipe(Effect.provide(Database.layerFromPath(target)), Effect.scoped, Effect.runPromise)
      expect(owner).toMatchObject({ mode: "persistent", serverID: "srv_test", keyID: "desktop-key" })
    } finally {
      release()
    }
  })
})
