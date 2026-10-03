import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { connect as connectSocket, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { running } from "./processes"
import { attachRecord, shimState } from "./records"
import { sshDestination } from "./targets"
import { parseJSON, summarize } from "./text"
import { verified } from "./verify"
import type { Context, Endpoint, SshTarget } from "./types"

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

/** Finds (or starts) the TurenOS server on an SSH host and reaches it through a private tunnel. */
export async function connectSsh(
  ctx: Context,
  target: SshTarget,
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
  const remote = await findRemote(ctx, target, [...base, destination, "sh -s"], signal, progress)
  progress?.(`Opening a tunnel to ${target.name}…`)
  const tunnel = await openTunnel(ctx, base, destination, Number(new URL(remote.url).port), signal)
  return verified(
    target,
    { ...remote, url: tunnel.url },
    signal,
    `The tunnel to ${target.name} opened, but its server is not answering.`,
    tunnel.close,
  )
}

/** The remote server's record: the persistent server's, the quick-connect shim's, or a freshly started shim. */
async function findRemote(
  ctx: Context,
  target: SshTarget,
  command: string[],
  signal: AbortSignal,
  progress?: (text: string) => void,
) {
  progress?.(`Looking for a TurenOS server on ${target.name}…`)
  const probe = await runSsh(ctx, command, PROBE, 30_000, signal)
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
  const found = persistent ?? shimState(lines)
  if (found) return found
  if (lines.includes("FORGE_REMOTE_MISSING"))
    throw new Error(`TurenOS is not set up on ${target.name} yet. Add it once in TurenOS Desktop to install it.`)
  return startRemote(ctx, target, command, signal, progress)
}

async function startRemote(
  ctx: Context,
  target: SshTarget,
  command: string[],
  signal: AbortSignal,
  progress?: (text: string) => void,
) {
  const key = vaultKey(ctx)
  if (!key)
    throw new Error(
      `No TurenOS server is running on ${target.name}. Connect to it from TurenOS Desktop, or set FORGE_SECRET_VAULT_KEY_ID and FORGE_SECRET_VAULT_KEY so this client can start it.`,
    )
  progress?.(`Starting the TurenOS server on ${target.name}…`)
  const started = await runSsh(ctx, command, ensureScript(key), 90_000, signal)
  const state = shimState(started.stdout.split(/\r?\n/g).map((line) => line.trim()))
  if (!state) throw new Error(sshFailure(target, started.stderr || started.stdout))
  return state
}

async function openTunnel(ctx: Context, base: string[], destination: string, remotePort: number, signal: AbortSignal) {
  // A private socket forward behind a loopback proxy: no other local user can bind the tunnel first.
  const directory = await mkdtemp(join(tmpdir(), "turen-tui-"))
  const socketPath = join(directory, "s")
  const child = Bun.spawn(
    [
      ctx.ssh,
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
  const proxy = loopbackProxy(socketPath)
  const close = () => {
    if (proxy.server.listening) proxy.server.close()
    proxy.sockets.forEach((socket) => socket.destroy())
    child.kill()
  }
  void child.exited.then(() => {
    running.delete(child)
    // Keep the loopback port bound until the endpoint is closed: a dashboard still retrying with the
    // remote password must never reach a listener another local user could bind in its place.
    proxy.sockets.forEach((socket) => socket.destroy())
    void rm(directory, { recursive: true, force: true })
  })
  const port = await listen(proxy.server).catch((error) => {
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

/** A loopback server that pipes every connection to the tunnel's unix socket. */
function loopbackProxy(socketPath: string) {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    const upstream = connectSocket(socketPath)
    for (const item of [socket, upstream]) {
      sockets.add(item)
      item.on("close", () => sockets.delete(item))
    }
    socket.on("error", () => upstream.destroy())
    upstream.on("error", () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  return { server, sockets }
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(new Error("Could not open a local port for the tunnel."))
    })
  })
}

async function runSsh(ctx: Context, args: string[], input: string, timeout: number, signal: AbortSignal) {
  const child = Bun.spawn([ctx.ssh, ...args], {
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

function vaultKey(ctx: Context) {
  const keyID = ctx.env.FORGE_SECRET_VAULT_KEY_ID
  const key = ctx.env.FORGE_SECRET_VAULT_KEY
  if (!keyID || !key || !/^[A-Za-z0-9._-]{1,128}$/.test(keyID)) return undefined
  if (Buffer.from(key, "base64").byteLength !== 32 || Buffer.from(key, "base64").toString("base64") !== key)
    return undefined
  return { keyID, key }
}

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

function sshFailure(target: SshTarget, stderr: string) {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return `${target.name}'s host key is unknown or changed. Run ssh ${sshDestination(target)} once in a terminal to verify it.`
  if (/Permission denied/i.test(stderr))
    return `SSH login to ${target.name} failed. This client needs a key or agent; it cannot type a password.`
  return `Could not reach ${target.name} over SSH. ${summarize(stderr)}`.trim()
}
