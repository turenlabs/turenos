import { randomBytes, randomUUID } from "node:crypto"
import { accessSync, constants, existsSync, statSync } from "node:fs"
import { mkdir, mkdtemp, open, readlink, rename, rm } from "node:fs/promises"
import { connect as connectSocket, createServer, type Socket } from "node:net"
import { homedir, hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { isRecord } from "./response-validation"

/**
 * Every TurenOS server this client can reach. Local servers are discovered from the records their
 * owners publish (the desktop's attach.json, the quick-connect shim's ~/.forge/run, the persistent
 * server's /etc/turenos/attach.json); remote servers are saved here or imported from the desktop.
 * Nothing in this module stores a password on disk.
 */
export type Target =
  | { kind: "desktop"; id: string; name: string; record: string }
  | { kind: "shim"; id: "shim"; name: string }
  | { kind: "persistent"; id: "persistent"; name: string }
  | { kind: "env"; id: "env"; name: string; url: string }
  | { kind: "headless"; id: "headless"; name: string; binary: string }
  | { kind: "url"; id: string; name: string; url: string; username?: string; passwordEnv?: string; saved: boolean }
  | {
      kind: "ssh"
      id: string
      name: string
      host: string
      user?: string
      port?: number
      identityFile?: string
      saved: boolean
      desktop: boolean
    }

export type Group = "Opened this session" | "This computer" | "Saved" | "From TurenOS Desktop"
export type Entry = { target: Target; group: Group; detail: string }

export type Endpoint = {
  target: Target
  url: string
  username: string
  password?: string
  version?: string
  /** Releases what this client opened for the endpoint, such as an SSH tunnel. */
  close?: () => void
}

/** The server rejected the credentials this client has; the caller may ask for a password and retry. */
export class PasswordRequired extends Error {
  constructor(readonly target: Target) {
    super(`${target.name} needs a password.`)
    this.name = "PasswordRequired"
  }
}

type Options = {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  uid?: number
  /** Saved servers; defaults to $XDG_CONFIG_HOME/turen-tui/servers.json. */
  config?: string
  ssh?: string
  /** Overrides forge CLI discovery; null disables the headless server. */
  forge?: string | null
  persistentRecord?: string
  username?: string
}

type Record = { url: string; username: string; password: string }

const APPS = [
  ["com.turenlabs.forge", "TurenOS"],
  ["com.turenlabs.forge.beta", "TurenOS Beta"],
  ["com.turenlabs.forge.dev", "TurenOS Dev"],
] as const

const running = new Set<ReturnType<typeof Bun.spawn>>()
// Servers and tunnels started here are private to this process; never leave one holding the database.
process.once("exit", () => running.forEach((child) => child.kill()))

export function createServers(options: Options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  // An explicit undefined skips ownership checks, as on Windows.
  const uid = "uid" in options ? options.uid : process.getuid?.()
  const configPath = options.config ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "turen-tui", "servers.json")
  const ssh = options.ssh ?? env.TURENOS_SSH ?? (platform === "win32" ? "ssh.exe" : "ssh")
  const persistentPath = options.persistentRecord ?? "/etc/turenos/attach.json"
  const passwords = new Map<string, string>()
  let saved: Extract<Target, { kind: "url" | "ssh" }>[] = []
  let problems: string[] = []
  let notes: string[] = []
  /** Why saved servers cannot be written, when the file on disk could not be fully read. */
  let unwritable: string | undefined
  /** Saved entries this version cannot read, written back unchanged. */
  let preserved: unknown[] = []
  let imported: Extract<Target, { kind: "ssh" }>[] = []
  let headless: { child: ReturnType<typeof Bun.spawn>; url: string; password: string } | undefined

  async function load() {
    problems = []
    unwritable = undefined
    preserved = []
    saved = []
    const text = await readPrivate(configPath, uid, "self").catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : undefined,
    )
    if (text === null) return
    const value = text === undefined ? undefined : parseJSON(text)
    const list = isRecord(value) && Array.isArray(value.servers) ? value.servers : undefined
    // Never overwrite a file this client could not fully read: a later add or remove would lose it.
    if (!list) {
      unwritable =
        text === undefined
          ? `${configPath} must be a private file you own (chmod 600) before saved servers can be used.`
          : `${configPath} is not a valid server list. Fix it before adding or removing servers.`
      problems = [unwritable]
      return
    }
    saved = list.flatMap((item, index) => {
      const target = savedTarget(item)
      if (target) return [target]
      preserved.push(item)
      problems.push(`Skipped server ${index + 1} in ${configPath}; it is kept unchanged.`)
      return []
    })
  }

  async function persist() {
    if (unwritable) throw new Error(unwritable)
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
    const temporary = `${configPath}.${randomUUID()}`
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(
        JSON.stringify(
          {
            version: 1,
            servers: [
              ...saved.map((target) =>
                target.kind === "url"
                  ? {
                      id: target.id,
                      name: target.name,
                      url: target.url,
                      username: target.username,
                      passwordEnv: target.passwordEnv,
                    }
                  : {
                      id: target.id,
                      name: target.name,
                      ssh: `${sshDestination(target)}${target.port ? `:${target.port}` : ""}`,
                      identityFile: target.identityFile,
                    },
              ),
              ...preserved,
            ],
          },
          null,
          2,
        ) + "\n",
      )
    } finally {
      await handle.close()
    }
    await rename(temporary, configPath).catch(async (error) => {
      await rm(temporary, { force: true })
      throw error
    })
  }

  async function scan(): Promise<Entry[]> {
    const local: Entry[] = []
    const root = appData()
    notes = []
    for (const [appId, name] of APPS) {
      const record = root ? join(root, appId, "attach.json") : undefined
      const found = record ? await desktopRecord(record) : undefined
      if (record && found)
        local.push({
          target: { kind: "desktop", id: `desktop:${appId}`, name, record },
          group: "This computer",
          detail: `Desktop app · port ${new URL(found.url).port}`,
        })
      else if (await desktopRunning(appId))
        notes.push(`${name} is running but does not publish its server. Update it to connect from here.`)
    }
    if (await shimRecord())
      local.push({
        target: { kind: "shim", id: "shim", name: "Quick-connect server" },
        group: "This computer",
        detail: "Started by TurenOS Desktop over SSH · ~/.forge/run",
      })
    if (platform === "linux" && (await persistentRecord().catch(() => undefined)))
      local.push({
        target: { kind: "persistent", id: "persistent", name: "Persistent server" },
        group: "This computer",
        detail: "turenos.service · /etc/turenos/attach.json",
      })
    // TurenOS exports its own sidecar's password to every shell it starts, and that sidecar is not on 4096.
    if (env.FORGE_SERVER_PASSWORD !== undefined && env.FORGE_CLIENT !== "desktop")
      local.push({
        target: { kind: "env", id: "env", name: "Headless server on port 4096", url: "http://127.0.0.1:4096" },
        group: "This computer",
        detail: "127.0.0.1:4096 · FORGE_SERVER_PASSWORD",
      })
    const binary = forgeBinary()
    if (binary)
      local.push({
        target: {
          kind: "headless",
          id: "headless",
          name: headless ? "Private server" : "Start a private server",
          binary,
        },
        group: "This computer",
        detail: headless
          ? `Running · port ${new URL(headless.url).port} · stops when you quit`
          : `forge serve from ${shortPath(binary, home)} · stops when you quit`,
      })
    const destinations = new Set(saved.flatMap((target) => (target.kind === "ssh" ? [sshDestination(target)] : [])))
    return [
      ...local,
      ...saved.map((target) => ({
        target,
        group: "Saved" as const,
        detail: target.kind === "url" ? target.url : `ssh ${sshDestination(target)}`,
      })),
      ...imported
        .filter((target) => !destinations.has(sshDestination(target)))
        .map((target) => ({
          target,
          group: "From TurenOS Desktop" as const,
          detail: `ssh ${sshDestination(target)}`,
        })),
    ]
  }

  /** The local server to open without asking: desktop first, then this host's own servers. */
  async function preferred() {
    return (await scan()).find((entry) => entry.group === "This computer" && entry.target.kind !== "headless")?.target
  }

  async function resolve(
    target: Target,
    input: { signal?: AbortSignal; progress?: (text: string) => void } = {},
  ): Promise<Endpoint> {
    const signal = input.signal ?? new AbortController().signal
    if (target.kind === "headless") return startHeadless(target, signal, input.progress)
    if (target.kind === "ssh") return connectSsh(target, signal, input.progress)
    if (target.kind === "desktop") {
      const record = await desktopRecord(target.record)
      if (!record) throw new Error(`${target.name} is not running. Open the app, or choose another server.`)
      return verified(target, record, signal, `${target.name} is not answering. Restart the app.`)
    }
    if (target.kind === "shim") {
      const record = await shimRecord()
      if (!record) throw new Error("The quick-connect server on this host has stopped.")
      return verified(target, record, signal, "The quick-connect server on this host is not answering.")
    }
    if (target.kind === "persistent")
      return verified(
        target,
        await persistentRecord(),
        signal,
        "The persistent server is not answering. Check it with systemctl status turenos.",
      )
    if (target.kind === "env")
      return verified(
        target,
        { url: target.url, username: username(), password: env.FORGE_SERVER_PASSWORD ?? "" },
        signal,
        "Nothing answered on 127.0.0.1:4096. Start forge serve --port 4096 or choose another server.",
      )
    const password = passwords.get(target.id) ?? (target.passwordEnv ? env[target.passwordEnv] : undefined)
    const url = new URL(target.url)
    if (password && url.protocol !== "https:" && !["127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Server credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
    return verified(
      target,
      { url: url.origin, username: target.username ?? username(), password: password ?? "" },
      signal,
      `${target.name} is not reachable at ${url.origin}.`,
    )
  }

  /** Proves the credentials against the server before any dashboard is built on them. */
  async function verified(
    target: Target,
    record: Record,
    signal: AbortSignal,
    unreachable: string,
    close?: () => void,
  ): Promise<Endpoint> {
    const result = await health(record, signal)
    if (result.status === 401 || result.status === 403) {
      close?.()
      if (target.kind === "url") throw new PasswordRequired(target)
      if (target.kind === "env") throw new Error("The server on 127.0.0.1:4096 rejected FORGE_SERVER_PASSWORD.")
      throw new Error(`${target.name} rejected its published credentials. Restart it, then try again.`)
    }
    if (!result.ok) {
      close?.()
      throw new Error(unreachable)
    }
    return {
      target,
      url: record.url,
      username: record.username,
      password: record.password || undefined,
      version: result.version,
      close,
    }
  }

  async function startHeadless(
    target: Extract<Target, { kind: "headless" }>,
    signal: AbortSignal,
    progress?: (text: string) => void,
  ) {
    if (headless && headless.child.exitCode === null)
      return verified(
        target,
        { url: headless.url, username: "forge", password: headless.password },
        signal,
        "The private server stopped responding.",
      )
    // Session drains are process-local: a second server over the desktop's database could run a session
    // twice. Stable and beta share forge.db with the CLI; dev keeps its own database, as does a CLI
    // pointed at other data.
    const shared = !env.FORGE_DB && (!env.XDG_DATA_HOME || env.XDG_DATA_HOME === join(home, ".local", "share"))
    for (const [appId, name] of shared ? APPS.slice(0, 2) : [])
      if (await desktopRunning(appId))
        throw new Error(`${name} is running and owns your local data. Connect to it instead, or quit it first.`)
    progress?.(`Starting forge serve from ${shortPath(target.binary, home)}…`)
    const password = randomBytes(24).toString("base64url")
    const child = Bun.spawn([target.binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      env: { ...withoutElectron(env), FORGE_SERVER_USERNAME: "forge", FORGE_SERVER_PASSWORD: password },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    running.add(child)
    void child.exited.then(() => running.delete(child))
    let output = ""
    const ready = Promise.withResolvers<number | undefined>()
    const timer = setTimeout(() => ready.resolve(undefined), 90_000)
    const abort = () => ready.resolve(undefined)
    signal.addEventListener("abort", abort, { once: true })
    // Keep draining both pipes after startup so a chatty server never blocks on a full pipe.
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        output = (output + decoder.decode(chunk.value, { stream: true })).slice(-8192)
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)
        if (match) ready.resolve(Number(match[1]))
      }
    }
    void Promise.all([read(child.stdout), read(child.stderr)]).catch(() => {})
    void child.exited.then(() => ready.resolve(undefined))
    const port = await ready.promise.finally(() => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    })
    if (!port) {
      child.kill()
      throw new Error(headlessFailure(output))
    }
    headless = { child, url: `http://127.0.0.1:${port}`, password }
    progress?.("Waiting for the private server…")
    const stop = () => {
      child.kill()
      if (headless?.child === child) headless = undefined
    }
    // The server outlives a switch to another target so switching back is instant; quitting stops it.
    return verified(
      target,
      { url: headless.url, username: "forge", password },
      signal,
      "The private server started but is not answering.",
    ).catch((error) => {
      stop()
      throw error
    })
  }

  async function connectSsh(
    target: Extract<Target, { kind: "ssh" }>,
    signal: AbortSignal,
    progress?: (text: string) => void,
  ): Promise<Endpoint> {
    const destination = sshDestination(target)
    const base = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=ask",
      "-o",
      "ConnectTimeout=15",
      ...(target.port ? ["-p", String(target.port)] : []),
      ...(target.identityFile ? ["-i", target.identityFile] : []),
    ]
    progress?.(`Looking for a TurenOS server on ${target.name}…`)
    const probe = await runSsh([...base, destination, "sh -s"], PROBE, 30_000, signal)
    if (probe.code !== 0 && !/^FORGE_/m.test(probe.stdout)) throw new Error(sshFailure(target, probe.stderr))
    const lines = probe.stdout.split(/\r?\n/g).map((line) => line.trim())
    const attach = lines
      .map((line) => /^FORGE_ATTACH (missing|unreadable|readable)(?: (.*))?$/.exec(line))
      .findLast(Boolean)
    if (attach?.[1] === "unreadable")
      throw new Error(
        `${target.name} runs a managed persistent server, but ${target.user ?? "this account"} cannot read its attach record. Ask an administrator to add you to turenos-operators.`,
      )
    const persistent = attach?.[1] === "readable" ? attachRecord(parseJSON(attach[2] ?? "")) : undefined
    if (attach?.[1] === "readable" && !persistent)
      throw new Error(`${target.name} publishes a malformed persistent-server record.`)
    const remote =
      persistent ??
      shimState(lines) ??
      (await (async () => {
        if (lines.includes("FORGE_REMOTE_MISSING"))
          throw new Error(`TurenOS is not set up on ${target.name} yet. Add it once in TurenOS Desktop to install it.`)
        const key = vaultKey()
        if (!key)
          throw new Error(
            `No TurenOS server is running on ${target.name}. Connect to it from TurenOS Desktop, or set FORGE_SECRET_VAULT_KEY_ID and FORGE_SECRET_VAULT_KEY so this client can start it.`,
          )
        progress?.(`Starting the TurenOS server on ${target.name}…`)
        const started = await runSsh([...base, destination, "sh -s"], ensureScript(key), 90_000, signal)
        const state = shimState(started.stdout.split(/\r?\n/g).map((line) => line.trim()))
        if (!state) throw new Error(sshFailure(target, started.stderr || started.stdout))
        return state
      })())
    progress?.(`Opening a tunnel to ${target.name}…`)
    const tunnel = await openTunnel(base, destination, Number(new URL(remote.url).port), signal)
    return verified(
      target,
      { ...remote, url: tunnel.url },
      signal,
      `The tunnel to ${target.name} opened, but its server is not answering.`,
      tunnel.close,
    )
  }

  async function openTunnel(base: string[], destination: string, remotePort: number, signal: AbortSignal) {
    // A private socket forward behind a loopback proxy: no other local user can bind the tunnel first.
    const directory = await mkdtemp(join(tmpdir(), "turen-tui-"))
    const socketPath = join(directory, "s")
    const child = Bun.spawn(
      [
        ssh,
        ...base,
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        "-L",
        `${socketPath}:127.0.0.1:${remotePort}`,
        destination,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    )
    running.add(child)
    const sockets = new Set<Socket>()
    const proxy = createServer((socket) => {
      const upstream = connectSocket(socketPath)
      for (const item of [socket, upstream]) {
        sockets.add(item)
        item.on("close", () => sockets.delete(item))
      }
      socket.on("error", () => upstream.destroy())
      upstream.on("error", () => socket.destroy())
      socket.pipe(upstream).pipe(socket)
    })
    const close = () => {
      if (proxy.listening) proxy.close()
      sockets.forEach((socket) => socket.destroy())
      child.kill()
    }
    void child.exited.then(() => {
      running.delete(child)
      // Keep the loopback port bound until the endpoint is closed: a dashboard still retrying with the
      // remote password must never reach a listener another local user could bind in its place.
      sockets.forEach((socket) => socket.destroy())
      void rm(directory, { recursive: true, force: true })
    })
    const port = await new Promise<number>((resolve, reject) => {
      proxy.once("error", reject)
      proxy.listen(0, "127.0.0.1", () => {
        const address = proxy.address()
        if (address && typeof address === "object") resolve(address.port)
        else reject(new Error("Could not open a local port for the tunnel."))
      })
    }).catch((error) => {
      close()
      throw error
    })
    const deadline = Date.now() + 20_000
    const stderr = new Response(child.stderr).text()
    // The socket appears once ssh has authenticated and registered the forward.
    while (!existsSync(socketPath)) {
      if (child.exitCode !== null || signal.aborted || Date.now() > deadline) {
        close()
        const detail = summarize(await stderr)
        throw new Error(signal.aborted ? "Connection cancelled." : `The SSH tunnel did not open. ${detail}`.trim())
      }
      await Bun.sleep(100)
    }
    return { url: `http://127.0.0.1:${port}`, close }
  }

  async function runSsh(args: string[], input: string, timeout: number, signal: AbortSignal) {
    const child = Bun.spawn([ssh, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })
    child.stdin.write(input)
    await child.stdin.end()
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (signal.aborted) throw new Error("Connection cancelled.")
    return { stdout, stderr, code }
  }

  /** A live attach record, or Chromium's single-instance lock (`host-pid`), which every desktop version holds. */
  async function desktopRunning(appId: string) {
    const root = appData()
    if (!root) return false
    if (await desktopRecord(join(root, appId, "attach.json"))) return true
    const lock = await readlink(join(root, appId, "SingletonLock")).catch(() => "")
    const match = /^(.+)-(\d+)$/.exec(lock)
    return !!match && match[1] === hostname() && alive(Number(match[2]))
  }

  async function desktopRecord(file: string) {
    const text = await readPrivate(file, uid, "self").catch(() => undefined)
    const value = text === undefined ? undefined : parseJSON(text)
    const record = attachRecord(value)
    if (!record || !isRecord(value) || !alive(value.pid)) return undefined
    return record
  }

  async function shimRecord() {
    const directory = join(home, ".forge", "run")
    const [pid, port, password] = await Promise.all(
      ["server.pid", "server.port", "server.auth"].map((name) =>
        readPrivate(join(directory, name), uid, "self").catch(() => undefined),
      ),
    )
    if (!alive(Number(pid?.trim())) || !password?.trim()) return undefined
    return shimState([
      `FORGE_REMOTE ${JSON.stringify({ port: Number(port?.trim()), username: "forge", password: password.trim() })}`,
    ])
  }

  async function persistentRecord() {
    const text = await readPrivate(persistentPath, uid, "root")
    const record = text === undefined ? undefined : attachRecord(parseJSON(text))
    if (!record) throw new Error("The persistent server's attach record is missing or unreadable.")
    return record
  }

  function forgeBinary() {
    if (options.forge !== undefined) return options.forge ?? undefined
    return [
      env.TURENOS_FORGE,
      Bun.which("forge", { PATH: env.PATH ?? "" }) ?? undefined,
      join(home, ".forge", "bin", "forge"),
      platform === "darwin" ? "/Applications/TurenOS.app/Contents/Resources/forge-cli" : undefined,
    ].find((path): path is string => !!path && executable(path))
  }

  function appData() {
    if (platform === "darwin") return join(home, "Library", "Application Support")
    if (platform === "win32") return env.APPDATA
    return env.XDG_CONFIG_HOME || join(home, ".config")
  }

  function username() {
    return options.username ?? env.FORGE_SERVER_USERNAME ?? "forge"
  }

  function vaultKey() {
    const keyID = env.FORGE_SECRET_VAULT_KEY_ID
    const key = env.FORGE_SECRET_VAULT_KEY
    if (!keyID || !key || !/^[A-Za-z0-9._-]{1,128}$/.test(keyID)) return undefined
    if (Buffer.from(key, "base64").byteLength !== 32 || Buffer.from(key, "base64").toString("base64") !== key)
      return undefined
    return { keyID, key }
  }

  /** Reads the desktop's saved SSH servers from its storage; they carry no secrets. */
  async function importDesktop(endpoint: Endpoint) {
    if (endpoint.target.kind !== "desktop") return
    const address = new URL("/global/storage", endpoint.url)
    address.searchParams.set("scope", "desktop/store/product-state-v1")
    address.searchParams.set("key", "ssh-servers")
    const response = await fetch(address, {
      headers: endpoint.password
        ? { Authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}` }
        : {},
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
    if (!response?.ok) return
    const body = parseJSON((await response.text()).slice(0, 1024 * 1024))
    const state = isRecord(body) && isRecord(body.state) ? body.state : undefined
    const list = typeof state?.value === "string" ? parseJSON(state.value) : undefined
    if (!Array.isArray(list)) return
    imported = list.slice(0, 256).flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.host !== "string") return []
      const parsed = parseSshTarget(item.host)
      const user = typeof item.user === "string" ? item.user : (parsed?.user ?? undefined)
      const port = typeof item.port === "number" ? item.port : (parsed?.port ?? undefined)
      const target = sshTarget({
        id: `desktop:${item.id}`,
        name: typeof item.displayName === "string" && item.displayName.trim() ? item.displayName : item.host,
        host: parsed?.host ?? "",
        user,
        port,
        identityFile: typeof item.identityFile === "string" ? item.identityFile : undefined,
        saved: false,
        desktop: true,
      })
      return target ? [target] : []
    })
  }

  return {
    configPath,
    /** Saved-server errors and discovery notes worth showing beside the list. */
    problems: () => [...problems, ...notes],
    load,
    scan,
    preferred,
    resolve,
    importDesktop,
    remember: (target: Target, password: string) => passwords.set(target.id, password),
    forget: (target: Target) => passwords.delete(target.id),
    find: (name: string) =>
      saved.find((target) => target.name === name || target.id === name) ??
      imported.find((target) => target.name === name),
    async add(input: { address: string; name?: string; username?: string }) {
      const target = parseAddress(input)
      if (saved.some((item) => item.name === target.name)) throw new Error(`A server named ${target.name} exists.`)
      saved = [...saved, target]
      await persist().catch((error) => {
        saved = saved.filter((item) => item !== target)
        throw error
      })
      return target
    },
    async remove(target: Target) {
      const next = saved.filter((item) => item.id !== target.id)
      if (next.length === saved.length) throw new Error("Only saved servers can be removed.")
      const previous = saved
      saved = next
      passwords.delete(target.id)
      await persist().catch((error) => {
        saved = previous
        throw error
      })
    },
    stopHeadless() {
      headless?.child.kill()
      headless = undefined
    },
  }
}

export type Servers = ReturnType<typeof createServers>

const PROBE = [
  'f="/etc/turenos/attach.json"',
  'if [ -d "${f%/*}" ] && [ ! -x "${f%/*}" ]; then printf "FORGE_ATTACH unreadable\\n"',
  'elif [ ! -e "$f" ]; then printf "FORGE_ATTACH missing\\n"',
  'elif [ ! -r "$f" ]; then printf "FORGE_ATTACH unreadable\\n"',
  'else printf "FORGE_ATTACH readable %s\\n" "$(tr -d \'\\r\\n\' < "$f")"; fi',
  'shim="$HOME/.forge/bin/forge-remote"',
  'if [ ! -f "$shim" ]; then printf "FORGE_REMOTE_MISSING\\n"',
  'elif ! sh "$shim" status; then printf "FORGE_REMOTE_STOPPED\\n"; fi',
  "",
].join("\n")

/** Sent on stdin: an argument would put the vault key in argv on both machines. */
function ensureScript(key: { keyID: string; key: string }) {
  return [
    `FORGE_SECRET_VAULT_KEY_ID='${key.keyID}'`,
    `FORGE_SECRET_VAULT_KEY='${key.key}'`,
    "export FORGE_SECRET_VAULT_KEY_ID FORGE_SECRET_VAULT_KEY",
    'exec sh "$HOME/.forge/bin/forge-remote" ensure',
    "",
  ].join("\n")
}

function shimState(lines: string[]): Record | undefined {
  const line = lines.findLast((item) => item.startsWith("FORGE_REMOTE {"))
  const value = line ? parseJSON(line.slice("FORGE_REMOTE ".length)) : undefined
  if (!isRecord(value) || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535)
    return undefined
  if (typeof value.password !== "string" || !value.password || value.password.length > 1024) return undefined
  return {
    url: `http://127.0.0.1:${value.port}`,
    username: typeof value.username === "string" && validUsername(value.username) ? value.username : "forge",
    password: value.password,
  }
}

function attachRecord(value: unknown): Record | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.url !== "string") return undefined
  const url = URL.parse(value.url)
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username
  )
    return undefined
  if (typeof value.password !== "string" || !value.password || value.password.length > 1024) return undefined
  if (typeof value.username !== "string" || !validUsername(value.username)) return undefined
  return { url: url.origin, username: value.username, password: value.password }
}

