export * as ToolResultStore from "./tool-result-store"

import path from "path"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { Global } from "./global"
import { makeGlobalNode } from "./effect/app-node"
import { BoundedJson } from "./util/bounded-json"
import type { SessionSchema } from "./session/schema"

/** The entire encoded capture, including its provenance, must fit in this envelope. */
export const MAX_BYTES = 8 * 1024 * 1024
export const RETENTION = Duration.days(7)
export const MANAGED_DIRECTORY = "tool-result"
export const MAX_SCAN = 256
export const MAX_LIST = 50
const MAX_HEADER_BYTES = 4096
const ID_PATTERN = /^res_[0-9a-f]{13}_[0-9a-f]{32}$/
const TEMP_PATTERN = /^res_[0-9a-f]{13}_[0-9a-f]{32}\.[0-9a-f]{16}\.tmp$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const Integer = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Timestamp = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
const Name = Schema.String.check(Schema.isMaxLength(512))

export const Reference = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(ID_PATTERN)),
  tool: Name,
  toolCallID: Name,
  assistantMessageID: Schema.optional(Name),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  textBytes: Integer,
  structuredBytes: Integer,
  sha256: Schema.String.check(Schema.isPattern(HASH_PATTERN)),
  hasStructured: Schema.Boolean,
  captureTruncated: Schema.Boolean,
})
export type Reference = typeof Reference.Type

export const Snapshot = Schema.Struct({
  reference: Reference,
  text: Schema.String,
  structured: Schema.optional(Schema.Json),
})
export type Snapshot = typeof Snapshot.Type

const Header = Schema.Struct({ version: Schema.Literal(1), owner: Schema.String, reference: Reference })
const Body = Schema.Struct({ text: Schema.String, structured: Schema.optional(Schema.Json) })
const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header))
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Body))
const decodeReference = Schema.decodeUnknownOption(Reference)

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolResultStore.StorageError", {
  reason: Schema.Literals(["unavailable", "too_large", "invalid_input", "write_failed"]),
}) {
  override get message() {
    if (this.reason === "too_large") return "Tool result exceeds the retained capture limit."
    if (this.reason === "invalid_input") return "Tool result cannot be retained as JSON and text."
    if (this.reason === "write_failed") return "Tool result could not be retained."
    return "Retained tool result is unavailable."
  }
}
export type Error = StorageError

export interface PutInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly tool: string
  readonly assistantMessageID?: string
  readonly text: string
  readonly structured?: Schema.Schema.Type<typeof Schema.Json>
  readonly captureTruncated?: boolean
}

