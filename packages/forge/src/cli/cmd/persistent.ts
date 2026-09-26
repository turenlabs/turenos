import type { Argv } from "yargs"
import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { VaultVerification } from "@turenlabs/core/database/vault-verification"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { cmd } from "./cmd"
import { CliError } from "../effect-cmd"
import { parseKey } from "../secret-vault-key"
import { PersistentLinux } from "../../persistent/linux"

type PlanArgs = {
  user?: string
  "data-root"?: string
  port?: number
  "forge-bin"?: string
  "server-id"?: string
}

const refuse = (message: string) => new CliError({ message })

// No yargs defaults: an unset option falls back to the installed unit, so re-running setup never
// silently moves an installed server to a different data root, account, or port.
const planOptions = (yargs: Argv) =>
  yargs
    .option("user", { type: "string", describe: "account the service runs as (required for a new service)" })
    .option("data-root", {
      type: "string",
      describe: `pinned data root (default: the installed unit's, or ${PersistentLinux.defaults.dataRoot})`,
    })
    .option("port", {
      type: "number",
      describe: `loopback listener port (default: the installed unit's, or ${PersistentLinux.defaults.port})`,
    })
    .option("forge-bin", { type: "string", describe: "forge binary the service runs (default: this binary)" })
    .option("server-id", { type: "string", describe: "stable server ID (defaults to the installed unit's, or a new one)" })

async function plan(args: PlanArgs, runner = PersistentLinux.run) {
  const existing = await readFile(PersistentLinux.defaults.unitPath, "utf8").catch(() => undefined)
  const installed = PersistentLinux.installed(existing)
  const sameServer = installed.serverID !== undefined && (args["server-id"] ?? installed.serverID) === installed.serverID
  const user = args.user ?? (sameServer ? installed.user : undefined)
  if (!user) throw refuse("--user is required to set up a new service")
  const dataRoot = args["data-root"] ?? (sameServer ? installed.dataRoot : undefined) ?? PersistentLinux.defaults.dataRoot
  const conflicts = sameServer
    ? [
        ...(installed.user && user !== installed.user
          ? [`the installed service runs as ${installed.user}; changing the account is not supported`]
          : []),
        ...(installed.dataRoot && dataRoot !== installed.dataRoot
          ? [`the installed service uses data root ${installed.dataRoot}; moving its data is not supported`]
          : []),
      ]
    : []
  const passwd = await runner("getent", ["passwd", user])
  const target = {
    user,
    home: passwd.code === 0 ? (passwd.stdout.trim().split(":")[5] ?? "") : "",
    dataRoot,
    port: args.port ?? (sameServer ? installed.port : undefined) ?? PersistentLinux.defaults.port,
    serverID: args["server-id"] ?? installed.serverID ?? PersistentLinux.newServerID(),
    // Resolved, so the unit names the checked file rather than a link that could be repointed later.
    forgeBin: await realpath(args["forge-bin"] ?? process.execPath).catch(() => args["forge-bin"] ?? process.execPath),
    group: PersistentLinux.defaults.group,
    unitPath: PersistentLinux.defaults.unitPath,
    attachPath: PersistentLinux.defaults.attachPath,
    credstore: PersistentLinux.defaults.credstore,
    credstoreEncrypted: PersistentLinux.defaults.credstoreEncrypted,
  } satisfies PersistentLinux.Plan
  const fresh = !args["server-id"] && installed.serverID === undefined
  // A new server's ID is generated when install --apply runs; showing a random one here would not match it.
  const shown = fresh ? { ...target, serverID: "<assigned by install --apply>" } : target
  return { target, shown, conflicts }
}

async function stdinText() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function keyFromText(text: string) {
  const [keyID = "", key = ""] = text.trim().split(/\r?\n/)
  return { keyID: keyID.trim(), encoded: key.trim(), key: parseKey(keyID.trim(), key.trim()).key }
}

