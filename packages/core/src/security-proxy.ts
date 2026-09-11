export * as SecurityProxyStore from "./security-proxy"

import { createHash, randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { ProxyPolicy } from "@turenlabs/protocol/proxy-policy"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { SecretVault } from "./secret-vault"
import { Storage } from "./storage"

export class Error extends Schema.TaggedErrorClass<Error>()("SecurityProxyStore.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly execute: (command: SecurityProxy.StoreCommand) => Effect.Effect<SecurityProxy.Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/SecurityProxyStore") {}

const CHUNK_BYTES = 512 * 1024
const MAX_CHUNKS = 16
const MAX_FLOWS = 10_000
const MAX_BYTES = 100 * 1024 * 1024
const Record = Schema.Struct({
  case: SecurityProxy.Case,
  input: SecurityProxy.Create,
  count: Schema.Number,
  bytes: Schema.Number,
  deleting: Schema.Boolean,
})
const Manifest = Schema.Struct({
  summary: SecurityProxy.Flow,
  chunks: Schema.Array(Schema.String),
  bytes: Schema.Number,
  digest: Schema.String,
  ingestion: Schema.String,
  reservation: Schema.NullOr(Schema.String),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const vault = yield* SecretVault.Service
    const lock = yield* Semaphore.make(1)

    const decodeRecord = (value: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Record))(value)
    const decodeManifest = (value: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(value)
    const readRecord = (row: Storage.State) =>
      vault.open(row.scope, row.key, row.value).pipe(Effect.flatMap(decodeRecord))
    const readManifest = (row: Storage.State) =>
      vault.open(row.scope, row.key, row.value).pipe(Effect.flatMap(decodeManifest))
    const readFlow = Effect.fn("SecurityProxyStore.readFlow")(function* (row: Storage.State) {
      const manifest = yield* readManifest(row)
      if (!manifest.chunks.length || manifest.chunks.length > MAX_CHUNKS)
        return yield* new Error({ message: "Invalid flow manifest" })
      const chunks = yield* Effect.forEach(
        manifest.chunks,
        (key) =>
          Effect.gen(function* () {
            const chunk = yield* storage.get({ scope: row.scope, key: Storage.Key.make(key) })
            if (!chunk) return yield* new Error({ message: "Flow data is unavailable" })
            return yield* vault.openBytes(chunk.scope, chunk.key, chunk.value)
          }),
        { concurrency: 1 },
      )
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.digest)
        return yield* new Error({ message: "Flow data is inconsistent" })
      const flow = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SecurityProxy.Flow))(bytes.toString("utf8"))
      return { manifest, flow }
    })

    const perform = Effect.fn("SecurityProxyStore.perform")(function* (command: SecurityProxy.StoreCommand) {
      if (!isAbsolute(command.owner.directory))
        return yield* new Error({ message: "An absolute owner directory is required" })
      const identity = JSON.stringify([
        command.owner.directory,
        command.owner.workspaceID ?? null,
        command.owner.sessionID ?? null,
      ])
      const scope = Storage.Scope.make(`security-proxy/${digest(identity)}`)
      const address = (key: string) => ({ scope, key: Storage.Key.make(key) })
      const seal = (key: string, value: unknown) =>
        Effect.gen(function* () {
          const encoded = JSON.stringify(value)
          if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024)
            return yield* new Error({ message: "Case metadata exceeds storage limit" })
          return yield* vault.seal(scope, key, encoded)
        })
      const owned = (record: typeof Record.Type) =>
        JSON.stringify([
          record.case.owner.directory,
          record.case.owner.workspaceID ?? null,
          record.case.owner.sessionID ?? null,
        ]) === identity

      if (command.type === "list") {
        const cases: SecurityProxy.Case[] = []
        let cursor: Storage.QueryInput["cursor"]
        while (true) {
          const page = yield* storage.query({ scope, prefix: "case/", limit: 100, cursor })
          for (const row of page) {
            const record = yield* readRecord(row)
            if (owned(record) && !record.deleting) cases.push(publicCase(record.case))
          }
          if (page.length < 100) break
          const last = page.at(-1)!
          cursor = { key: last.key, timeCreated: last.timeCreated }
        }
        return { cases }
      }

      const caseID = command.type === "create" ? command.input.id : command.caseID
      const caseAddress = address(`case/${caseID}`)
      const row = yield* storage.get(caseAddress)
      const record = row ? yield* readRecord(row) : undefined
      if (record && (!owned(record) || record.case.id !== caseID))
        return yield* new Error({ message: "Case owner mismatch" })

      if (command.type === "create") {
        const input = yield* Effect.try({
          try: () => ProxyPolicy.requireCreate(command.input),
          catch: () => new Error({ message: "Invalid case configuration" }),
        })
        if (record) {
          if (record.deleting || !equal(record.input, command.input))
            return yield* new Error({ message: "Conflicting case create retry" })
          return { case: record.case, created: false }
        }
        const created: typeof Record.Type = {
          case: { ...input, owner: command.owner, revision: 1, createdAt: Date.now(), rules: [] },
          input: command.input,
          count: 0,
          bytes: 0,
          deleting: false,
        }
        yield* storage.guardedBatch({
          guards: [{ ...caseAddress, expectedRevision: null }],
          sets: [{ ...caseAddress, value: yield* seal(caseAddress.key, created) }],
          removes: [],
        })
        return { case: created.case, created: true }
      }

      if (!row || !record || (record.deleting && command.type !== "delete"))
        return yield* new Error({ message: "Case not found" })
      const guard = { ...caseAddress, expectedRevision: row.revision }
      const prefix = `data/${caseID}/`

      if (command.type === "delete") {
        // Persist admission closure before paged removal; interrupted deletes can be resumed.
        if (!record.deleting) {
          yield* storage.guardedBatch({
            guards: [guard],
            sets: [{ ...caseAddress, value: yield* seal(caseAddress.key, { ...record, deleting: true }) }],
            removes: [],
          })
        }
        const deletingRevision = record.deleting ? row.revision : row.revision + 1
        while (true) {
          const page = yield* storage.query({ scope, prefix, limit: 100 })
          if (!page.length) break
          yield* storage.guardedBatch({
            guards: [{ ...caseAddress, expectedRevision: deletingRevision }],
            sets: [],
            removes: page.map((item) => address(item.key)),
          })
        }
        yield* storage.removeIfRevision({ ...caseAddress, expectedRevision: deletingRevision })
        return {}
      }
      if (command.type === "get") return { case: record.case }
      if (command.type === "rules") {
        if (command.revision !== record.case.revision) return yield* new Error({ message: "Case revision conflict" })
        const updated = { ...record.case, rules: command.rules, revision: record.case.revision + 1 }
        yield* storage.guardedBatch({
          guards: [guard],
          sets: [{ ...caseAddress, value: yield* seal(caseAddress.key, { ...record, case: updated }) }],
          removes: [],
        })
        return { case: updated }
      }
      if (command.type === "flows") {
        // The frozen command has no cursor: return only the latest bounded page.
        const page = yield* storage.query({ scope, prefix: `${prefix}flow/`, order: "time-created-desc", limit: 200 })
        const flows = yield* Effect.forEach(
          page,
          (item) => readManifest(item).pipe(Effect.map((item) => item.summary)),
          { concurrency: 1 },
        )
        return { flows }
      }

      const flowID = command.type === "put" || command.type === "reserve" ? command.flow.id : command.flowID
      const flowAddress = address(`${prefix}flow/${flowID}`)
      const previous = yield* storage.get(flowAddress)
      const stored = previous ? yield* readFlow(previous) : undefined
      if (stored && (stored.flow.caseID !== caseID || stored.flow.id !== flowID))
        return yield* new Error({ message: "Flow owner mismatch" })
      if (command.type === "flow" || command.type === "reveal") {
        if (!stored) return yield* new Error({ message: "Flow not found" })
        return { flow: command.type === "reveal" ? stored.flow : publicFlow(stored.flow) }
      }
      if (command.type === "note" && !stored) return yield* new Error({ message: "Flow not found" })
      const flow = command.type === "note" ? { ...stored!.flow, note: command.note } : command.flow
      if (flow.caseID !== caseID) return yield* new Error({ message: "Flow case mismatch" })
      const bytes = Buffer.from(canonical(flow), "utf8")
      if (bytes.length > CHUNK_BYTES * MAX_CHUNKS) return yield* new Error({ message: "Flow exceeds storage limit" })
      const hash = digest(bytes)
      const reservation =
        command.type === "reserve"
          ? digest(canonical({ ...flow, createdAt: 0 }))
          : (stored?.manifest.reservation ?? null)
      if (command.type === "reserve") {
        if (flow.source !== "replay" || flow.state !== "unknown")
          return yield* new Error({ message: "Replay reservation must have unknown outcome" })
        if (stored) {
          if (stored.manifest.reservation !== reservation)
            return yield* new Error({ message: "Conflicting replay reservation" })
          return { flow: publicFlow(stored.flow), created: false }
        }
      }
      if (command.type === "put" && stored) {
        if (stored.manifest.ingestion === hash) return { flow: publicFlow(stored.flow), created: false }
        if (
          !stored.manifest.reservation ||
          stored.flow.state !== "unknown" ||
          flow.state === "unknown" ||
          flow.source !== "replay" ||
          !equal(flow.request, stored.flow.request) ||
          flow.parentID !== stored.flow.parentID ||
          flow.createdAt !== stored.flow.createdAt ||
          !equal(flow.originalRequest, stored.flow.originalRequest) ||
          flow.note !== stored.flow.note
        )
          return yield* new Error({ message: "Conflicting flow replacement" })
      }
      if (command.type === "note" && stored && stored.manifest.digest === hash) return { flow: publicFlow(stored.flow) }
      const count = record.count + (stored ? 0 : 1)
      const size = record.bytes - (stored?.manifest.bytes ?? 0) + bytes.length
      if (count > MAX_FLOWS || size > MAX_BYTES) return yield* new Error({ message: "Case storage limit reached" })
      const generation = randomUUID()
      const chunks = Array.from(
        { length: Math.ceil(bytes.length / CHUNK_BYTES) },
        (_, index) => `${prefix}chunk/${flowID}/${generation}/${index}`,
      )
      const sets = yield* Effect.forEach(
        chunks,
        (key, index) =>
          vault
            .sealBytes(scope, key, bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES))
            .pipe(Effect.map((value) => ({ ...address(key), value }))),
        { concurrency: 1 },
      )
      const manifest: typeof Manifest.Type = {
        summary: flowSummary(flow),
        chunks,
        bytes: bytes.length,
        digest: hash,
        ingestion: command.type === "note" ? stored!.manifest.ingestion : hash,
        reservation,
      }
      // Storage revision guards stats/notes; logical case revision belongs only to configuration.
      const updated = { ...record, count, bytes: size }
      yield* storage.guardedBatch({
        guards: [guard, { ...flowAddress, expectedRevision: previous?.revision ?? null }],
        sets: [
          ...sets,
          { ...flowAddress, value: yield* seal(flowAddress.key, manifest) },
          { ...caseAddress, value: yield* seal(caseAddress.key, updated) },
        ],
        removes: (stored?.manifest.chunks ?? []).map(address),
      })
      return { flow: publicFlow(flow), created: !stored }
    })

    // A different graph/process may win CAS. Re-read to reconcile exact retries, never overwrite blindly.
    const attempt = (
      command: SecurityProxy.StoreCommand,
      remaining: number,
    ): Effect.Effect<SecurityProxy.Result, Error> =>
      perform(command).pipe(
        Effect.catchTag("Storage.RevisionConflict", () =>
          remaining > 0 && command.type !== "delete"
            ? attempt(command, remaining - 1)
            : Effect.fail(new Error({ message: "Concurrent case update; retry" })),
        ),
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error({ message: "Invalid proxy storage data" }),
        ),
      )
    return Service.of({
      execute: (command) =>
        lock.withPermit(
          Schema.decodeUnknownEffect(Schema.toType(SecurityProxy.StoreCommand))(command).pipe(
            Effect.mapError(() => new Error({ message: "Invalid proxy storage command" })),
            Effect.flatMap((validated) => attempt(validated, 3)),
          ),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Storage.node, SecretVault.node] })

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
}