export interface Interface {
  readonly put: (input: PutInput) => Effect.Effect<Reference, Error>
  readonly get: (input: { sessionID: SessionSchema.ID; id: string }) => Effect.Effect<Snapshot, Error>
  /** Discovery scans at most MAX_SCAN directory entries; incomplete explicitly discloses that cap. */
  readonly list: (input: {
    sessionID: SessionSchema.ID
    cursor?: string
    limit?: number
  }) => Effect.Effect<{ results: Reference[]; nextCursor?: string; incomplete: boolean }, Error>
  /** Best-effort bounded disk cleanup. Reads enforce expiry even before cleanup reaches a file. */
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/ToolResultStore") {}

/** Model-facing metadata is separate from the original structured capture. */
export function referenceOf(structured: unknown): Reference | undefined {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return
  if (!("retainedResult" in structured)) return
  return Option.getOrUndefined(decodeReference(structured.retainedResult))
}

export function withReference(structured: unknown, reference: Reference): Record<string, unknown> {
  return structured && typeof structured === "object" && !Array.isArray(structured)
    ? { ...structured, retainedResult: reference }
    : { data: structured, retainedResult: reference }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const root = path.join(global.data, MANAGED_DIRECTORY)
    const directories = (owner: string) => [global.data, root, path.join(root, owner)]

    const put = Effect.fn("ToolResultStore.put")(function* (input: PutInput) {
      const now = yield* Clock.currentTimeMillis
      const encoded = yield* Effect.try({
        try: () => {
          if (
            typeof input.text !== "string" ||
            !Schema.is(Name)(input.tool) ||
            !Schema.is(Name)(input.toolCallID) ||
            (input.assistantMessageID !== undefined && !Schema.is(Name)(input.assistantMessageID))
          )
            throw new StorageError({ reason: "invalid_input" })
          if (input.text.length > MAX_BYTES) throw new StorageError({ reason: "too_large" })
          const owner = sessionHash(input.sessionID)
          // Bound expanded data before recursive schema validation or serialization of source values.
          const body = BoundedJson.encode({ text: input.text, structured: input.structured }, MAX_BYTES)
          if (body === undefined) throw new StorageError({ reason: "invalid_input" })
          const decoded = decodeBody(body)
          if (Option.isNone(decoded)) throw new StorageError({ reason: "invalid_input" })
          const metadata = {
            id: `res_${now.toString(16).padStart(13, "0")}_${randomBytes(16).toString("hex")}`,
            tool: input.tool,
            toolCallID: input.toolCallID,
            ...(input.assistantMessageID === undefined ? {} : { assistantMessageID: input.assistantMessageID }),
            createdAt: now,
            expiresAt: now + Duration.toMillis(RETENTION),
            textBytes: Buffer.byteLength(decoded.value.text),
            structuredBytes:
              decoded.value.structured === undefined ? 0 : Buffer.byteLength(JSON.stringify(decoded.value.structured)),
            hasStructured: decoded.value.structured !== undefined,
            captureTruncated: input.captureTruncated ?? false,
          }
          const reference = { ...metadata, sha256: digest(owner, metadata, body) }
          const header = JSON.stringify({ version: 1, owner, reference })
          const content = `${header}\n${body}`
          if (Buffer.byteLength(header) >= MAX_HEADER_BYTES || Buffer.byteLength(content) > MAX_BYTES)
            throw new StorageError({ reason: "too_large" })
          return { owner, reference, content }
        },
        catch: (error) => (error instanceof StorageError ? error : new StorageError({ reason: "invalid_input" })),
      })
      yield* Effect.tryPromise({
        try: async () => {
          await requireDirectory(global.data)
          for (const directory of directories(encoded.owner).slice(1)) {
            await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
              if (!hasCode(error, "EEXIST")) throw error
            })
            await requireDirectory(directory, true)
          }
          const file = path.join(root, encoded.owner, encoded.reference.id)
          const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`
          try {
            const handle = await fs.open(
              temporary,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
              0o600,
            )
            try {
              await handle.writeFile(encoded.content, "utf8")
              await handle.sync()
            } finally {
              await handle.close()
            }
            // A hard link publishes the complete immutable file without replacing an existing handle.
            await fs.link(temporary, file)
            if (process.platform !== "win32") {
              const directory = await fs.open(
                path.dirname(file),
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
              )
              try {
                await directory.sync()
              } finally {
                await directory.close()
              }
            }
          } finally {
            await fs.unlink(temporary).catch(() => undefined)
          }
        },
        catch: () => new StorageError({ reason: "write_failed" }),
      })
      return encoded.reference
    })

    const get = Effect.fn("ToolResultStore.get")(function* (input: { sessionID: SessionSchema.ID; id: string }) {
      const now = yield* Clock.currentTimeMillis
      return yield* Effect.tryPromise({
        try: async () => {
          if (!ID_PATTERN.test(input.id)) throw unavailable()
          const owner = sessionHash(input.sessionID)
          for (const directory of directories(owner)) await requireDirectory(directory)
          return await withFile(path.join(root, owner, input.id), async (handle, size) => {
            const bytes = await readExactly(handle, size)
            const split = bytes.indexOf(10)
            if (split < 1 || split >= MAX_HEADER_BYTES) throw unavailable()
            const header = requireHeader(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, split)),
              owner,
              now,
            )
            if (header.reference.id !== input.id) throw unavailable()
            const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(split + 1))
            const decoded = decodeBody(body)
            if (Option.isNone(decoded)) throw unavailable()
            const snapshot = decoded.value
            if (
              digest(owner, header.reference, body) !== header.reference.sha256 ||
              Buffer.byteLength(snapshot.text) !== header.reference.textBytes ||
              (snapshot.structured === undefined ? 0 : Buffer.byteLength(JSON.stringify(snapshot.structured))) !==
                header.reference.structuredBytes ||
              (snapshot.structured !== undefined) !== header.reference.hasStructured
            )
              throw unavailable()
            return { reference: header.reference, ...snapshot }
          })
        },
        catch: () => unavailable(),
      })
    })

    const list = Effect.fn("ToolResultStore.list")(function* (input: {
      sessionID: SessionSchema.ID
      cursor?: string
      limit?: number
    }) {
      const now = yield* Clock.currentTimeMillis
      return yield* Effect.tryPromise({
        try: async () => {
          const owner = sessionHash(input.sessionID)
          if (
            (input.cursor !== undefined && !ID_PATTERN.test(input.cursor)) ||
            (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIST))
          )
            throw unavailable()
          const directory = path.join(root, owner)
          if (!(await directoryExists(directories(owner)))) return { results: [], incomplete: false }
          const scan = await scanDirectory(directory, MAX_SCAN)
          const results: Reference[] = []
          for (const entry of scan.entries.filter((entry) => entry.isFile() && ID_PATTERN.test(entry.name))) {
            if (input.cursor && entry.name <= input.cursor) continue
            const reference = await withFile(path.join(directory, entry.name), async (handle, size) => {
              const bytes = await readExactly(handle, Math.min(size, MAX_HEADER_BYTES), false)
              const split = bytes.indexOf(10)
              if (split < 1) throw unavailable()
              const header = requireHeader(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, split)),
                owner,
                now,
              )
              if (header.reference.id !== entry.name) throw unavailable()
              return header.reference
            }).catch(() => undefined)
            if (reference) results.push(reference)
          }
          results.sort((a, b) => a.id.localeCompare(b.id))
          const page = results.slice(0, input.limit ?? 20)
          return {
            results: page,
            ...(!scan.incomplete && results.length > page.length ? { nextCursor: page[page.length - 1].id } : {}),
            incomplete: scan.incomplete,
          }
        },
        catch: () => unavailable(),
      })
    })

    const cleanup = Effect.fn("ToolResultStore.cleanup")(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.tryPromise({
        try: async () => {
          if (!(await directoryExists([global.data, root]))) return
          const sessions = await scanDirectory(root, MAX_SCAN)
          for (const entry of sessions.entries.filter(
            (entry) => entry.isDirectory() && HASH_PATTERN.test(entry.name),
          )) {
            const directory = path.join(root, entry.name)
            await requireDirectory(directory)
            const files = await scanDirectory(directory, MAX_SCAN)
            for (const file of files.entries.filter(
              (file) => file.isFile() && (ID_PATTERN.test(file.name) || TEMP_PATTERN.test(file.name)),
            )) {
              if (parseInt(file.name.slice(4, 17), 16) + Duration.toMillis(RETENTION) > now) continue
              // Unlink removes this directory entry; it never follows a substituted symlink.
              await fs.unlink(path.join(directory, file.name)).catch(() => undefined)
            }
            // Retire only empty managed directories so later bounded passes can reach other Sessions.
            await fs.rmdir(directory).catch(() => undefined)
          }
        },
        catch: () => undefined,
      }).pipe(Effect.ignore)
    })

    return Service.of({ put, get, list, cleanup })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

function sessionHash(sessionID: SessionSchema.ID) {
  return createHash("sha256").update(sessionID).digest("hex")
}

function digest(owner: string, reference: Omit<Reference, "sha256">, body: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        owner,
        reference.id,
        reference.tool,
        reference.toolCallID,
        reference.assistantMessageID ?? null,
        reference.createdAt,
        reference.expiresAt,
        reference.textBytes,
        reference.structuredBytes,
        reference.hasStructured,
        reference.captureTruncated,
      ]),
    )
    .update("\n")
    .update(body)
    .digest("hex")
}

function unavailable() {
  return new StorageError({ reason: "unavailable" })
}

function hasCode(error: unknown, code: string) {
  return !!error && typeof error === "object" && "code" in error && error.code === code
}

async function requireDirectory(directory: string, privateMode = false) {
  const info = await fs.lstat(directory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (privateMode && process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw unavailable()
}

async function directoryExists(directories: string[]) {
  for (const directory of directories) {
    const present = await requireDirectory(directory).then(
      () => true,
      (error: unknown) => {
        if (hasCode(error, "ENOENT")) return false
        throw error
      },
    )
    if (!present) return false
  }
  return true
}

async function scanDirectory(directory: string, maximum: number) {
  const handle = await fs.opendir(directory)
  const entries = []
  try {
    for (let count = 0; count <= maximum; count++) {
      const entry = await handle.read()
      if (!entry) return { entries, incomplete: false }
      if (count === maximum) return { entries, incomplete: true }
      entries.push(entry)
    }
    return { entries, incomplete: true }
  } finally {
    await handle.close()
  }
}

async function withFile<A>(file: string, body: (handle: fs.FileHandle, size: number) => Promise<A>) {
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw unavailable()
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BYTES || info.size < 1 || before.ino !== info.ino || before.dev !== info.dev)
      throw unavailable()
    return await body(handle, info.size)
  } finally {
    await handle.close()
  }
}

async function readExactly(handle: fs.FileHandle, size: number, complete = true) {
  const bytes = Buffer.alloc(size)
  for (let offset = 0; offset < size; ) {
    const read = await handle.read(bytes, offset, size - offset, offset)
    if (!read.bytesRead) throw unavailable()
    offset += read.bytesRead
  }
  if (complete && (await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead) throw unavailable()
  return bytes
}

function requireHeader(header: string, owner: string, now: number) {
  const decoded = decodeHeader(header)
  if (Option.isNone(decoded)) throw unavailable()
  if (
    decoded.value.owner !== owner ||
    decoded.value.reference.expiresAt <= now ||
    decoded.value.reference.createdAt > now ||
    parseInt(decoded.value.reference.id.slice(4, 17), 16) !== decoded.value.reference.createdAt ||
    decoded.value.reference.expiresAt !== decoded.value.reference.createdAt + Duration.toMillis(RETENTION) ||
    decoded.value.reference.textBytes + decoded.value.reference.structuredBytes > MAX_BYTES
  )
    throw unavailable()
  return decoded.value
}
