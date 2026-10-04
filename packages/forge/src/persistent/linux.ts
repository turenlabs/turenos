export * as PersistentLinux from "./linux"

import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  cp,
  lchown,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"

// The data root and port stay clear of the quick-connect shim, which uses the default XDG data path
// and prefers port 4096, and of any older manual setup that used /var/lib/turenos as a home directory.
export const defaults = {
  serviceName: "turenos.service",
  unitPath: "/etc/systemd/system/turenos.service",
  dataRoot: "/var/lib/turenos-server",
  // Written when the installer first takes a data root, so a later run can tell its own directory
  // from an unrelated one that --data-root happens to name.
  dataRootMarker: ".turenos-persistent",
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
  dataRootEmpty: boolean
  dataRootMarked: boolean
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
  // A newline in any value would start a new unit line, so this holds even for a caller that skipped validate().
  const unsafe = Object.entries(plan).find(([, value]) => typeof value === "string" && /[\x00-\x1f\x7f]/.test(value))
  if (unsafe) throw new Error(`refusing to render a unit: ${unsafe[0]} contains a control character`)
  const encrypted = (name: string) => join(plan.credstoreEncrypted, name)
  return [
    "[Unit]",
    "Description=TurenOS persistent server",
    "After=network-online.target",
    "Wants=network-online.target",
    // A binary that rejects the unit's flags would otherwise restart every RestartSec forever.
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `User=${plan.user}`,
    // Without a passwd home systemd leaves HOME unset, which is better than an empty value.
    ...(plan.home ? [`Environment=HOME=${plan.home}`] : []),
    `Environment=XDG_DATA_HOME=${join(plan.dataRoot, "data")}`,
    `Environment=XDG_CONFIG_HOME=${join(plan.dataRoot, "config")}`,
    `Environment=XDG_STATE_HOME=${join(plan.dataRoot, "state")}`,
    `Environment=XDG_CACHE_HOME=${join(plan.dataRoot, "cache")}`,
    `Environment=FORGE_DB=${databasePath(plan.dataRoot)}`,
    "Environment=FORGE_SERVER_MODE=persistent",
    "Environment=FORGE_PERSISTENT_UNIT=1",
    `Environment=FORGE_SERVER_ID=${plan.serverID}`,
    `Environment=FORGE_SERVER_PASSWORD_CREDENTIAL=${credentials.password}`,
    `LoadCredentialEncrypted=${credentials.key}:${encrypted(credentials.key)}`,
    `LoadCredential=${credentials.keyID}:${join(plan.credstore, credentials.keyID)}`,
    `LoadCredentialEncrypted=${credentials.password}:${encrypted(credentials.password)}`,
    `ExecStart=${plan.forgeBin} serve --key-source systemd-credentials --hostname 127.0.0.1 --port ${plan.port}`,
    "Restart=on-failure",
    // EX_CONFIG: the server found a configuration error that a restart cannot fix.
    "RestartPreventExitStatus=78",
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
    forgeBin: line(/^ExecStart=(\S+) serve /m),
    serverID: line(/^Environment=FORGE_SERVER_ID=(\S+)$/m),
    user: line(/^User=(\S+)$/m),
    dataRoot: dataHome ? dirname(dataHome) : undefined,
    port: port ? Number(port) : undefined,
  }
}

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/
const SERVER_ID = /^[A-Za-z0-9._-]{1,128}$/
// Values are written into a systemd unit, so anything that could split or reinterpret a line is refused.
const UNIT_PATH = /^(\/[A-Za-z0-9._+-]+)+$/

