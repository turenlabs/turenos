export * as Pty from "./pty"

import { makeLocationNode } from "./effect/app-node"
import type { Disp, Proc } from "#pty"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Pty } from "@turenlabs/schema/pty"
import { Config } from "./config"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PtyID } from "./pty/schema"
import { Shell } from "./shell"
import { lazy } from "./util/lazy"

const BUFFER_LIMIT = 1024 * 1024 * 2
// Output is merged into the previous chunk while that chunk is shorter than this,
// so byte-at-a-time output keeps the chunk list short.
const COALESCE_LIMIT = 8 * 1024
// Exited sessions stay observable (status, exit code, retained output) until removed explicitly.
// Cap retention so abandoned terminals do not accumulate unbounded buffers.
const EXITED_LIMIT = 25
const pty = lazy(() => import("#pty"))

type Subscriber = {
  readonly onData: (chunk: string) => void
  readonly onEnd: (event: { exitCode?: number }) => void
  active: boolean
  detached: boolean
  pending: string[]
  end?: { exitCode?: number }
}

type Active = {
  info: Info
  process: Proc
  // Retained scrollback as a chunk list; chunks before head are dropped and compacted lazily.
  chunks: string[]
  head: number
  // Retained UTF-16 units across live chunks, never above BUFFER_LIMIT.
  length: number
  // Absolute cursor of the first retained unit.
  bufferCursor: number
  cursor: number
  subscribers: Map<object, Subscriber>
  listeners: Disp[]
}

export const Info = Pty.Info
export type Info = Types.DeepMutable<typeof Info.Type>

export const CreateInput = Pty.CreateInput

export type CreateInput = Types.DeepMutable<typeof CreateInput.Type>

export const UpdateInput = Pty.UpdateInput

export type UpdateInput = Types.DeepMutable<typeof UpdateInput.Type>

export const Event = Pty.Event

export type AttachInput = {
  // Absolute output cursor to replay from. -1 tails from the current end; omitted replays the full retained buffer.
  readonly cursor?: number
  // Callbacks fire synchronously from the native PTY data path; keep them non-blocking.
  readonly onData: (chunk: string) => void
  // Fired once when the session stops producing output: process exit (exitCode set), removal, or service teardown.
  readonly onEnd: (event: { exitCode?: number }) => void
}

