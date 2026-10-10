import { startHeadless } from "./headless"
import { envRefusal } from "./listener"
import { desktopRecord, persistentRecord, shimRecord, trustedRecord, username } from "./records"
import { connectSsh } from "./ssh"
import { verified } from "./verify"
import type { Context, Endpoint, State, Target } from "./types"

type Input = { signal?: AbortSignal; progress?: (text: string) => void }

/** Turns a target into a verified endpoint, starting or tunnelling to the server when it needs to. */
export async function resolve(ctx: Context, state: State, target: Target, input: Input = {}): Promise<Endpoint> {
  const signal = input.signal ?? new AbortController().signal
  if (target.kind === "headless") return startHeadless(ctx, state, target, signal, input.progress)
  if (target.kind === "ssh") return connectSsh(ctx, target, signal, input.progress)
  if (target.kind === "url") return resolveUrl(ctx, state, target, signal)
  if (target.kind === "desktop") {
    const record = await desktopRecord(ctx, target.record)
    if (!record) throw new Error(`${target.name} is not running. Open the app, or choose another server.`)
    return verified(target, record, signal, `${target.name} is not answering. Restart the app.`)
  }
  if (target.kind === "shim") {
    const record = await shimRecord(ctx)
    if (!record) throw new Error("The quick-connect server on this host has stopped.")
    return verified(target, record, signal, "The quick-connect server on this host is not answering.")
  }
  if (target.kind === "persistent")
    return verified(
      target,
      await persistentRecord(ctx),
      signal,
      "The persistent server is not answering. Check it with systemctl status turenos.",
    )
  const refusal = envRefusal(ctx)
  if (refusal) throw new Error(refusal)
  return verified(
    target,
    { url: target.url, username: username(ctx), password: ctx.env.FORGE_SERVER_PASSWORD ?? "" },
    signal,
    "Nothing answered on 127.0.0.1:4096. Start forge serve --port 4096 or choose another server.",
  )
}

async function resolveUrl(ctx: Context, state: State, target: Extract<Target, { kind: "url" }>, signal: AbortSignal) {
  const password = state.passwords.get(target.id) ?? (target.passwordEnv ? ctx.env[target.passwordEnv] : undefined)
  const url = new URL(target.url)
  // The URL names a server whose owner published a record this client already trusts, so it gets that record's
  // credentials. An exported FORGE_SERVER_PASSWORD, even an empty one, is the caller's own choice and wins.
  const record =
    password === undefined && ctx.env.FORGE_SERVER_PASSWORD === undefined
      ? await trustedRecord(ctx, url.origin)
      : undefined
  if (record) return verified(target, record, signal, `${target.name} is not reachable at ${url.origin}.`)
  if (password && url.protocol !== "https:" && !["127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Server credentials require HTTPS, or HTTP on 127.0.0.1 or [::1] for an SSH tunnel.")
  return verified(
    target,
    { url: url.origin, username: target.username ?? username(ctx), password: password ?? "" },
    signal,
    `${target.name} is not reachable at ${url.origin}.`,
  )
}