export function validate(plan: Plan) {
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
  // Setup takes the data root as root while it works in it; an interrupted run (a dropped SSH session,
  // Ctrl-C under sudo) leaves it root-owned, and a re-run finishes handing it back.
  if (facts.user && facts.dataRootOwner === 0)
    notes.push(`${plan.dataRoot} is root-owned from an interrupted setup; it will be handed back to ${plan.user}`)
  if (
    facts.user &&
    facts.dataRootOwner !== undefined &&
    facts.dataRootOwner !== 0 &&
    facts.dataRootOwner !== facts.user.uid
  )
    problems.push(`${plan.dataRoot} already exists and belongs to another account; choose another --data-root`)
  // Setup hands the data root to the service account, so it must not take over an unrelated directory
  // such as /var/lib. Marked roots are this installer's own, and a unit naming the root predates the marker.
  if (
    facts.dataRootOwner !== undefined &&
    !facts.dataRootEmpty &&
    !facts.dataRootMarked &&
    installed(facts.existingUnit).dataRoot !== plan.dataRoot
  )
    problems.push(`${plan.dataRoot} is not empty and was not created by this installer; choose another --data-root`)
  const existingID = installed(facts.existingUnit).serverID
  if (facts.existingUnit !== undefined && existingID !== plan.serverID)
    problems.push(`${plan.unitPath} already exists for a different server; it was left untouched`)
  if (facts.serviceActive && facts.existingUnit === undefined)
    problems.push(`${defaults.serviceName} is active without ${plan.unitPath}; refusing to stop an unknown service`)
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
    dataRootEmpty: await readdir(plan.dataRoot).then(
      (entries) => entries.length === 0,
      () => false,
    ),
    dataRootMarked: await lstat(join(plan.dataRoot, defaults.dataRootMarker)).then(
      (info) => info.isFile() && info.uid === 0,
      () => false,
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

const layout = ["data", "data/forge", "config", "config/forge", "state", "cache"]

function databaseFiles(dataRoot: string) {
  const database = databasePath(dataRoot)
  return [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]
}

/**
 * Takes the data root from the service account while setup works in it as root. With the parent
 * writable only by root and the root itself root-owned 0700, the account cannot plant or swap links
 * that would redirect root's writes or ownership changes elsewhere. Stop the service first.
 */
export async function withDataRoot<T>(dataRoot: string, owner: { uid: number; gid: number }, work: () => Promise<T>) {
  const root = await lstat(dataRoot).catch(() => undefined)
  if (root && !root.isDirectory()) throw new Error(`${dataRoot} is not a directory; refusing to follow it`)
  // A rejected initial layout has acquired nothing and must not enter ownership cleanup.
  await checkLayout(dataRoot)
  const directories: Array<{ handle: FileHandle; claimed: boolean }> = []
  try {
    // Hold every parent root-owned until its children are released. Retained directory
    // descriptors do not allow the service account to mutate a root-owned 0700 directory.
    for (const path of [dataRoot, ...layout.map((dir) => join(dataRoot, dir))]) {
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      const entry = {
        handle: await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
        claimed: false,
      }
      directories.push(entry)
      await entry.handle.chown(0, 0)
      entry.claimed = true
      await entry.handle.chmod(0o700)
      // Right after the root is claimed, so an interrupted run still leaves the marker its re-run needs.
      if (path === dataRoot)
        await writeFile(join(dataRoot, defaults.dataRootMarker), "created by forge persistent install\n", {
          flag: "wx",
          mode: 0o600,
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        })
    }
    await checkLayout(dataRoot)
    try {
      return await work()
    } finally {
      // SQLite may have created files. Check the opened object while its parents are
      // still protected; never change ownership through a rejected link or pathname.
      for (const path of databaseFiles(dataRoot)) {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
            return undefined
          },
        )
        if (!handle) continue
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.nlink !== 1)
            throw new Error(`${path} is not a regular file with a single link; refusing to release it`)
          await handle.chown(owner.uid, owner.gid)
        } finally {
          await handle.close()
        }
      }
    }
  } finally {
    try {
      // Only successfully claimed directories are restored, through their original
      // handles. A partial claim never re-traverses an untrusted descendant.
      for (const entry of directories.toReversed()) if (entry.claimed) await entry.handle.chown(owner.uid, owner.gid)
    } finally {
      await Promise.all(directories.map((entry) => entry.handle.close()))
    }
  }
}

async function checkLayout(dataRoot: string) {
  for (const dir of layout) {
    const path = join(dataRoot, dir)
    const info = await lstat(path).catch(() => undefined)
    if (info && !info.isDirectory()) throw new Error(`${path} is not a directory; refusing to follow it`)
  }
  for (const file of databaseFiles(dataRoot)) {
    const info = await lstat(file).catch(() => undefined)
    if (info && (!info.isFile() || info.nlink > 1))
      throw new Error(`${file} is not a regular file with a single link; refusing to follow it`)
  }
}

// Regenerable or transient state that an import leaves behind, next to the database files.
const importSkipped = new Set(["log", "repos"])

/**
 * Copies a staged data or config tree into the claimed data root and hands it to the service
 * account. The staging directory, its parents, and every entry in it must be owned by root with no
 * group or other write on any directory, like an imported database, so the account whose data this is
 * cannot swap entries under root while they are read. Symlinks are
 * copied as links, never followed; database files come from `VACUUM INTO`, not from here.
 */