function equal(left: unknown, right: unknown) {
  return canonical(left) === canonical(right)
}

// Lists are metadata-only: rules are omitted so case rows stay small.
function publicCase(value: SecurityProxy.Case): SecurityProxy.Case {
  return { ...value, rules: [] }
}

// Lists are metadata-only: even masked headers and four body previews can overwhelm IPC at 200 rows.
function flowSummary(value: SecurityProxy.Flow): SecurityProxy.Flow {
  return {
    id: value.id,
    caseID: value.caseID,
    source: value.source,
    state: value.state,
    createdAt: value.createdAt,
    status: value.status,
    durationMs: value.durationMs,
    parentID: value.parentID,
    request: {
      url: ProxyPolicy.publicURL(value.request.url),
      method: value.request.method,
      headers: [],
      body: { ...value.request.body, data: "", state: "unavailable" },
    },
    responseHeaders: [],
    responseBody: { ...value.responseBody, data: "", state: "unavailable" },
    note: value.note ? "[REDACTED]" : "",
    ...(value.error ? { error: "[REDACTED]" } : {}),
  }
}

function publicFlow(value: SecurityProxy.Flow): SecurityProxy.Flow {
  return {
    ...ProxyPolicy.publicFlow(value),
    note: value.note ? "[REDACTED]" : "",
    ...(value.error ? { error: "[REDACTED]" } : {}),
  }
}
