import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { running } from "./processes"
import { APPS, desktopRunning } from "./records"
import { summarize, shortPath } from "./text"
import { verified } from "./verify"
import type { Context, Endpoint, State, Target } from "./types"

type Headless = Extract<Target, { kind: "headless" }>

/** Starts (or reuses) a forge server private to this process, on a random password and port. */
export async function startHeadless(
  ctx: Context,
  state: State,
  target: Headless,
  signal: AbortSignal,
  progress?: (text: string) => void,
): Promise<Endpoint> {
  if (state.headless && state.headless.child.exitCode === null)
    return verified(
      target,
      { url: state.headless.url, username: "forge", password: state.headless.password },
      signal,
      "The private server stopped responding.",
    )
  await refuseOwnedData(ctx)
  progress?.(`Starting forge serve from ${shortPath(target.binary, ctx.home)}…`)
  const password = randomBytes(24).toString("base64url")
  const child = Bun.spawn([target.binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: { ...withoutElectron(ctx.env), FORGE_SERVER_USERNAME: "forge", FORGE_SERVER_PASSWORD: password },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  running.add(child)
  void child.exited.then(() => running.delete(child))
  const started = await waitForPort(child, signal)
  if (!started.port) {
    child.kill()
    throw new Error(headlessFailure(started.output()))
  }
  const url = `http://127.0.0.1:${started.port}`
  state.headless = { child, url, password }
  progress?.("Waiting for the private server…")
  const stop = () => {
    child.kill()
    if (state.headless?.child === child) state.headless = undefined
  }
  // The server outlives a switch to another target so switching back is instant; quitting stops it.
  return verified(
    target,
    { url, username: "forge", password },
    signal,
    "The private server started but is not answering.",
  ).catch((error) => {
    stop()
    throw error
  })
}

/**
 * Session drains are process-local: a second server over the desktop's database could run a session
 * twice. Stable and beta share forge.db with the CLI; dev keeps its own database, as does a CLI
 * pointed at other data.
 */
async function refuseOwnedData(ctx: Context) {
  const shared =
    !ctx.env.FORGE_DB && (!ctx.env.XDG_DATA_HOME || ctx.env.XDG_DATA_HOME === join(ctx.home, ".local", "share"))
  for (const [appId, name] of shared ? APPS.slice(0, 2) : [])
    if (await desktopRunning(ctx, appId))
      throw new Error(`${name} is running and owns your local data. Connect to it instead, or quit it first.`)
}

/** Resolves with the port the server announced, or undefined when it exits, times out or is aborted. */
async function waitForPort(
  child: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> },
  signal: AbortSignal,
) {
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
  return { port, output: () => output }
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
