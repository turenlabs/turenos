export * as PersistentLinux from "./linux"

import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lchown, lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"

// The data root and port stay clear of the quick-connect shim, which uses the default XDG data path
// and prefers port 4096, and of any older manual setup that used /var/lib/turenos as a home directory.
export const defaults = {
  serviceName: "turenos.service",
  unitPath: "/etc/systemd/system/turenos.service",
  dataRoot: "/var/lib/turenos-server",
  group: "turenos-operators",
  attachPath: "/etc/turenos/attach.json",
  credstore: "/etc/credstore",
  credstoreEncrypted: "/etc/credstore.encrypted",
  port: 4097,
} as const

export const credentials = {
  key: "forge-secret-vault-key",
  keyID: "forge-secret-vault-key-id",
  password: "forge-server-password",
} as const

export type Plan = {
  user: string
  home: string
  dataRoot: string
  port: number
  serverID: string
  forgeBin: string
  group: string
  unitPath: string
  attachPath: string
  credstore: string
  credstoreEncrypted: string
}

export type Facts = {
  platform: NodeJS.Platform
  root: boolean
  pid1: string | undefined
  systemdVersion: number | undefined
  systemdCreds: boolean
  tpm2: boolean
  user: { name: string; home: string; uid: number; gid: number } | undefined
  existingUnit: string | undefined
  keyCredential: boolean
  passwordCredential: boolean
  database: boolean
  dataRootOwner: number | undefined
  dataRootLink: boolean
  dataRootParentSafe: boolean
  forgeBinSafe: boolean
  portInUse: boolean
  serviceActive: boolean
}

export type Runner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export const run: Runner = (command, args, input) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.once("error", (error) => resolve({ code: null, stdout, stderr: error.message }))
    child.once("close", (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })

export function databasePath(dataRoot: string) {
  return join(dataRoot, "data", "forge", "forge.db")
}

export function parseSystemdVersion(output: string) {
  const match = /^systemd (\d+)/m.exec(output)
  return match ? Number(match[1]) : undefined
}