function assertOpens(
  report: Awaited<ReturnType<typeof VaultVerification.inspectFile>>,
  keyID: string,
  label: string,
  serverID?: string,
) {
  if (report.keyIDs.length > 1) throw refuse(`${label} contains secrets sealed by multiple key IDs`)
  if (report.keyIDs.length === 1 && report.keyIDs[0] !== keyID)
    throw refuse(`${label} belongs to key ${report.keyIDs[0]}, not ${keyID}`)
  const failed = report.stores.filter((store) => !store.opened).map((store) => store.store)
  if (failed.length || report.verification === "invalid")
    throw refuse(`the key cannot open ${label}${failed.length ? ` (${failed.join(", ")})` : ""}`)
  if (report.owner?.mode === "persistent" && report.owner.serverID !== serverID)
    throw refuse(`${label} is already owned by persistent server ${report.owner.serverID}`)
}

function printSummary(target: PersistentLinux.Plan, notes: string[]) {
  console.log(`Service:      ${target.unitPath} (user ${target.user})`)
  console.log(`Server ID:    ${target.serverID}`)
  console.log(`Data root:    ${target.dataRoot}`)
  console.log(`Database:     ${PersistentLinux.databasePath(target.dataRoot)}`)
  console.log(`Listener:     http://127.0.0.1:${target.port} (loopback only)`)
  console.log(`Key source:   systemd credentials in ${target.credstoreEncrypted}`)
  console.log(`Attach file:  ${target.attachPath} (0640 root:${target.group})`)
  for (const note of notes) console.log(`Note:         ${note}`)
}

const PreflightCommand = cmd<{}, PlanArgs>({
  command: "preflight",
  describe: "check whether this Linux host can run a persistent server (changes nothing)",
  builder: planOptions as never,
  async handler(args) {
    const { target, shown, conflicts } = await plan(args)
    const { problems, notes } = PersistentLinux.evaluate(await PersistentLinux.gather(target), target)
    printSummary(shown, notes)
    for (const problem of [...conflicts, ...problems]) console.log(`Problem:      ${problem}`)
    if (conflicts.length || problems.length) process.exitCode = 1
  },
})

const UnitCommand = cmd<{}, PlanArgs>({
  command: "unit",
  describe: "print the systemd unit for a persistent server",
  builder: planOptions as never,
  async handler(args) {
    process.stdout.write(PersistentLinux.unit((await plan(args)).shown))
  },
})

