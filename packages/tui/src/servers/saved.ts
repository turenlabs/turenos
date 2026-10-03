import { randomUUID } from "node:crypto"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { isRecord } from "../response-validation"
import { readPrivate } from "./records"
import { parseAddress, parseSshTarget, savedTarget, sshDestination, sshTarget } from "./targets"
import { parseJSON } from "./text"
import type { Context, Endpoint, State, Target } from "./types"

export async function load(ctx: Context, state: State) {
  state.problems = []
  state.unwritable = undefined
  state.preserved = []
  state.saved = []
  const text = await readPrivate(ctx.configPath, ctx.uid, "self").catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : undefined,
  )
  if (text === null) return
  const value = text === undefined ? undefined : parseJSON(text)
  const list = isRecord(value) && Array.isArray(value.servers) ? value.servers : undefined
  // Never overwrite a file this client could not fully read: a later add or remove would lose it.
  if (!list) {
    state.unwritable =
      text === undefined
        ? `${ctx.configPath} must be a private file you own (chmod 600) before saved servers can be used.`
        : `${ctx.configPath} is not a valid server list. Fix it before adding or removing servers.`
    state.problems = [state.unwritable]
    return
  }
  state.saved = list.flatMap((item, index) => {
    const target = savedTarget(item)
    if (target) return [target]
    state.preserved.push(item)
    state.problems.push(`Skipped server ${index + 1} in ${ctx.configPath}; it is kept unchanged.`)
    return []
  })
}

export async function add(ctx: Context, state: State, input: { address: string; name?: string; username?: string }) {
  const target = parseAddress(input)
  if (state.saved.some((item) => item.name === target.name)) throw new Error(`A server named ${target.name} exists.`)
  state.saved = [...state.saved, target]
  await persist(ctx, state).catch((error) => {
    state.saved = state.saved.filter((item) => item !== target)
    throw error
  })
  return target
}

export async function remove(ctx: Context, state: State, target: Target) {
  const next = state.saved.filter((item) => item.id !== target.id)
  if (next.length === state.saved.length) throw new Error("Only saved servers can be removed.")
  const previous = state.saved
  state.saved = next
  state.passwords.delete(target.id)
  await persist(ctx, state).catch((error) => {
    state.saved = previous
    throw error
  })
}

/** Reads the desktop's saved SSH servers from its storage; they carry no secrets. */
export async function importDesktop(state: State, endpoint: Endpoint) {
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
  const stored = isRecord(body) && isRecord(body.state) ? body.state : undefined
  const list = typeof stored?.value === "string" ? parseJSON(stored.value) : undefined
  if (!Array.isArray(list)) return
  state.imported = list.slice(0, 256).flatMap((item) => {
    const target = importedTarget(item)
    return target ? [target] : []
  })
}

function importedTarget(item: unknown) {
  if (!isRecord(item) || typeof item.id !== "string" || typeof item.host !== "string") return undefined
  const parsed = parseSshTarget(item.host)
  const user = typeof item.user === "string" ? item.user : (parsed?.user ?? undefined)
  const port = typeof item.port === "number" ? item.port : (parsed?.port ?? undefined)
  return sshTarget({
    id: `desktop:${item.id}`,
    name: typeof item.displayName === "string" && item.displayName.trim() ? item.displayName : item.host,
    host: parsed?.host ?? "",
    user,
    port,
    identityFile: typeof item.identityFile === "string" ? item.identityFile : undefined,
    saved: false,
    desktop: true,
  })
}

async function persist(ctx: Context, state: State) {
  if (state.unwritable) throw new Error(state.unwritable)
  await mkdir(dirname(ctx.configPath), { recursive: true, mode: 0o700 })
  const temporary = `${ctx.configPath}.${randomUUID()}`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify({ version: 1, servers: serverList(state) }, null, 2) + "\n")
  } finally {
    await handle.close()
  }
  await rename(temporary, ctx.configPath).catch(async (error) => {
    await rm(temporary, { force: true })
    throw error
  })
}

function serverList(state: State) {
  return [
    ...state.saved.map((target) =>
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
    ...state.preserved,
  ]
}
