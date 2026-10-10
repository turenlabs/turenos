import { ClientError } from "../index"
import { checkDirectory, isRecord } from "./validate"
import { pathKey } from "../path-key"
import { directories, invalid, isDirectory, key, limit, maxFolders, scope, state, type State } from "./validate"

type Transport = (input: URL, init?: RequestInit) => Promise<Response>

/** The synced folder list and the ordering bookkeeping that keeps stale responses out of it. */
export type Store = {
  transport: Transport
  address: URL
  query: URL
  headers: Headers
  cached: string[] | undefined
  revision: number
  sequence: number
  accepted: number
  queue: Promise<unknown>
}

export function newStore(input: { url: URL; headers: Headers; transport: Transport }): Store {
  const address = new URL("/global/storage", input.url)
  const query = new URL(address)
  query.searchParams.set("scope", scope)
  query.searchParams.set("key", key)
  const headers = new Headers(input.headers)
  headers.set("Content-Type", "application/json")
  return {
    transport: input.transport,
    address,
    query,
    headers,
    cached: undefined,
    revision: -1,
    sequence: 0,
    accepted: 0,
    queue: Promise.resolve(),
  }
}

export function current(s: Store) {
  return s.cached?.slice()
}

function observe(s: Store, next: State | undefined, order: number) {
  // Revision wins over completion order. Missing responses have no revision,
  // so only accept them if no newer request/write has already been observed.
  if (next && next.revision < s.revision) return
  if (order < s.accepted && (!next || next.revision <= s.revision)) return
  s.accepted = Math.max(s.accepted, order)
  if (next) s.revision = next.revision
  s.cached = next?.directories.slice()
}

async function request(s: Store, url: URL, init: RequestInit) {
  const response = await s.transport(url, init).catch((cause: unknown) => {
    throw new ClientError("Transport", { cause })
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403)
      throw new Error("Authentication required. Check the server credentials.")
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }
  return readResponse(response)
}

/** The JSON envelope can escape every byte of its bounded stored value. */
async function readResponse(response: Response): Promise<unknown> {
  const maximum = limit * 2 + 8192
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel()
    invalid()
  }
  const reader = response.body?.getReader()
  if (!reader) invalid()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximum) {
        await reader.cancel()
        invalid()
      }
      parts.push(decoder.decode(chunk.value, { stream: true }))
    }
    parts.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(parts.join("")) as unknown
  } catch {
    invalid()
  }
}

export async function fetchState(s: Store) {
  const order = ++s.sequence
  const result = await request(s, s.query, { headers: s.headers })
  if (!isRecord(result) || !("state" in result)) invalid()
  const next = result.state === null ? undefined : state(result.state)
  observe(s, next, order)
  return next
}

async function mutate(s: Store, directory: string, open: boolean) {
  checkDirectory(directory)
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await fetchState(s)
    const before = previous?.directories ?? []
    const after = open
      ? before.some((item) => pathKey(item) === pathKey(directory))
        ? before
        : [...before, directory]
      : before.filter((item) => pathKey(item) !== pathKey(directory))
    if (previous && before.length === after.length) return current(s)
    directories({ version: 1, directories: after })
    const value = JSON.stringify({ version: 1, directories: after })
    if (new TextEncoder().encode(value).byteLength > limit) invalid()
    const order = ++s.sequence
    try {
      const next = state(
        await request(s, s.address, {
          method: "PUT",
          headers: s.headers,
          body: JSON.stringify({ scope, key, value, expectedRevision: previous?.revision ?? null }),
        }),
      )
      if (previous && next.revision <= previous.revision) invalid()
      if (JSON.stringify(next.directories) !== JSON.stringify(after)) invalid()
      observe(s, next, order)
      return current(s)
    } catch (error) {
      if (
        attempt === 3 ||
        !(error instanceof ClientError) ||
        error.reason !== "UnexpectedStatus" ||
        !isRecord(error.cause) ||
        error.cause.status !== 409
      )
        throw error
    }
  }
}

/** Writes run one at a time, each re-reading the revision it replaces. */
export function enqueue(s: Store, directory: string, open: boolean) {
  const operation = s.queue.then(() => mutate(s, directory, open))
  s.queue = operation.catch(() => {})
  return operation
}

/** A first GUI visit may seed its legacy list, but never overwrites a shared list another client created. */
export function migrate(s: Store, legacy: string[]) {
  const operation = s.queue.then(async () => {
    const existing = await fetchState(s)
    if (existing) return current(s)
    // Legacy lists are unvalidated: skip unusable paths and keep the first (most recently used) entries.
    const unique = [
      ...new Map(legacy.filter(isDirectory).map((directory) => [pathKey(directory), directory])).values(),
    ].slice(0, maxFolders)
    directories({ version: 1, directories: unique })
    const value = JSON.stringify({ version: 1, directories: unique })
    if (new TextEncoder().encode(value).byteLength > limit) invalid()
    const order = ++s.sequence
    try {
      const next = state(
        await request(s, s.address, {
          method: "PUT",
          headers: s.headers,
          body: JSON.stringify({ scope, key, value, expectedRevision: null }),
        }),
      )
      if (JSON.stringify(next.directories) !== JSON.stringify(unique)) invalid()
      observe(s, next, order)
      return current(s)
    } catch (error) {
      if (
        !(error instanceof ClientError) ||
        error.reason !== "UnexpectedStatus" ||
        !isRecord(error.cause) ||
        error.cause.status !== 409
      )
        throw error
      await fetchState(s)
      return current(s)
    }
  })
  s.queue = operation.catch(() => {})
  return operation
}
