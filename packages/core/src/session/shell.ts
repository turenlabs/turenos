export * as SessionShell from "./shell"

import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { eq } from "drizzle-orm"
import { Cause, Context, DateTime, Deferred, Duration, Effect, Exit, Layer, Schema, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { Location } from "../location"
import { AppProcess } from "../process"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_COMMAND_BYTES = 64 * 1024
export const MAX_OUTPUT_BYTES = 1024 * 1024
export const INTERRUPTED_ERROR = "Shell execution was interrupted before this TurenOS process observed completion."

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionShell.BusyError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Session ${this.sessionID} is already running shell command ${this.messageID}`
  }
}

export class SessionBusyError extends Schema.TaggedErrorClass<SessionBusyError>()("SessionShell.SessionBusyError", {
  sessionID: SessionSchema.ID,
}) {
  override get message() {
    return `Session ${this.sessionID} is already running an agent turn`
  }
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionShell.ConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {
  override get message() {
    return `Shell message ID conflicts with an existing durable record: ${this.messageID}`
  }
}

export class InvalidTimeoutError extends Schema.TaggedErrorClass<InvalidTimeoutError>()(
  "SessionShell.InvalidTimeoutError",
  {
    timeout: Schema.Number,
    maximum: Schema.Number,
  },
) {
  override get message() {
    return `Shell timeout must be between 1 and ${this.maximum} milliseconds`
  }
}

export class InvalidCommandError extends Schema.TaggedErrorClass<InvalidCommandError>()(
  "SessionShell.InvalidCommandError",
  {
    maximumBytes: Schema.Number,
  },
) {
  override get message() {
    return `Shell command must be non-empty and no larger than ${this.maximumBytes} bytes`
  }
}

export type Error = BusyError | SessionBusyError | ConflictError | InvalidCommandError | InvalidTimeoutError

export type StartInput = {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly command: string
  readonly timeout?: number
  readonly beforeStart?: Effect.Effect<void, SessionBusyError>
  readonly after: Effect.Effect<void>
}

export interface RegistryInterface {
  readonly claim: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly release: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly active: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly sessions: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly withMessageLock: <A, E, R>(
    messageID: SessionMessage.ID,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class Registry extends Context.Service<Registry, RegistryInterface>()("@forge/v2/SessionShellRegistry") {}

const registryLayer = Layer.sync(Registry, () => {
  const sessions = new Set<SessionSchema.ID>()
  const messageLocks = KeyedMutex.makeUnsafe<SessionMessage.ID>()
  return Registry.of({
    claim: Effect.fn("SessionShellRegistry.claim")((sessionID) =>
      Effect.sync(() => {
        if (sessions.has(sessionID)) return false
        sessions.add(sessionID)
        return true
      }),
    ),
    release: Effect.fn("SessionShellRegistry.release")((sessionID) =>
      Effect.sync(() => {
        sessions.delete(sessionID)
      }),
    ),
    active: Effect.fn("SessionShellRegistry.active")((sessionID) => Effect.sync(() => sessions.has(sessionID))),
    sessions: Effect.sync(() => new Set(sessions)),
    withMessageLock: (messageID, effect) => messageLocks.withLock(messageID)(effect),
  })
})

export const registryNode = makeGlobalNode({ service: Registry, layer: registryLayer, deps: [] })

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<SessionMessage.Shell, Error>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly active: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionShell") {}

type Active = {
  readonly messageID: SessionMessage.ID
  readonly command: string
  readonly timeout: number
  readonly controller: AbortController
  readonly done: Deferred.Deferred<void>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const db = isWithReplicas(database.db) ? database.db.$primary : database.db
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const registry = yield* Registry
    const scope = yield* Scope.Scope
    const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const active = new Map<SessionSchema.ID, Active>()
    const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
    /**
     * This service is Location bound, but only its construction is: callers
     * acquire it through `Effect.provide(locations.get(...))` and then invoke
     * its methods on their own fiber, which is the Session service's global one.
     * The execution fiber is worse still — `Effect.forkIn(scope)` inherits the
     * forking fiber's context, so settlement runs unlocated too. Publish with
     * the placement this layer was built for instead of whatever the caller
     * happens to carry, so per-instance streams keep receiving shell frames.
     */
    const placement = Location.Ref.make({
      directory: location.directory,
      workspaceID: location.workspaceID,
    })

    const read = Effect.fn("SessionShell.read")(function* (
      sessionID: SessionSchema.ID,
      messageID: SessionMessage.ID,
      command: string,
      timeout: number,
    ) {
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        if (yield* SessionInput.findIdentity(db, messageID)) return yield* new ConflictError({ sessionID, messageID })
        return
      }
      const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
      if (
        row.session_id !== sessionID ||
        message.type !== "shell" ||
        message.command !== command ||
        message.callID !== callID(messageID) ||
        (message.timeout ?? DEFAULT_TIMEOUT_MS) !== timeout
      )
        return yield* new ConflictError({ sessionID, messageID })
      return message
    })

    const projected = Effect.fn("SessionShell.projected")(function* (
      sessionID: SessionSchema.ID,
      messageID: SessionMessage.ID,
      command: string,
      timeout: number,
    ) {
      const message = yield* read(sessionID, messageID, command, timeout)
      if (!message) return yield* Effect.die(`Shell message was not projected: ${messageID}`)
      return message
    })

    const settle = Effect.fn("SessionShell.settle")(function* (
      input: StartInput,
      settlement: {
        readonly status: "completed" | "cancelled" | "timed_out" | "failed"
        readonly output: string
        readonly exitCode?: number
        readonly truncated?: boolean
        readonly error?: string
      },
    ) {
      yield* events.publish(
        SessionEvent.Shell.Ended,
        {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          callID: callID(input.messageID),
          ...settlement,
        },
        { location: placement },
      )
    })

    const run = Effect.fn("SessionShell.run")(function* (input: StartInput, current: Active) {
      const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
      const entries = yield* config.entries()
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])),
      ).shell
      const shell = configured ?? (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")
      const command = ChildProcess.make(input.command, [], {
        cwd: location.directory,
        shell,
        stdin: "ignore",
        detached: process.platform !== "win32",
        extendEnv: true,
        env: { TERM: "dumb" },
        forceKillAfter: Duration.seconds(3),
      })
      const exit = yield* appProcess
        .run(command, {
          combineOutput: true,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          maxErrorBytes: MAX_OUTPUT_BYTES,
          signal: current.controller.signal,
          timeout: Duration.millis(timeout),
        })
        .pipe(Effect.exit)

      if (Exit.isSuccess(exit)) {
        const notice = exit.value.outputTruncated ? "\n\n[output capture truncated at the in-memory safety limit]" : ""
        yield* settle(input, {
          status: "completed",
          output: `${exit.value.output?.toString("utf8") ?? ""}${notice}`,
          exitCode: exit.value.exitCode,
          truncated: exit.value.outputTruncated === true,
        })
        return
      }

      const cause = Cause.squash(exit.cause)
      const cancelled =
        current.controller.signal.aborted || (Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
      const timedOut =
        cause instanceof AppProcess.AppProcessError &&
        cause.cause instanceof Error &&
        cause.cause.message === "Timed out"
      const status = cancelled ? "cancelled" : timedOut ? "timed_out" : "failed"
      const message =
        status === "cancelled"
          ? "User cancelled the shell command."
          : status === "timed_out"
            ? `Shell command exceeded the ${timeout} ms timeout.`
            : cause instanceof Error
              ? cause.message
              : String(cause)
      const output = bounded(message)
      yield* settle(input, { status, output, error: output })
    })

    const start = Effect.fn("SessionShell.start")((input: StartInput) =>
      Effect.uninterruptible(
        registry.withMessageLock(
          input.messageID,
          locks.withLock(input.sessionID)(
            Effect.gen(function* () {
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              if (!input.command.trim() || Buffer.byteLength(input.command) > MAX_COMMAND_BYTES)
                return yield* new InvalidCommandError({ maximumBytes: MAX_COMMAND_BYTES })
              if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS)
                return yield* new InvalidTimeoutError({ timeout, maximum: MAX_TIMEOUT_MS })

              const running = active.get(input.sessionID)
              if (running) {
                if (running.messageID !== input.messageID)
                  return yield* new BusyError({ sessionID: input.sessionID, messageID: running.messageID })
                if (running.command !== input.command || running.timeout !== timeout)
                  return yield* new ConflictError({ sessionID: input.sessionID, messageID: input.messageID })
                return yield* projected(input.sessionID, input.messageID, input.command, timeout)
              }

              const existing = yield* read(input.sessionID, input.messageID, input.command, timeout)
              if (existing?.time.completed) return existing
              if (existing) {
                if (yield* registry.active(input.sessionID)) return existing
                yield* settle(input, { status: "failed", output: INTERRUPTED_ERROR, error: INTERRUPTED_ERROR })
                return yield* projected(input.sessionID, input.messageID, input.command, timeout)
              }

              if (input.beforeStart) yield* input.beforeStart
              if (!(yield* registry.claim(input.sessionID)))
                return yield* new SessionBusyError({ sessionID: input.sessionID })
              const published = yield* events
                .publish(
                  SessionEvent.Shell.Started,
                  {
                    sessionID: input.sessionID,
                    messageID: input.messageID,
                    timestamp: yield* DateTime.now,
                    callID: callID(input.messageID),
                    command: input.command,
                    timeout,
                  },
                  { location: placement },
                )
                .pipe(
                  Effect.as(true),
                  Effect.catchDefect((defect) =>
                    defect instanceof SessionInput.LifecycleConflict
                      ? new ConflictError({ sessionID: input.sessionID, messageID: input.messageID })
                      : read(input.sessionID, input.messageID, input.command, timeout).pipe(
                          Effect.flatMap((message) => (message ? Effect.succeed(false) : Effect.die(defect))),
                        ),
                  ),
                  Effect.onExit((exit) => (Exit.isFailure(exit) ? registry.release(input.sessionID) : Effect.void)),
                )
              if (!published) {
                yield* registry.release(input.sessionID)
                return yield* projected(input.sessionID, input.messageID, input.command, timeout)
              }

              const current: Active = {
                messageID: input.messageID,
                command: input.command,
                timeout,
                controller: new AbortController(),
                done: yield* Deferred.make<void>(),
              }
              active.set(input.sessionID, current)
              yield* run(input, current).pipe(
                Effect.andThen(input.after.pipe(Effect.catchCause(Effect.logError))),
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to settle shell execution", cause).pipe(
                    Effect.annotateLogs({ sessionID: input.sessionID, messageID: input.messageID }),
                  ),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (active.get(input.sessionID) === current) active.delete(input.sessionID)
                  }).pipe(
                    Effect.andThen(registry.release(input.sessionID)),
                    Effect.andThen(Deferred.succeed(current.done, undefined)),
                  ),
                ),
                Effect.forkIn(scope),
              )
              return yield* projected(input.sessionID, input.messageID, input.command, timeout)
            }),
          ),
        ),
      ),
    )

    return Service.of({
      start,
      interrupt: Effect.fn("SessionShell.interrupt")(function* (sessionID) {
        const current = active.get(sessionID)
        if (!current) return
        current.controller.abort(new Error("User cancelled the shell command"))
        yield* Deferred.await(current.done)
      }),
      active: Effect.fn("SessionShell.active")(function* (sessionID) {
        return yield* registry.active(sessionID)
      }),
    })
  }),
)

const callID = (messageID: SessionMessage.ID) => `call_${messageID.slice("msg_".length)}`
const bounded = (value: string) => {
  if (Buffer.byteLength(value) <= MAX_OUTPUT_BYTES) return value
  return (
    Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString("utf8") +
    "\n\n[output capture truncated at the in-memory safety limit]"
  )
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Database.node, AppProcess.node, Config.node, Location.node, registryNode],
})