async function health(record: Record, signal: AbortSignal) {
  const response = await fetch(new URL("/global/health", record.url), {
    headers: record.password
      ? { Authorization: `Basic ${Buffer.from(`${record.username}:${record.password}`).toString("base64")}` }
      : {},
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  }).catch(() => undefined)
  if (!response) return { ok: false, status: 0 }
  const body = response.ok ? parseJSON((await response.text()).slice(0, 65536)) : undefined
  await response.body?.cancel().catch(() => {})
  return {
    ok: response.ok,
    status: response.status,
    version: isRecord(body) && typeof body.version === "string" ? body.version.slice(0, 64) : undefined,
  }
}

/** Opens a file only when its owner could not have been another user and nobody else can rewrite it. */
async function readPrivate(path: string, uid: number | undefined, owner: "self" | "root") {
  const handle = await open(path, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024) return undefined
    if (uid !== undefined && (info.uid !== (owner === "root" ? 0 : uid) || info.mode & 0o022)) return undefined
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

function alive(pid: unknown) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // EPERM means another user's process reuses the pid; that is not our server.
    return false
  }
}

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function withoutElectron(env: NodeJS.ProcessEnv) {
  // A shell inside another Electron app inherits this, which makes Electron-based binaries run as plain Node.
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  )
}

