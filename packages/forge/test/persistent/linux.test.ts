import { describe, expect, test } from "bun:test"
import path from "node:path"
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { DatabaseMigration } from "@turenlabs/core/database/migration"
import { migrations } from "@turenlabs/core/database/migration.gen"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { VaultVerification } from "@turenlabs/core/database/vault-verification"
import { SecretVault } from "@turenlabs/core/secret-vault"
import { PersistentLinux } from "@/persistent/linux"
import { activate, installLocked, keyFromText, placeDatabase, resolveKey, withInstallLock } from "@/cli/cmd/persistent"
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
  dataRootEmpty: true,
  dataRootMarked: false,
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

  test("a re-run reads the installed forge binary back from the unit", () => {
    const text = PersistentLinux.unit({ ...plan, forgeBin: "/opt/forge-1.2/bin/forge" })
    expect(PersistentLinux.installed(text).forgeBin).toBe("/opt/forge-1.2/bin/forge")
    expect(PersistentLinux.installed(undefined).forgeBin).toBeUndefined()
  })

  test("the unit stops restarting a binary or credential that cannot start", () => {
    const text = PersistentLinux.unit(plan)
    const [unit, service] = text.split("[Service]")
    expect(unit).toContain("StartLimitIntervalSec=300")
    expect(unit).toContain("StartLimitBurst=5")
    expect(service).toContain("RestartPreventExitStatus=78")
    expect(service).toContain("Environment=FORGE_PERSISTENT_UNIT=1")
    expect(service).toContain("Restart=on-failure")
  })

  test("the unit omits HOME for an account without a home directory", () => {
    expect(PersistentLinux.unit(plan)).toContain("Environment=HOME=/home/turen\n")
    expect(PersistentLinux.unit({ ...plan, home: "" })).not.toContain("Environment=HOME=")
  })

  test("refuses a port another process holds, but not the installed service's own", () => {
    expect(PersistentLinux.evaluate({ ...facts, portInUse: true }, plan).problems).toEqual([
      "127.0.0.1:4096 is already in use; choose another --port",
    ])
    const running = { ...facts, portInUse: true, serviceActive: true, existingUnit: PersistentLinux.unit(plan) }
    expect(PersistentLinux.evaluate(running, plan).problems).toEqual([])
    expect(PersistentLinux.evaluate({ ...facts, serviceActive: true }, plan).problems).toContain(
      "turenos.service is active without /etc/systemd/system/turenos.service; refusing to stop an unknown service",
    )
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
    const before = await lstat(path.join(root, "data"))
    let invoked = false
    await expect(
      PersistentLinux.withDataRoot(root, { uid: process.getuid!(), gid: process.getgid!() }, async () => {
        invoked = true
      }),
    ).rejects.toThrow("refusing to follow it")
    expect(invoked).toBe(false)
    const after = await lstat(path.join(root, "data"))
    expect([after.uid, after.gid, after.mode, after.ctimeMs]).toEqual([
      before.uid,
      before.gid,
      before.mode,
      before.ctimeMs,
    ])
  })

  test("the data root cannot redirect root through a planted rollback journal", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "server")
    await mkdir(path.dirname(PersistentLinux.databasePath(root)), { recursive: true })
    await symlink(path.join(tmp.path, "target"), `${PersistentLinux.databasePath(root)}-journal`)
    await expect(
      PersistentLinux.withDataRoot(root, { uid: process.getuid!(), gid: process.getgid!() }, async () => {
        throw new Error("must not run")
      }),
    ).rejects.toThrow("forge.db-journal is not a regular file")
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

  test("root setup refuses managed files in a directory another account owns", async () => {
    await using tmp = await tmpdir()
    let invoked = false
    const runner: PersistentLinux.Runner = async () => {
      invoked = true
      return { code: 0, stdout: "", stderr: "" }
    }

    await expect(PersistentLinux.writeRestricted(path.join(tmp.path, "attach.json"), "secret", 0o640)).rejects.toThrow(
      "must be writable only by root",
    )
    await expect(PersistentLinux.encryptCredential(runner, tmp.path, "test-key", "secret")).rejects.toThrow(
      "must be writable only by root",
    )
    await expect(PersistentLinux.decryptCredential(runner, tmp.path, "test-key")).rejects.toThrow(
      "must be writable only by root",
    )
    expect(invoked).toBe(false)
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

  test("an existing data root is taken only when empty, marked, or already the installed server's", () => {
    const problems = (extra: Partial<PersistentLinux.Facts>, input: Partial<PersistentLinux.Plan> = {}) =>
      PersistentLinux.evaluate({ ...facts, dataRootEmpty: false, ...extra }, { ...plan, ...input }).problems
    const refused = ["/var/lib/turenos is not empty and was not created by this installer; choose another --data-root"]
    expect(problems({ dataRootOwner: 0 })).toEqual(refused)
    expect(problems({ dataRootOwner: 1000 })).toEqual(refused)
    expect(problems({ dataRootOwner: 0, dataRootMarked: true })).toEqual([])
    expect(problems({ dataRootOwner: 1000, dataRootMarked: true })).toEqual([])
    expect(problems({ dataRootOwner: 1000, dataRootEmpty: true })).toEqual([])
    expect(problems({ dataRootOwner: 1000, existingUnit: PersistentLinux.unit(plan) })).toEqual([])
    expect(
      problems({ dataRootOwner: 1000, existingUnit: PersistentLinux.unit({ ...plan, dataRoot: "/srv/other" }) }),
    ).toEqual(refused)
  })

  test("a root-owned data root is an interrupted setup, not another account's", () => {
    const evaluated = PersistentLinux.evaluate({ ...facts, dataRootOwner: 0 }, plan)
    expect(evaluated.problems).toEqual([])
    expect(evaluated.notes[0]).toContain("interrupted setup")
  })

  test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "the scoped data root releases directories and new database files after work fails",
    async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "server")
      const owner = { uid: 65534, gid: 65534 }
      await expect(
        PersistentLinux.withDataRoot(root, owner, async () => {
          for (const dir of ["", "data", "data/forge", "config", "config/forge", "state", "cache"]) {
            const info = await lstat(path.join(root, dir))
            expect(info.uid).toBe(0)
            expect(info.mode & 0o777).toBe(0o700)
          }
          const marker = await lstat(path.join(root, PersistentLinux.defaults.dataRootMarker))
          expect([marker.uid, marker.mode & 0o777]).toEqual([0, 0o600])
          await writeFile(PersistentLinux.databasePath(root), "fixture")
          throw new Error("work failed")
        }),
      ).rejects.toThrow("work failed")
      for (const file of [
        "",
        "data",
        "data/forge",
        "data/forge/forge.db",
        "config",
        "config/forge",
        "state",
        "cache",
      ]) {
        const info = await lstat(path.join(root, file))
        expect([info.uid, info.gid]).toEqual([owner.uid, owner.gid])
      }
    },
  )

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a failed ownership claim closes without handing unclaimed directories to another account",
    async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "server")
      await mkdir(root, { mode: 0o750 })
      const before = await lstat(root)
      await expect(
        PersistentLinux.withDataRoot(root, { uid: 65534, gid: 65534 }, async () => {
          throw new Error("must not run")
        }),
      ).rejects.toThrow()
      const after = await lstat(root)
      expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode])
    },
  )

  // The copy itself runs as root and is exercised by script/persistent-e2e.ts; here only the refusal
  // of a staging directory another account can write is checked, without touching the destination.
  test("a staged tree in a directory another account can write is refused before anything is copied", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "staged", "data")
    await mkdir(path.join(source, "snapshot"), { recursive: true })
    await writeFile(path.join(source, "snapshot", "HEAD"), "ref: refs/heads/main\n")
    const destination = path.join(tmp.path, "root", "data", "forge")
    await expect(
      PersistentLinux.importTree(source, destination, { uid: process.getuid!(), gid: process.getgid!() }),
    ).rejects.toThrow("another account can write")
    expect(await lstat(destination).catch(() => undefined)).toBeUndefined()
  })

  // The parent check and the expected owner are injected so a non-root test controls both: "root" is
  // a uid the staged tree does not have, or the test's own uid when the tree should pass.
  const staged = async (root: string) => {
    const source = path.join(root, "staged")
    await mkdir(path.join(source, "data", "snapshot"), { recursive: true })
    await writeFile(path.join(source, "data", "snapshot", "HEAD"), "ref: refs/heads/main\n")
    await symlink("data", path.join(source, "link"))
    await chmod(source, 0o755)
    await chmod(path.join(source, "data"), 0o755)
    await chmod(path.join(source, "data", "snapshot"), 0o755)
    return source
  }
  const importTreeAs = (source: string, destination: string) =>
    PersistentLinux.importTree(source, destination, self(), { uid: process.getuid!(), parentSafe: async () => true })
  const self = () => ({ uid: process.getuid!(), gid: process.getgid!() })

  test.skipIf(process.platform === "win32")(
    "a staged tree whose root another account owns is refused even when its parent is safe",
    async () => {
      await using tmp = await tmpdir()
      const source = await staged(tmp.path)
      const destination = path.join(tmp.path, "root", "data", "forge")
      await expect(
        PersistentLinux.importTree(source, destination, self(), {
          uid: process.getuid!() + 1,
          parentSafe: async () => true,
        }),
      ).rejects.toThrow("not owned by root")
      expect(await lstat(destination).catch(() => undefined)).toBeUndefined()
    },
  )

  test.skipIf(process.platform === "win32")(
    "a staged tree with a nested directory another account can write is refused before anything is copied",
    async () => {
      await using tmp = await tmpdir()
      const source = await staged(tmp.path)
      await chmod(path.join(source, "data", "snapshot"), 0o775)
      const destination = path.join(tmp.path, "root", "data", "forge")
      await expect(
        PersistentLinux.importTree(source, destination, self(), {
          uid: process.getuid!(),
          parentSafe: async () => true,
        }),
      ).rejects.toThrow("writable by another account")
      expect(await lstat(destination).catch(() => undefined)).toBeUndefined()
    },
  )

  test.skipIf(process.platform === "win32")(
    "a staged tree owned by root and closed to others is copied as links",
    async () => {
      await using tmp = await tmpdir()
      const source = await staged(tmp.path)
      const destination = path.join(tmp.path, "forge")
      await importTreeAs(source, destination)
      expect(await readFile(path.join(destination, "data", "snapshot", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
      expect((await lstat(path.join(destination, "link"))).isSymbolicLink()).toBe(true)
    },
  )

  test("an imported quick-connect database is copied read-only, verified, and promoted", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "quick.db")
    const target = PersistentLinux.databasePath(tmp.path)
    await mkdir(path.dirname(target), { recursive: true })
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

    const before = await readFile(source)
    // Creating the fixture may have left an owner lock; the import must not be blamed for that one.
    await Promise.all(
      (await readdir(tmp.path))
        .filter((name) => name.startsWith("quick.db.owner.lock"))
        .map((name) => rm(path.join(tmp.path, name))),
    )
    await placeDatabase(
      { ...plan, dataRoot: tmp.path },
      facts,
      { ...key, encoded: Buffer.from(key.key).toString("base64") },
      source,
    )
    expect(await readFile(source)).toEqual(before)
    expect((await readdir(tmp.path)).filter((name) => name.startsWith("quick.db.owner.lock"))).toEqual([])

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

  test("an import migrates a pre-storage_state destination without modifying its source", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "legacy.db")
    const target = PersistentLinux.databasePath(tmp.path)
    const key = { keyID: "legacy-key", key: new Uint8Array(32).fill(3) }
    await writeFile(source, "")
    await mkdir(path.dirname(target), { recursive: true })
    await Effect.gen(function* () {
      const db = yield* Database.openExisting(source)
      yield* DatabaseMigration.applyOnly(
        db,
        migrations.filter((migration) => migration.id < "20260721162622_storage_state"),
      )
      expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'storage_state'`)).toBeUndefined()
      const sealed = yield* SecretVault.make(key).seal("credential", "legacy-credential", "fixture-secret")
      yield* db.run(sql`
        INSERT INTO credential (id, label, value, time_created, time_updated)
        VALUES ('legacy-credential', 'legacy', ${JSON.stringify(sealed)}, 0, 0)
      `)
    }).pipe(Effect.scoped, Effect.runPromise)

    const before = await readFile(source)
    await expect(
      placeDatabase(
        { ...plan, dataRoot: tmp.path },
        facts,
        { keyID: key.keyID, key: new Uint8Array(32).fill(4), encoded: Buffer.alloc(32, 4).toString("base64") },
        source,
      ),
    ).rejects.toThrow("cannot open")
    expect(await lstat(target).catch(() => undefined)).toBeUndefined()
    await placeDatabase(
      { ...plan, dataRoot: tmp.path },
      facts,
      { ...key, encoded: Buffer.from(key.key).toString("base64") },
      source,
    )
    expect(await readFile(source)).toEqual(before)
    expect((await VaultVerification.inspectFile(target, key)).stores).toContainEqual({
      store: "credential",
      sealed: 1,
      opened: true,
    })
    await Effect.gen(function* () {
      const db = yield* Database.openReadonly(target)
      expect(yield* ServerOwner.read(db)).toMatchObject({
        mode: "persistent",
        serverID: plan.serverID,
        keyID: key.keyID,
      })
      expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
    }).pipe(Effect.scoped, Effect.runPromise)
  })

  test("an import keeps an owner lock the source already had", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "quick.db")
    await mkdir(path.dirname(PersistentLinux.databasePath(tmp.path)), { recursive: true })
    const key = { keyID: "desktop-key", key: new Uint8Array(32).fill(3) }
    await Effect.gen(function* () {
      const database = yield* Database.Service
      const db = Database.primary(database.db)
      yield* VaultVerification.verify(db, database.databaseUUID, SecretVault.make(key))
      yield* ServerOwner.claim(db, { mode: "quick-connect", keyID: key.keyID })
    }).pipe(Effect.provide(Database.layerFromPath(source)), Effect.scoped, Effect.runPromise)
    ;(await Database.acquireOwnerLock(source))()
    const lock = `${source}.owner.lock`
    expect(await lstat(lock).then(() => true)).toBe(true)
    await placeDatabase(
      { ...plan, dataRoot: tmp.path },
      facts,
      { ...key, encoded: Buffer.from(key.key).toString("base64") },
      source,
    )
    expect(await lstat(lock).then(() => true)).toBe(true)
  })

  test("the attach record is published only after the service is healthy and its key verified", async () => {
    const key = { keyID: "k1", encoded: Buffer.alloc(32, 1).toString("base64"), key: new Uint8Array(32).fill(1) }
    const log: string[] = []
    const publish = async () => void log.push("publish")
    const descriptor = (keyID: string) => ({ serverID: plan.serverID, keyID, mode: "persistent" })

    await activate(plan, facts, key, "pw", {
      start: async () => (log.push("start"), descriptor("k1")),
      publish,
    })
    expect(log).toEqual(["start", "publish"])

    log.length = 0
    await expect(
      activate(plan, facts, key, "pw", {
        start: async () => {
          log.push("start")
          throw new Error("the service did not become healthy within 60 seconds")
        },
        publish,
      }),
    ).rejects.toThrow("did not become healthy")
    expect(log).toEqual(["start"])

    log.length = 0
    await expect(
      activate(plan, facts, key, "pw", { start: async () => (log.push("start"), descriptor("other")), publish }),
    ).rejects.toThrow("expected k1")
    expect(log).toEqual(["start"])
  })

  test("a second install fails fast while one holds the lock, and a crashed install's lock is taken over", async () => {
    await using tmp = await tmpdir()
    const lock = path.join(tmp.path, "install.lock")
    const entered: string[] = []
    await withInstallLock(lock, async () => {
      await expect(withInstallLock(lock, async () => entered.push("second"))).rejects.toThrow(
        "another install is running",
      )
    })
    expect(entered).toEqual([])
    expect(await lstat(lock).catch(() => undefined)).toBeUndefined()

    const dead = Bun.spawn(["true"])
    await dead.exited
    await writeFile(lock, `${dead.pid}\n`)
    await withInstallLock(lock, async () => entered.push("after crash"))
    expect(entered).toEqual(["after crash"])
    expect(await lstat(lock).catch(() => undefined)).toBeUndefined()

    await writeFile(lock, "")
    await expect(withInstallLock(lock, async () => entered.push("unknown owner"))).rejects.toThrow(
      "another install is running",
    )
  })

  test("a takeover waits for its guard and a release leaves a lock that is no longer this process's", async () => {
    await using tmp = await tmpdir()
    const lock = path.join(tmp.path, "install.lock")
    const guard = `${lock}.takeover`
    const dead = Bun.spawn(["true"])
    await dead.exited
    const entered: string[] = []

    // Another contender is mid-takeover: the lock is not touched and this one backs off.
    await writeFile(lock, `${dead.pid}\n`)
    await writeFile(guard, "")
    await expect(withInstallLock(lock, async () => entered.push("guarded"))).rejects.toThrow(
      /another install is running.*install\.lock\.takeover/,
    )
    expect(entered).toEqual([])
    expect(await readFile(lock, "utf8")).toBe(`${dead.pid}\n`)
    await rm(guard)

    // A takeover releases its guard, whether or not it won.
    await withInstallLock(lock, async () => entered.push("taken over"))
    expect(entered).toEqual(["taken over"])
    expect(await lstat(guard).catch(() => undefined)).toBeUndefined()
    await writeFile(lock, `${process.pid}\n`)
    await expect(withInstallLock(lock, async () => entered.push("live owner"))).rejects.toThrow("another install")
    expect(await lstat(guard).catch(() => undefined)).toBeUndefined()
    await rm(lock)

    // Whoever now holds the path owns it; the displaced run leaves it alone.
    await withInstallLock(lock, async () => writeFile(lock, `${dead.pid}\n`))
    expect(await readFile(lock, "utf8")).toBe(`${dead.pid}\n`)
  })

  test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
    "apply without root is refused as a preflight problem and never touches the lock",
    async () => {
      await using tmp = await tmpdir()
      // A path whose parent is missing would fail with ENOENT if the lock were attempted.
      const lock = path.join(tmp.path, "missing", "install.lock")
      await expect(installLocked({ apply: true, user: "root" }, lock)).rejects.toThrow(
        "preflight failed; nothing was changed",
      )
      expect(await lstat(path.dirname(lock)).catch(() => undefined)).toBeUndefined()
    },
  )

  test("a key on stdin is exactly a key ID and a key, and rejections never echo it", () => {
    const encoded = Buffer.alloc(32, 7).toString("base64")
    expect(keyFromText(`desktop-key\n${encoded}\n`)).toMatchObject({ keyID: "desktop-key", encoded })
    const extra = `desktop-key\n${encoded}\nsecret-trailing-line\n`
    expect(() => keyFromText(extra)).toThrow("more than two lines")
    expect(() => keyFromText(extra)).not.toThrow(encoded)
    expect(() => keyFromText(extra)).not.toThrow("secret-trailing-line")
  })

  test("a recovery file left by a failed install says how to continue instead of deadlocking", async () => {
    await using tmp = await tmpdir()
    const recovery = path.join(tmp.path, "recovery.key")
    await writeFile(recovery, "old-key\nold\n")
    await expect(resolveKey({ "recovery-file": recovery }, facts, plan)).rejects.toThrow(
      /already exists; refusing to replace it.*delete it and re-run.*--key-stdin/,
    )
    expect(await readFile(recovery, "utf8")).toBe("old-key\nold\n")
  })
})
