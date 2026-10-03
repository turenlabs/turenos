import { ClientError } from "@turenlabs/client"
import { checkDirectory, isRecord } from "./response-validation"

const scope = "desktop/store/working-folders"
const key = "open"
const limit = 1024 * 1024

type State = { revision: number; directories: string[] }
type Transport = (input: URL, init?: RequestInit) => Promise<Response>

export function folderContains(folder: string, directory: string) {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(folder)
  const root = (windows ? folder.replace(/\\/g, "/").toLowerCase() : folder).replace(/\/+$/, "")
  const path = windows ? directory.replace(/\\/g, "/").toLowerCase() : directory
  return path === root || path.startsWith(`${root}/`)
}

function invalid(): never {
  throw new Error("Invalid working folders returned by the server.")
}

function directories(value: unknown): string[] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.directories) ||
    value.directories.length > 256
  )
    invalid()
  for (const directory of value.directories) checkDirectory(directory)
  if (new Set(value.directories).size !== value.directories.length) invalid()
  return [...value.directories] as string[]
}

function state(value: unknown): State {
  if (!isRecord(value) || value.scope !== scope || value.key !== key || typeof value.value !== "string") invalid()
  for (const field of [value.revision, value.timeCreated, value.timeUpdated]) {
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) invalid()
  }
  if (Buffer.byteLength(value.value, "utf8") > limit) invalid()
  return { revision: value.revision as number, directories: directories(JSON.parse(value.value)) }
}

/** Uses the connection's bounded, abortable transport; never writes during reads. */
export function createWorkingFolders(input: { url: URL; headers: Headers; transport: Transport }) {
  const address = new URL("/global/storage", input.url)
  const query = new URL(address)
  query.searchParams.set("scope", scope)
  query.searchParams.set("key", key)
  const headers = new Headers(input.headers)
  headers.set("Content-Type", "application/json")
  let cached: string[] | undefined
  let revision = -1
  let sequence = 0
  let accepted = 0
  let queue: Promise<unknown> = Promise.resolve()

  function current() {
    return cached?.slice()
  }

  function observe(next: State | undefined, order: number) {
    // Revision wins over completion order. Missing responses have no revision,
    // so only accept them if no newer request/write has already been observed.
    if (next && next.revision < revision) return
    if (order < accepted && (!next || next.revision <= revision)) return
    accepted = Math.max(accepted, order)
    if (next) revision = next.revision
    cached = next?.directories.slice()
  }

  async function request(url: URL, init: RequestInit) {
    const response = await input.transport(url, init).catch((cause: unknown) => {
      throw new ClientError("Transport", { cause })
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (response.status === 401 || response.status === 403)
        throw new Error("Authentication required. Check the server credentials.")
      throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
    }
    return response.json() as Promise<unknown>
  }

  async function fetchState() {
    const order = ++sequence
    const result = await request(query, { headers })
    if (!isRecord(result) || !("state" in result)) invalid()
    const next = result.state === null ? undefined : state(result.state)
    observe(next, order)
    return next
  }

  async function mutate(directory: string, open: boolean) {
    checkDirectory(directory)
    for (let attempt = 0; attempt < 4; attempt++) {
      const previous = await fetchState()
      const before = previous?.directories ?? []
      const after = open
        ? before.includes(directory)
          ? before
          : [...before, directory]
        : before.filter((item) => item !== directory)
      if (previous && before.length === after.length) return current()
      directories({ version: 1, directories: after })
      const value = JSON.stringify({ version: 1, directories: after })
      if (Buffer.byteLength(value, "utf8") > limit) invalid()
      const order = ++sequence
      try {
        const next = state(
          await request(address, {
            method: "PUT",
            headers,
            body: JSON.stringify({ scope, key, value, expectedRevision: previous?.revision ?? null }),
          }),
        )
        if (previous && next.revision <= previous.revision) invalid()
        if (JSON.stringify(next.directories) !== JSON.stringify(after)) invalid()
        observe(next, order)
        return current()
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

  function enqueue(directory: string, open: boolean) {
    const operation = queue.then(() => mutate(directory, open))
    queue = operation.catch(() => {})
    return operation
  }

  return {
    current,
    async read(): Promise<string[] | undefined> {
      await fetchState()
      return current()
    },
    open: (directory: string) => enqueue(directory, true),
    close: (directory: string) => enqueue(directory, false),
  }
}