function headlessFailure(output: string) {
  if (/requires an OS-protected key/.test(output))
    return "forge serve needs the key that protects your stored credentials. Set FORGE_SECRET_VAULT_KEY_ID and FORGE_SECRET_VAULT_KEY, then try again."
  if (/belong to another OS-protected key/.test(output))
    return "FORGE_SECRET_VAULT_KEY does not match the key that sealed your stored credentials."
  if (/already owned by another server/.test(output))
    return "Another TurenOS server is using your local data. Connect to it, or quit it first."
  return `forge serve did not start. ${summarize(output)}`.trim()
}

function sshFailure(target: Extract<Target, { kind: "ssh" }>, stderr: string) {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return `${target.name}'s host key is unknown or changed. Run ssh ${sshDestination(target)} once in a terminal to verify it.`
  if (/Permission denied/i.test(stderr))
    return `SSH login to ${target.name} failed. This client needs a key or agent; it cannot type a password.`
  return `Could not reach ${target.name} over SSH. ${summarize(stderr)}`.trim()
}

function summarize(text: string) {
  return text
    .split(/\r?\n/g)
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim())
    .filter((line) => line && !/^\[\d/.test(line))
    .slice(-2)
    .join(" ")
    .slice(0, 300)
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function validUsername(value: string) {
  return (
    !!value &&
    value.length <= 512 &&
    !value.includes(":") &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value)
  )
}