const InstallCommand = cmd<{}, PlanArgs & { apply?: boolean; "key-stdin"?: boolean; "import-db"?: string; "recovery-file"?: string }>({
  command: "install",
  describe: "set up a persistent systemd service; prints the plan unless --apply is given",
  builder: ((yargs: Argv) =>
    planOptions(yargs)
      .option("apply", { type: "boolean", describe: "make the changes" })
      .option("key-stdin", { type: "boolean", describe: "import an existing key: key ID and base64 key on stdin" })
      .option("import-db", { type: "string", describe: "copy a stopped quick-connect database into the data root" })
      .option("recovery-file", {
        type: "string",
        describe: "where to write the recovery copy of a newly generated key (required for a fresh key)",
      })) as never,
  async handler(args) {
    const runner = PersistentLinux.run
    const { target, shown, conflicts } = await plan(args)
    const facts = await PersistentLinux.gather(target)
    const evaluated = PersistentLinux.evaluate(facts, target)
    const problems = [...conflicts, ...evaluated.problems]
    printSummary(args.apply ? target : shown, evaluated.notes)
    if (problems.length) {
      for (const problem of problems) console.log(`Problem:      ${problem}`)
      throw refuse("preflight failed; nothing was changed")
    }
    if (!args.apply) {
      console.log("\nDry run. Unit to install:\n")
      process.stdout.write(PersistentLinux.unit(shown))
      console.log("\nRe-run with --apply to make these changes.")
      return
    }

    if (args["key-stdin"] && facts.keyCredential)
      throw refuse("this host already has a vault key credential; refusing to replace it")
    const imported = args["key-stdin"] ? keyFromText(await stdinText()) : undefined
    const hasData = facts.database || args["import-db"] !== undefined
    const key = imported
      ? imported
      : facts.keyCredential
        ? keyFromText(
            `${(await readFile(join(target.credstore, PersistentLinux.credentials.keyID), "utf8")).trim()}\n` +
              (await PersistentLinux.decryptCredential(runner, target.credstoreEncrypted, PersistentLinux.credentials.key)),
          )
        : hasData
          ? undefined
          : (() => {
              const fresh = PersistentLinux.newKey()
              return { ...fresh, encoded: fresh.key, key: parseKey(fresh.keyID, fresh.key).key }
            })()
    if (!key) throw refuse("existing data needs its original key (--key-stdin); a replacement key is never created")
    if (!facts.keyCredential && !imported && !args["recovery-file"])
      throw refuse("a fresh key needs --recovery-file so a recovery copy exists before first use")
    // Another account able to write the directory could swap the file before it is moved into place.
    if (
      !facts.keyCredential &&
      !imported &&
      !(await PersistentLinux.writableOnlyByRoot(dirname(resolve(args["recovery-file"]!))))
    )
      throw refuse(`--recovery-file must be in a directory writable only by root, such as /root`)
    const importDB = args["import-db"]
      ? await realpath(args["import-db"]).catch(() => {
          throw refuse(`${args["import-db"]} does not exist`)
        })
      : undefined
    // SQLite running as root follows the WAL, SHM, and lock file names beside a database and chowns
    // what it opens, so root never opens one in a directory another account can write.
    if (importDB && !(await PersistentLinux.writableOnlyByRoot(dirname(importDB))))
      throw refuse(
        `${args["import-db"]} is in a directory another account can write. Stop its server, copy the database ` +
          "(and its -wal file, if any) into a directory writable only by root, and import that copy",
      )

    const user = facts.user!
    const database = PersistentLinux.databasePath(target.dataRoot)
    const service = PersistentLinux.defaults.serviceName
    // Stop the service and take its data root back before working in it as root, so nothing the
    // service account plants there can redirect root's writes or ownership changes.
    if (facts.serviceActive) await runner("systemctl", ["stop", service])
    let owned = false
    try {
      await PersistentLinux.claimDataRoot(target.dataRoot)
      try {
        if (importDB) {
          if (facts.database) throw refuse(`${database} already exists; refusing to overwrite it`)
          assertOpens(await VaultVerification.inspectFile(importDB, key), key.keyID, importDB)
          const release = await Database.acquireOwnerLock(importDB)
          try {
            await Effect.gen(function* () {
              const db = yield* Database.openReadonly(importDB)
              yield* db.run(sql`VACUUM INTO ${database}`).pipe(Effect.orDie)
            }).pipe(Effect.scoped, Effect.runPromise)
          } finally {
            release()
          }
        } else if (facts.database) {
          const report = await VaultVerification.inspectFile(database, key)
          assertOpens(report, key.keyID, database, target.serverID)
          owned = report.owner?.mode === "persistent"
        }

        // A re-run over this server's own database leaves its owner record as it is.
        if (!owned && (await stat(database).then(() => true, () => false)))
          await Effect.gen(function* () {
            yield* ServerOwner.promote(yield* Database.openExisting(database), {
              serverID: target.serverID,
              keyID: key.keyID,
            })
          }).pipe(Effect.scoped, Effect.runPromise)
      } finally {
        await PersistentLinux.releaseDataRoot(target.dataRoot, user)
      }
    } catch (error) {
      if (facts.serviceActive) await runner("systemctl", ["start", service])
      throw error
    }

    if (!facts.keyCredential) {
      if (!imported)
        await PersistentLinux.writeRestricted(args["recovery-file"]!, `${key.keyID}\n${key.encoded}\n`, 0o400)
      // The key credential is what marks the key as installed, so it is written last.
      await PersistentLinux.writeRestricted(join(target.credstore, PersistentLinux.credentials.keyID), `${key.keyID}\n`, 0o600)
      await PersistentLinux.encryptCredential(runner, target.credstoreEncrypted, PersistentLinux.credentials.key, key.encoded)
    }
    const password = facts.passwordCredential
      ? await PersistentLinux.decryptCredential(runner, target.credstoreEncrypted, PersistentLinux.credentials.password)
      : PersistentLinux.newPassword()
    if (!facts.passwordCredential)
      await PersistentLinux.encryptCredential(runner, target.credstoreEncrypted, PersistentLinux.credentials.password, password)
    await PersistentLinux.protectCredentials(target.credstoreEncrypted)

    if ((await PersistentLinux.groupID(target.group, runner)) === undefined) {
      const created = await runner("groupadd", ["--system", target.group])
      if (created.code !== 0) throw new Error(`groupadd ${target.group} failed: ${created.stderr.trim()}`)
    }
    const gid = (await PersistentLinux.groupID(target.group, runner))!
    await PersistentLinux.writeRestricted(target.attachPath, PersistentLinux.attachRecord(target, password), 0o640, {
      uid: 0,
      gid,
    })
    await PersistentLinux.writeRestricted(target.unitPath, PersistentLinux.unit(target), 0o644)
    // restart, not enable --now: a re-run must load an updated binary or unit into a running service.
    for (const step of [["daemon-reload"], ["enable", service], ["restart", service]]) {
      const result = await runner("systemctl", step)
      if (result.code !== 0) throw new Error(`systemctl ${step.join(" ")} failed: ${result.stderr.trim()}`)
    }

    const descriptor = await waitForDescriptor(target, password, runner).catch(async (error: Error) => {
      const logs = await runner("journalctl", ["-u", service, "-n", "15", "--no-pager", "-o", "cat"])
      // A new service that cannot start would otherwise restart forever; leave an existing one to its operator.
      if (!facts.existingUnit) await runner("systemctl", ["disable", "--now", service])
      throw refuse(
        [
          error.message,
          logs.stdout.trim(),
          facts.existingUnit
            ? `Check: journalctl -u ${service}`
            : "The new service was stopped and disabled. Fix the cause above and re-run install.",
        ].join("\n\n"),
      )
    })
    if (descriptor.keyID !== key.keyID) throw refuse(`service reports key ${descriptor.keyID}, expected ${key.keyID}`)
    console.log(`\nPersistent server ${descriptor.serverID} is running with key ${descriptor.keyID}.`)
    if (!imported && !facts.keyCredential)
      console.log(`Move the recovery copy in ${args["recovery-file"]} to offline storage, then delete it from this host.`)
    console.log(`Add users who may attach to the ${target.group} group. Reboot once and re-run preflight to confirm startup.`)
  },
})