export type Attachment = {
  // Retained output from the requested cursor to the current end.
  readonly replay: string
  // Absolute output cursor after replay.
  readonly cursor: number
  readonly write: (data: string) => void
  // Starts live delivery after the caller has applied replay and cursor metadata.
  readonly activate: () => void
  readonly detach: () => void
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class ExitedError extends Schema.TaggedErrorClass<ExitedError>()("Pty.ExitedError", {
  ptyID: PtyID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError>
  readonly write: (id: PtyID, data: string) => Effect.Effect<void, NotFoundError>
  readonly attach: (id: PtyID, input: AttachInput) => Effect.Effect<Attachment, NotFoundError | ExitedError>
  readonly snapshot: (id: PtyID, cursor?: number) => Effect.Effect<{ output: string; cursor: number }, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Pty") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const sessions = new Map<PtyID, Active>()
    const exitOrder: PtyID[] = []

    function notifyEnd(session: Active, event: { exitCode?: number }) {
      for (const subscriber of session.subscribers.values()) {
        if (!subscriber.active) {
          subscriber.end = event
          continue
        }
        try {
          subscriber.onEnd(event)
        } catch {}
      }
      session.subscribers.clear()
    }

    function teardown(session: Active) {
      for (const listener of session.listeners) listener.dispose()
      session.listeners.length = 0
      if (session.info.status === "running") {
        try {
          session.process.kill()
        } catch {}
      }
      notifyEnd(session, {})
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of sessions.values()) teardown(session)
        sessions.clear()
        exitOrder.length = 0
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const removeSession = Effect.fnUntraced(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return
      sessions.delete(id)
      const index = exitOrder.indexOf(id)
      if (index !== -1) exitOrder.splice(index, 1)
      yield* Effect.logInfo("removing session", { id })
      teardown(session)
      yield* events.publish(Event.Deleted, { id: session.info.id })
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      yield* requireSession(id)
      yield* removeSession(id)
    })

    const list = Effect.fn("Pty.list")(function* () {
      return Array.from(sessions.values()).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const id = PtyID.ascending()
      const command = input.command || Shell.preferred(Config.latest(yield* config.entries(), "shell"))
      const args = Shell.login(command) ? [...(input.args ?? []), "-l"] : [...(input.args ?? [])]
      const cwd = input.cwd || location.directory
      const env = {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        FORGE_TERMINAL: "1",
      } as Record<string, string>
      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      yield* Effect.logInfo("creating session", { id, cmd: command, args, cwd })
      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() => spawn(command, args, { name: "xterm-256color", cwd, env }))
      const info: Info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
      }
      const session: Active = {
        info,
        process: proc,
        chunks: [],
        head: 0,
        length: 0,
        bufferCursor: 0,
        cursor: 0,
        subscribers: new Map(),
        listeners: [],
      }
      sessions.set(id, session)
      session.listeners.push(
        proc.onData((chunk) => {
          session.cursor += chunk.length
          for (const [token, subscriber] of session.subscribers.entries()) {
            if (!subscriber.active) {
              subscriber.pending.push(chunk)
              continue
            }
            try {
              subscriber.onData(chunk)
            } catch {
              session.subscribers.delete(token)
            }
          }
          appendScrollback(session, chunk)
        }),
        proc.onExit(({ exitCode }) => {
          if (session.info.status === "exited") return
          session.info.status = "exited"
          session.info.exitCode = exitCode
          notifyEnd(session, { exitCode })
          exitOrder.push(id)
          runFork(
            Effect.gen(function* () {
              yield* Effect.logInfo("session exited", { id, exitCode })
              yield* events.publish(Event.Exited, { id, exitCode })
              while (exitOrder.length > EXITED_LIMIT) {
                const oldest = exitOrder[0]
                if (!oldest) break
                yield* removeSession(oldest)
              }
            }),
          )
        }),
      )
      yield* events.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) session.info.title = input.title
      if (input.size && session.info.status === "running") session.process.resize(input.size.cols, input.size.rows)
      yield* events.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") session.process.write(data)
    })

    const attach = Effect.fn("Pty.attach")(function* (id: PtyID, input: AttachInput) {
      const session = yield* requireSession(id)
      if (session.info.status !== "running") return yield* new ExitedError({ ptyID: id })
      yield* Effect.logInfo("client attached to session", { id, directory: location.directory })
      const token = {}
      const subscriber: Subscriber = {
        onData: input.onData,
        onEnd: input.onEnd,
        active: false,
        detached: false,
        pending: [],
      }
      session.subscribers.set(token, subscriber)
      const end = session.cursor
      const from =
        input.cursor === -1
          ? end
          : typeof input.cursor === "number" && Number.isSafeInteger(input.cursor)
            ? Math.max(0, input.cursor)
            : 0
      return {
        replay: from >= end ? "" : readScrollback(session, from),
        cursor: end,
        write: (data: string) => {
          if (session.info.status === "running") session.process.write(data)
        },
        activate: () => {
          if (subscriber.active || subscriber.detached) return
          subscriber.active = true
          try {
            for (const chunk of subscriber.pending) subscriber.onData(chunk)
            subscriber.pending.length = 0
            if (subscriber.end) subscriber.onEnd(subscriber.end)
          } catch {
            session.subscribers.delete(token)
          }
        },
        detach: () => {
          subscriber.detached = true
          subscriber.pending.length = 0
          subscriber.end = undefined
          session.subscribers.delete(token)
        },
      }
    })

    const snapshot = Effect.fn("Pty.snapshot")(function* (id: PtyID, cursor = 0) {
      const session = yield* requireSession(id)
      const from = Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0
      return {
        output: readScrollback(session, from),
        cursor: session.cursor,
      }
    })

    return Service.of({ list, get, create, update, remove, write, attach, snapshot })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Location.node, Config.node] })

function appendScrollback(session: Active, chunk: string) {
  if (chunk.length === 0) return
  const last = session.chunks.length - 1
  if (last >= session.head && session.chunks[last].length < COALESCE_LIMIT) session.chunks[last] += chunk
  else session.chunks.push(chunk)
  session.length += chunk.length
  while (session.length > BUFFER_LIMIT) {
    const first = session.chunks[session.head]
    if (session.length - first.length < BUFFER_LIMIT) {
      const excess = session.length - BUFFER_LIMIT
      session.chunks[session.head] = first.slice(excess)
      session.bufferCursor += excess
      session.length = BUFFER_LIMIT
      break
    }
    session.chunks[session.head] = ""
    session.head++
    session.length -= first.length
    session.bufferCursor += first.length
  }
  if (session.head > session.chunks.length / 2) {
    session.chunks.splice(0, session.head)
    session.head = 0
  }
}

// Returns the retained output at or after the absolute cursor. Walks back from the newest chunk so reads near the tail
// only touch the chunks they return. The end is bufferCursor + length rather than session.cursor because onData
// advances session.cursor before the chunk is stored, so a read from a subscriber callback sees the older end.
function readScrollback(session: Active, from: number) {
  const end = session.bufferCursor + session.length
  if (from >= end) return ""
  if (from <= session.bufferCursor) return session.chunks.slice(session.head).join("")
  let need = end - from
  let index = session.chunks.length
  while (need > 0 && index > session.head) {
    index--
    need -= session.chunks[index].length
  }
  // need is now minus the units of chunks[index] that precede the cursor (zero on a chunk boundary).
  return session.chunks[index].slice(-need) + session.chunks.slice(index + 1).join("")
}