function shortPath(path: string, home: string) {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** How the header names a connected server: local servers read as this computer. */
export function serverLabel(target: Target) {
  if (target.kind === "desktop")
    return target.name === "TurenOS" ? "This computer" : `This computer (${target.name.replace("TurenOS ", "")})`
  if (target.kind === "shim") return "This computer (quick-connect)"
  if (target.kind === "persistent") return "This computer (persistent server)"
  if (target.kind === "env") return "This computer (port 4096)"
  if (target.kind === "headless") return "This computer (private server)"
  return target.name
}

export function sshDestination(target: { host: string; user?: string }) {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/** `[user@]host[:port]`, rejecting anything that could smuggle ssh options through the destination. */
export function parseSshTarget(input: string) {
  const value = input.trim()
  if (!value || value.startsWith("-") || /[\s\u0000-\u001f]/.test(value)) return undefined
  const at = /^([^@]+)@(.+)$/.exec(value)
  const rest = at ? at[2]! : value
  if (!rest || rest.startsWith("-") || rest.includes("@")) return undefined
  const withPort = /^([^:[\]]+):(\d{1,5})$/.exec(rest)
  if (!withPort && rest.includes(":")) return undefined
  const port = withPort ? Number(withPort[2]) : undefined
  if (port !== undefined && (port < 1 || port > 65535)) return undefined
  return { user: at?.[1], host: withPort ? withPort[1]! : rest, port }
}

function sshTarget(input: Omit<Extract<Target, { kind: "ssh" }>, "kind">) {
  const clean = (value: string | undefined, pattern: RegExp) =>
    value === undefined || (pattern.test(value) && !value.startsWith("-"))
  if (
    !input.host ||
    input.host.length > 255 ||
    !clean(input.host, /^[^\s@\u0000-\u001f]+$/) ||
    !clean(input.user, /^[^\s@:/\u0000-\u001f]{1,64}$/) ||
    !clean(input.identityFile, /^[^\u0000-\u001f]{1,4096}$/) ||
    (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) ||
    !input.name.trim() ||
    input.name.length > 128
  )
    return undefined
  return { kind: "ssh" as const, ...input }
}

function urlTarget(input: Omit<Extract<Target, { kind: "url" }>, "kind">) {
  const url = URL.parse(input.url)
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^https?:\/\/[^/\\\s@?#]+\/?$/i.test(input.url)
  )
    return undefined
  if (input.username !== undefined && !validUsername(input.username)) return undefined
  if (input.passwordEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.passwordEnv)) return undefined
  if (!input.name.trim() || input.name.length > 128) return undefined
  return { kind: "url" as const, ...input, url: url.origin }
}

function savedTarget(value: unknown) {
  if (!isRecord(value) || typeof value.name !== "string") return undefined
  const id = typeof value.id === "string" && /^srv_[A-Za-z0-9]{1,64}$/.test(value.id) ? value.id : newID()
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined)
  if (typeof value.url === "string")
    return urlTarget({
      id,
      name: value.name,
      url: value.url,
      username: text("username"),
      passwordEnv: text("passwordEnv"),
      saved: true,
    })
  const parsed = typeof value.ssh === "string" ? parseSshTarget(value.ssh) : undefined
  if (!parsed) return undefined
  return sshTarget({ id, name: value.name, ...parsed, identityFile: text("identityFile"), saved: true, desktop: false })
}

function parseAddress(input: { address: string; name?: string; username?: string }) {
  const address = input.address.trim()
  const name = input.name?.trim()
  if (/^https?:\/\//i.test(address)) {
    const target = urlTarget({
      id: newID(),
      name: name || new URL(address).host,
      url: address,
      username: input.username?.trim() || undefined,
      saved: true,
    })
    if (!target) throw new Error("Enter the server's origin, such as https://turen.example, without a path.")
    return target
  }
  const parsed = parseSshTarget(address.replace(/^ssh:\/\//i, ""))
  const target = parsed
    ? sshTarget({ id: newID(), name: name || parsed.host, ...parsed, saved: true, desktop: false })
    : undefined
  if (!target) throw new Error("Enter https://host for a server URL, or user@host[:port] for SSH.")
  return target
}

function newID() {
  return `srv_${randomUUID().replaceAll("-", "")}`
}