export async function importTree(
  source: string,
  destination: string,
  owner: { uid: number; gid: number },
  // Production trusts only root. The trusted uid and the parent check are parameters so a test that
  // cannot be root can exercise each refusal on its own.
  trusted: { uid: number; parentSafe: (path: string) => Promise<boolean> } = { uid: 0, parentSafe: writableOnlyByRoot },
) {
  const real = await realpath(source).catch(() => {
    throw new Error(`${source} does not exist`)
  })
  if (!(await stat(real)).isDirectory()) throw new Error(`${source} is not a directory`)
  if (!(await trusted.parentSafe(dirname(real))))
    throw new Error(
      `${source} is in a directory another account can write; copy it into a directory writable only by root and import that copy`,
    )
  // Everything that will be copied is checked before anything is, so an entry the account can swap
  // never reaches the lchown below.
  const entries = (await readdir(real)).filter(
    (entry) => !importSkipped.has(entry) && !/^forge[^/]*\.db(-wal|-shm|-journal|\.owner\.lock)?$/.test(entry),
  )
  await checkStaged(real, trusted.uid, entries)
  // The destination may be a managed directory the claim created; entries are copied one by one
  // into it, and any that already exist are an interrupted import that must start over.
  if (!(await lstat(destination).catch(() => undefined))) await mkdir(destination, { mode: 0o700 })
  for (const entry of entries) {
    if (await lstat(join(destination, entry)).catch(() => undefined))
      throw new Error(`${join(destination, entry)} already exists; remove the data root to retry an interrupted import`)
    await cp(join(real, entry), join(destination, entry), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
    await chownTree(join(destination, entry), owner)
  }
}

/** Refuses entries the service account could have swapped: not root-owned, or a directory others can write. */
async function checkStaged(path: string, uid: number, children?: string[]) {
  // lstat, so a symlink is judged as the link itself and never followed.
  const info = await lstat(path)
  if (info.uid !== uid) throw new Error(`${path} is not owned by root; import a copy made by root`)
  if (!info.isDirectory()) return
  if ((info.mode & 0o022) !== 0)
    throw new Error(`${path} is writable by another account; remove group and other write access or import a copy`)
  for (const entry of children ?? (await readdir(path))) await checkStaged(join(path, entry), uid)
}

async function chownTree(root: string, owner: { uid: number; gid: number }) {
  if ((await lstat(root)).isDirectory())
    for (const entry of await readdir(root)) await chownTree(join(root, entry), owner)
  await lchown(root, owner.uid, owner.gid)
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
  if (!(await writableOnlyByRoot(credstoreEncrypted)))
    throw new Error(`${credstoreEncrypted} must be writable only by root`)
  const destination = join(credstoreEncrypted, name)
  const staging = `${destination}.${randomUUID()}.tmp`
  try {
    const result = await runner("systemd-creds", ["encrypt", `--name=${name}`, "-", staging], value)
    if (result.code !== 0) throw new Error(`systemd-creds encrypt ${name} failed: ${result.stderr.trim()}`)
    await chmod(staging, 0o600)
    // Linking publishes the complete blob without replacing a credential another install wrote.
    await link(staging, destination)
  } finally {
    await unlink(staging).catch(() => undefined)
  }
}

/** Encrypted blobs are useless without the host key, but keep them root-only like the rest of the store. */
export async function protectCredentials(credstoreEncrypted: string) {
  if (!(await writableOnlyByRoot(credstoreEncrypted)))
    throw new Error(`${credstoreEncrypted} must be writable only by root`)
  for (const name of [credentials.key, credentials.password]) {
    const path = join(credstoreEncrypted, name)
    const info = await lstat(path).catch(() => undefined)
    if (!info) continue
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${path} is not a regular file with one link`)
    await chmod(path, 0o600)
  }
}

export async function decryptCredential(runner: Runner, credstoreEncrypted: string, name: string) {
  if (!(await writableOnlyByRoot(credstoreEncrypted)))
    throw new Error(`${credstoreEncrypted} must be writable only by root`)
  const path = join(credstoreEncrypted, name)
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1) throw new Error(`${path} is not a regular file with one link`)
  const result = await runner("systemd-creds", ["decrypt", `--name=${name}`, path, "-"])
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
  if (!(await writableOnlyByRoot(dirname(path)))) throw new Error(`${dirname(path)} must be writable only by root`)
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