async function waitForDescriptor(target: PersistentLinux.Plan, password: string, runner: PersistentLinux.Runner) {
  const authorization = `Basic ${Buffer.from(`forge:${password}`).toString("base64")}`
  const restarts = async () =>
    Number(
      (await runner("systemctl", ["show", "-p", "NRestarts", "--value", PersistentLinux.defaults.serviceName])).stdout.trim(),
    ) || 0
  const baseline = await restarts()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${target.port}/global/server`, {
      headers: { authorization },
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined)
    if (response?.ok) {
      const descriptor = (await response.json()) as { serverID: string; keyID: string; mode: string }
      if (descriptor.serverID !== target.serverID || descriptor.mode !== "persistent")
        throw new Error(`port ${target.port} answers as ${descriptor.serverID}, not ${target.serverID}`)
      return descriptor
    }
    if ((await restarts()) - baseline >= 2) throw new Error("the service keeps exiting during startup")
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error("the service did not become healthy within 60 seconds")
}

const VerifyKeyCommand = cmd<{}, { db: string }>({
  command: "verify-key",
  describe: "check, read-only, that a key (key ID and base64 key on stdin) opens a database",
  builder: ((yargs: Argv) =>
    yargs.option("db", { type: "string", demandOption: true, describe: "database file to check" })) as never,
  async handler(args) {
    const key = keyFromText(await stdinText())
    const report = await VaultVerification.inspectFile(args.db, key)
    console.log(JSON.stringify({ keyID: key.keyID, ...report }))
    assertOpens(report, key.keyID, args.db)
  },
})

export const PersistentCommand = cmd({
  command: "persistent",
  describe: "set up and check a persistent server on this host",
  builder: (yargs: Argv) =>
    yargs
      .command(PreflightCommand)
      .command(UnitCommand)
      .command(InstallCommand)
      .command(VerifyKeyCommand)
      .demandCommand(),
  handler() {},
})