/** The unit reads every secret through systemd credentials; nothing secret is in the unit text. */
export function unit(plan: Plan) {
  const encrypted = (name: string) => join(plan.credstoreEncrypted, name)
  return [
    "[Unit]",
    "Description=TurenOS persistent server",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${plan.user}`,
    `Environment=HOME=${plan.home}`,
    `Environment=XDG_DATA_HOME=${join(plan.dataRoot, "data")}`,
    `Environment=XDG_CONFIG_HOME=${join(plan.dataRoot, "config")}`,
    `Environment=XDG_STATE_HOME=${join(plan.dataRoot, "state")}`,
    `Environment=XDG_CACHE_HOME=${join(plan.dataRoot, "cache")}`,
    `Environment=FORGE_DB=${databasePath(plan.dataRoot)}`,
    "Environment=FORGE_SERVER_MODE=persistent",
    `Environment=FORGE_SERVER_ID=${plan.serverID}`,
    `Environment=FORGE_SERVER_PASSWORD_CREDENTIAL=${credentials.password}`,
    `LoadCredentialEncrypted=${credentials.key}:${encrypted(credentials.key)}`,
    `LoadCredential=${credentials.keyID}:${join(plan.credstore, credentials.keyID)}`,
    `LoadCredentialEncrypted=${credentials.password}:${encrypted(credentials.password)}`,
    `ExecStart=${plan.forgeBin} serve --key-source systemd-credentials --hostname 127.0.0.1 --port ${plan.port}`,
    "Restart=on-failure",
    "RestartSec=5",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n")
}

export function attachRecord(plan: Plan, password: string) {
  return `${JSON.stringify({
    version: 1,
    serverID: plan.serverID,
    url: `http://127.0.0.1:${plan.port}`,
    username: "forge",
    password,
  })}\n`
}

/** Reads the settings an installed unit was written with, so re-running setup keeps them. */
export function installed(text: string | undefined) {
  const line = (pattern: RegExp) => (text ? pattern.exec(text)?.[1] : undefined)
  const dataHome = line(/^Environment=XDG_DATA_HOME=(\S+)$/m)
  const port = line(/^ExecStart=\S+ serve .*--port (\d+)/m)
  return {
    serverID: line(/^Environment=FORGE_SERVER_ID=(\S+)$/m),
    user: line(/^User=(\S+)$/m),
    dataRoot: dataHome ? dirname(dataHome) : undefined,
    port: port ? Number(port) : undefined,
    forgeBin: line(/^ExecStart=(\S+) serve /m),
  }
}

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/
const SERVER_ID = /^[A-Za-z0-9._-]{1,128}$/
// Values are written into a systemd unit, so anything that could split or reinterpret a line is refused.
const UNIT_PATH = /^(\/[A-Za-z0-9._+-]+)+$/

function validate(plan: Plan) {
  const problems: string[] = []
  if (!USER_NAME.test(plan.user)) problems.push(`invalid service user name: ${plan.user}`)
  if (!SERVER_ID.test(plan.serverID)) problems.push(`server ID may contain only letters, digits, ".", "_", and "-"`)
  const paths: Array<[string, string]> = [
    ["data root", plan.dataRoot],
    ["forge binary", plan.forgeBin],
    ...(plan.home ? [["home directory", plan.home] as [string, string]] : []),
  ]
  for (const [label, value] of paths)
    if (!UNIT_PATH.test(value) || value.split("/").some((part) => part === "." || part === ".."))
      problems.push(`${label} must be an absolute path of letters, digits, ".", "_", "+", and "-": ${value}`)
  if (!Number.isInteger(plan.port) || plan.port < 1024 || plan.port > 65535)
    problems.push(`port must be an integer from 1024 to 65535: ${plan.port}`)
  return problems
}

/** Problems block setup; notes are shown in the summary. Nothing here changes the host. */
export function evaluate(facts: Facts, plan: Plan) {
  const problems = validate(plan)
  const notes: string[] = []
  if (facts.platform !== "linux") problems.push("persistent Linux setup runs only on Linux")
  if (!facts.root) problems.push("setup must run as root (for example with sudo)")
  if (facts.pid1 !== "systemd") problems.push("PID 1 is not systemd; use quick connect or another service manager")
  if (facts.systemdVersion === undefined) problems.push("could not determine the systemd version")
  if (facts.systemdVersion !== undefined && facts.systemdVersion < 250)
    problems.push(`systemd ${facts.systemdVersion} is too old for encrypted credentials (250 or later is required)`)
  if (!facts.systemdCreds)
    problems.push("systemd-creds is unavailable; refusing to fall back to an unprotected key file")
  if (!facts.user) problems.push(`service user ${plan.user} does not exist`)
  if (facts.user?.uid === 0) problems.push("the service must not run as root; choose an unprivileged --user")
  // Setup runs as root inside the data root, so the account it serves must not be able to swap it for a link.
  if (!facts.dataRootParentSafe)
    problems.push(`${dirname(plan.dataRoot)} must exist, and it and every parent must be writable only by root`)
  if (facts.dataRootLink) problems.push(`${plan.dataRoot} is a symbolic link; use a real directory`)
  // The service loads its vault key and password into whatever binary the unit names, so an account
  // able to replace that binary could read both.
  if (!facts.forgeBinSafe)
    problems.push(`${plan.forgeBin} must be a root-owned file in directories writable only by root; pass --forge-bin`)
  if (facts.user && facts.dataRootOwner !== undefined && facts.dataRootOwner !== facts.user.uid)
    problems.push(`${plan.dataRoot} already exists and belongs to another account; choose another --data-root`)
  const existingID = installed(facts.existingUnit).serverID
  if (facts.existingUnit !== undefined && existingID !== plan.serverID)
    problems.push(`${plan.unitPath} already exists for a different server; it was left untouched`)
  const ownPort =
    facts.serviceActive && existingID === plan.serverID && installed(facts.existingUnit).port === plan.port
  if (facts.portInUse && !ownPort) problems.push(`127.0.0.1:${plan.port} is already in use; choose another --port`)
  if (facts.database && !facts.keyCredential)
    notes.push("a database already exists at the pinned data root; its key must be imported with --key-stdin")
  notes.push(
    facts.tpm2
      ? "credentials are bound to the host key and TPM2"
      : "no TPM2 found; credentials are bound to the host key only",
  )
  notes.push("keep a separate recovery copy of the vault key and key ID; host-bound encryption is not a backup")
  return { problems, notes }
}

export async function gather(plan: Plan, runner: Runner = run): Promise<Facts> {
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    )
  const passwd = await runner("getent", ["passwd", plan.user])
  const fields = passwd.code === 0 ? passwd.stdout.trim().split(":") : []
  const systemctl = await runner("systemctl", ["--version"])
  return {
    platform: process.platform,
    root: typeof process.getuid === "function" && process.getuid() === 0,
    pid1: await readFile("/proc/1/comm", "utf8").then(
      (value) => value.trim(),
      () => undefined,
    ),
    systemdVersion: systemctl.code === 0 ? parseSystemdVersion(systemctl.stdout) : undefined,
    systemdCreds: (await runner("systemd-creds", ["--version"])).code === 0,
    tpm2: (await runner("systemd-creds", ["has-tpm2", "--quiet"])).code === 0,
    user:
      fields.length >= 6
        ? { name: fields[0]!, uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5]! }
        : undefined,
    existingUnit: await readFile(plan.unitPath, "utf8").catch(() => undefined),
    keyCredential: await exists(join(plan.credstoreEncrypted, credentials.key)),
    passwordCredential: await exists(join(plan.credstoreEncrypted, credentials.password)),
    database: await exists(databasePath(plan.dataRoot)),
    dataRootOwner: await lstat(plan.dataRoot).then(
      (info) => info.uid,
      () => undefined,
    ),
    dataRootLink: await lstat(plan.dataRoot).then(
      (info) => info.isSymbolicLink(),
      () => false,
    ),
    dataRootParentSafe: await writableOnlyByRoot(dirname(plan.dataRoot)),
    forgeBinSafe: await stat(plan.forgeBin).then(
      (info) =>
        info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0 && writableOnlyByRoot(dirname(plan.forgeBin)),
      () => false,
    ),
    portInUse: await portInUse(plan.port),
    serviceActive: (await runner("systemctl", ["is-active", "--quiet", defaults.serviceName])).code === 0,
  }
}

function portInUse(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(true))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)))
  })
}

export async function writableOnlyByRoot(path: string) {
  const real = await realpath(path).catch(() => undefined)
  if (!real) return false
  for (let dir = real; ; dir = dirname(dir)) {
    const info = await stat(dir)
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) return false
    if (dir === dirname(dir)) return true
  }
}

const layout = ["data", "data/forge", "config", "state", "cache"]

function databaseFiles(dataRoot: string) {
  const database = databasePath(dataRoot)
  return [database, `${database}-wal`, `${database}-shm`]
}

/**
 * Takes the data root from the service account while setup works in it as root. With the parent
 * writable only by root and the root itself root-owned 0700, the account cannot plant or swap links
 * that would redirect root's writes or ownership changes elsewhere. Stop the service first.
 */
export async function claimDataRoot(dataRoot: string) {
  const root = await lstat(dataRoot).catch(() => undefined)
  if (root && !root.isDirectory()) throw new Error(`${dataRoot} is not a directory; refusing to follow it`)
  // Checked before claiming to fail without changing anything, and again after, once nothing can change it.
  await checkLayout(dataRoot, false)
  if (!root) await mkdir(dataRoot, { mode: 0o700 })
  await lchown(dataRoot, 0, 0)
  await chmod(dataRoot, 0o700)
  // A service process can keep a directory open below the root and still create entries in it,
  // and SQLite running as root follows its WAL, SHM, and journal names and chowns what it opens.
  // Top-down, so each parent is root-owned before its child is examined.
  for (const dir of layout) {
    const path = join(dataRoot, dir)
    if (!(await lstat(path).catch(() => undefined))?.isDirectory()) continue
    await lchown(path, 0, 0)
    await chmod(path, 0o700)
  }
  await checkLayout(dataRoot, true)
}

async function checkLayout(dataRoot: string, create: boolean) {
  for (const dir of layout) {
    const path = join(dataRoot, dir)
    const info = await lstat(path).catch(() => undefined)
    if (info && !info.isDirectory()) throw new Error(`${path} is not a directory; refusing to follow it`)
    if (!info && create) await mkdir(path, { mode: 0o700 })
  }
  for (const file of databaseFiles(dataRoot)) {
    const info = await lstat(file).catch(() => undefined)
    if (info && (!info.isFile() || info.nlink > 1))
      throw new Error(`${file} is not a regular file with a single link; refusing to follow it`)
  }
}

/** Hands the data root back to the service account. `lchown` never follows a link. */
export async function releaseDataRoot(dataRoot: string, owner: { uid: number; gid: number }) {
  for (const path of [...layout.map((dir) => join(dataRoot, dir)), ...databaseFiles(dataRoot)]) {
    const info = await lstat(path).catch(() => undefined)
    if (info?.isDirectory() || info?.isFile()) await lchown(path, owner.uid, owner.gid)
  }
  await lchown(dataRoot, owner.uid, owner.gid)
}

export function newServerID() {
  return `srv_${randomUUID()}`
}

export function newKey() {
  return { keyID: `host-${randomUUID()}`, key: randomBytes(32).toString("base64") }
}

export function newPassword() {
  return randomBytes(24).toString("base64url")
}

export async function encryptCredential(runner: Runner, credstoreEncrypted: string, name: string, value: string) {
  await mkdir(credstoreEncrypted, { recursive: true, mode: 0o700 })
  const result = await runner(
    "systemd-creds",
    ["encrypt", `--name=${name}`, "-", join(credstoreEncrypted, name)],
    value,
  )
  if (result.code !== 0) throw new Error(`systemd-creds encrypt ${name} failed: ${result.stderr.trim()}`)
}

/** Encrypted blobs are useless without the host key, but keep them root-only like the rest of the store. */
export async function protectCredentials(credstoreEncrypted: string) {
  for (const name of [credentials.key, credentials.password]) {
    const path = join(credstoreEncrypted, name)
    if ((await lstat(path).catch(() => undefined))?.isFile()) await chmod(path, 0o600)
  }
}

export async function decryptCredential(runner: Runner, credstoreEncrypted: string, name: string) {
  const result = await runner("systemd-creds", ["decrypt", `--name=${name}`, join(credstoreEncrypted, name), "-"])
  if (result.code !== 0) throw new Error(`systemd-creds decrypt ${name} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** Creates the file with its final mode so its content is never readable more broadly. */
export async function writeRestricted(
  path: string,
  content: string,
  mode: number,
  owner?: { uid: number; gid: number },
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  const staging = `${path}.${process.pid}.tmp`
  const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
  try {
    await handle.writeFile(content)
    // Through the open handle, so a link swapped in at the staging path cannot redirect them.
    await handle.chmod(mode)
    if (owner) await handle.chown(owner.uid, owner.gid)
  } finally {
    await handle.close()
  }
  await rename(staging, path)
}

export async function groupID(name: string, runner: Runner = run) {
  const result = await runner("getent", ["group", name])
  return result.code === 0 ? Number(result.stdout.split(":")[2]) : undefined
}
