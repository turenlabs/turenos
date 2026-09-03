import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { Cause, Duration, Effect, Layer, Context, Schedule, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@turenlabs/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@turenlabs/schema/lsp-event"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

/**
 * How long a language server may sit unused before it is shut down.
 *
 * This is a policy the app decides on its own; it is deliberately not
 * configurable and not surfaced anywhere. The cost being managed is resident
 * memory, not CPU: a gopls attached to a ~3,000-file Go tree was measured at
 * 324MB after indexing and 1.4GB after a round of reference and implementation
 * queries, while idling at 0% CPU. With several projects open that is the only
 * resource worth reclaiming.
 *
 * Ten minutes is chosen to sit well clear of normal use. Every LSP operation
 * refreshes the clock — including the `touchFile` that `read`, `edit`, `write`
 * and `apply_patch` already perform — so a project being actively worked on
 * never evicts, and a re-spawn only ever costs what a first query would have.
 */
const IDLE_EVICTION_MS = Duration.toMillis(Duration.minutes(10))
const EVICTION_SWEEP_MS = Duration.minutes(1)

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Set<string>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
  /** `root + serverID` -> epoch ms of the last request routed to that client. */
  lastUsed: Map<string, number>
}

const clientKey = (client: { root: string; serverID: string }) => client.root + client.serverID

/**
 * Which clients have gone idle long enough to shut down.
 *
 * A client with no recorded use is treated as used *now*, not as infinitely
 * idle — otherwise a server would be killed in the window between being
 * spawned and answering its first request.
 */
export function selectIdleClients<T extends { root: string; serverID: string }>(
  clients: readonly T[],
  lastUsed: ReadonlyMap<string, number>,
  now: number,
  idleMs: number = IDLE_EVICTION_MS,
): T[] {
  return clients.filter((client) => now - (lastUsed.get(clientKey(client)) ?? now) >= idleMs)
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@forge/LSP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        if (!cfg.lsp) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Set(),
          spawning: new Map(),
          lastUsed: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => client.shutdown()))
          }),
        )

        // Idle eviction. Forked into the instance scope, so it dies with the
        // instance and never outlives the clients it manages.
        const evictIdle = Effect.gen(function* () {
          const stale = selectIdleClients(s.clients, s.lastUsed, Date.now())
          if (!stale.length) return
          // Drop them from the pool before awaiting shutdown so a concurrent
          // request spawns a fresh client rather than adopting a dying one.
          s.clients = s.clients.filter((client) => !stale.includes(client))
          for (const client of stale) s.lastUsed.delete(clientKey(client))
          yield* Effect.logInfo("evicting idle LSP servers", {
            serverIDs: stale.map((client) => client.serverID).join(", "),
          })
          yield* Effect.promise(() => Promise.all(stale.map((client) => client.shutdown().catch(() => undefined))))
          yield* events.publish(Event.Updated, {})
        })

        yield* evictIdle.pipe(
          Effect.catchCause((cause) => Effect.logError("LSP idle eviction failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(EVICTION_SWEEP_MS)),
          Effect.delay(EVICTION_SWEEP_MS),
          Effect.forkScoped,
        )

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      const clients = yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []
        let updated = 0

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          const handle = await server
            .spawn(root, ctx, flags)
            .then((value) => {
              if (!value) s.broken.add(key)
              return value
            })
            .catch(() => {
              s.broken.add(key)
              return undefined
            })

          if (!handle) return undefined
          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
            directory: ctx.directory,
            instance: ctx,
          }).catch(async () => {
            s.broken.add(key)
            await Process.stop(handle.process)
            return undefined
          })

          if (!client) return undefined

          const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing) {
            await Process.stop(handle.process)
            return existing
          }

          s.clients.push(client)
          return client
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          s.spawning.set(root + server.id, task)

          task.finally(() => {
            if (s.spawning.get(root + server.id) === task) {
              s.spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          updated++
        }

        return { result, updated }
      })
      // Refresh the idle clock for every client this request touches. Note
      // `status()` deliberately does not do this: it is a UI poll, and letting
      // it count as use would mean eviction never fires while the app is open.
      const now = Date.now()
      for (const client of clients.result) s.lastUsed.set(clientKey(client), now)
      yield* Effect.forEach(Array.from({ length: clients.updated }), () => events.publish(Event.Updated, {}), {
        discard: true,
      })
      return clients.result
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      const targets = s.clients
      const now = Date.now()
      for (const client of targets) s.lastUsed.set(clientKey(client), now)
      return yield* Effect.promise(() => Promise.all(targets.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch(() => {}),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"
