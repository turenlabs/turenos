export * as SessionTerminal from "./terminal"

import { SessionTerminal as SessionTerminalSchema } from "@turenlabs/schema/session-terminal"
import { ToolFailure } from "@turenlabs/llm"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { EventV2 } from "../event"
import { SessionV1 } from "../v1/session"
import { PermissionV2 } from "../permission"
import { Pty } from "../pty"
import { PtyID } from "../pty/schema"
import { Tool } from "../tool/tool"
import { SessionSchema } from "./schema"
import { SessionEvent } from "./event"

export const State = SessionTerminalSchema.State
export type State = SessionTerminalSchema.State

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionTerminal.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class NotSharedError extends Schema.TaggedErrorClass<NotSharedError>()("SessionTerminal.NotSharedError", {
  sessionID: SessionSchema.ID,
}) {}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<State | undefined>
  readonly create: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly share: (input: {
    readonly sessionID: SessionSchema.ID
    readonly shared: boolean
  }) => Effect.Effect<State, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly execute: (input: {
    readonly sessionID: SessionSchema.ID
    readonly input: string
    readonly idleMs?: number
    readonly timeoutMs?: number
  }) => Effect.Effect<
    { readonly output: string; readonly cursor: number },
    NotFoundError | NotSharedError | Pty.NotFoundError
  >
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionTerminal") {}

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_IDLE_MS = 250
const DEFAULT_TIMEOUT_MS = 10_000

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const location = yield* Location.Service
    const events = yield* EventV2.Service
    const bindings = new Map<SessionSchema.ID, { readonly ptyID: PtyID; shared: boolean }>()
    const locks = new Map<SessionSchema.ID, Semaphore.Semaphore>()
    const withLock = <A, E>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E>) => {
      const lock = locks.get(sessionID) ?? Semaphore.makeUnsafe(1)
      locks.set(sessionID, lock)
      return lock.withPermit(effect)
    }

    const resolve = Effect.fn("SessionTerminal.resolve")(function* (sessionID: SessionSchema.ID) {
      const binding = bindings.get(sessionID)
      if (!binding) return
      const info = yield* pty.get(binding.ptyID).pipe(Effect.option)
      if (Option.isSome(info) && info.value.status === "running")
        return { ptyID: binding.ptyID, shared: binding.shared, info: info.value, workspaceID: location.workspaceID }
      bindings.delete(sessionID)
    })

    const createUnlocked = Effect.fn("SessionTerminal.createUnlocked")(function* (sessionID: SessionSchema.ID) {
      const existing = yield* resolve(sessionID)
      if (existing) return existing
      const info = yield* pty.create({ title: "Shared terminal" })
      bindings.set(sessionID, { ptyID: info.id, shared: true })
      return { ptyID: info.id, shared: true, info, workspaceID: location.workspaceID }
    })

    const create = Effect.fn("SessionTerminal.create")((sessionID: SessionSchema.ID) =>
      withLock(sessionID, createUnlocked(sessionID)),
    )

    const share = Effect.fn("SessionTerminal.share")(
      (input: { readonly sessionID: SessionSchema.ID; readonly shared: boolean }) =>
        withLock(
          input.sessionID,
          Effect.gen(function* () {
            const state = yield* createUnlocked(input.sessionID)
            if (state.shared === input.shared) return state
            bindings.set(input.sessionID, { ptyID: state.ptyID, shared: input.shared })
            return { ...state, shared: input.shared }
          }),
        ),
    )

    const remove = Effect.fn("SessionTerminal.remove")((sessionID: SessionSchema.ID) =>
      withLock(
        sessionID,
        Effect.gen(function* () {
          const state = yield* resolve(sessionID)
          if (state) yield* pty.remove(state.ptyID).pipe(Effect.ignore)
          bindings.delete(sessionID)
        }),
      ),
    )

    yield* events.listen((event) => {
      if (event.type === SessionV1.Event.Deleted.type) {
        const sessionID = (event.data as typeof SessionV1.Event.Deleted.data.Type).sessionID
        return remove(SessionSchema.ID.make(sessionID))
      }
      if (event.type === Pty.Event.Exited.type || event.type === Pty.Event.Deleted.type) {
        const ptyID = (event.data as typeof Pty.Event.Exited.data.Type).id
        for (const [sessionID, binding] of bindings) if (binding.ptyID === ptyID) bindings.delete(sessionID)
      }
      if (event.type === SessionEvent.Moved.type) {
        const sessionID = (event.data as typeof SessionEvent.Moved.data.Type).sessionID
        return remove(SessionSchema.ID.make(sessionID))
      }
      return Effect.void
    })

    const execute = Effect.fn("SessionTerminal.execute")(
      (input: {
        readonly sessionID: SessionSchema.ID
        readonly input: string
        readonly idleMs?: number
        readonly timeoutMs?: number
      }) =>
        withLock(
          input.sessionID,
          Effect.gen(function* () {
            // No binding yet: the agent provisions the session's shared terminal itself, the
            // same way the browser tools start their browser on demand. A binding that exists
            // but was marked private still refuses.
            const state = (yield* resolve(input.sessionID)) ?? (yield* createUnlocked(input.sessionID))
            if (!state.shared) return yield* new NotSharedError({ sessionID: input.sessionID })

            const before = yield* pty.snapshot(state.ptyID)
            yield* pty.write(state.ptyID, input.input)
            const idle = input.idleMs ?? DEFAULT_IDLE_MS
            const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
            const output: string[] = []
            let cursor = before.cursor
            let elapsed = 0
            let changed = false
            while (elapsed < timeout) {
              yield* Effect.sleep(Math.min(idle, timeout - elapsed))
              elapsed += idle
              const next = yield* pty.snapshot(state.ptyID, cursor)
              output.push(next.output)
              if (next.cursor === cursor) {
                if (changed) break
                continue
              }
              changed = true
              cursor = next.cursor
            }
            return {
              output: Buffer.from(output.join("")).subarray(-MAX_OUTPUT_BYTES).toString(),
              cursor,
            }
          }),
        ),
    )

    return Service.of({ get: resolve, create, share, remove, execute })
  }),
)

export const ToolInput = Schema.Struct({
  input: Schema.String.annotate({ description: "Exact text to write to the shared terminal, including Enter as \\n." }),
  idle_ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(50), Schema.isLessThanOrEqualTo(2_000)).pipe(Schema.optional),
  timeout_ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000)).pipe(
    Schema.optional,
  ),
})

export const ToolOutput = Schema.Struct({ output: Schema.String, cursor: Schema.Int })

export function tool(service: Interface, permission: PermissionV2.Interface) {
  return Tool.make({
    description:
      "Write input to this session's shared interactive terminal and return new output after it becomes idle. Calling it provisions the terminal on first use; it appears in the app's Terminal panel where the human can watch, type, or take over. Because it is the same shell process, cwd, exported environment variables, and shell state persist between calls. If the human marked the terminal private, this call fails — ask them to enable sharing. For ordinary commands that do not need the shared shell, use bash instead.",
    input: ToolInput,
    output: ToolOutput,
    execute: (input, context) =>
      permission
        .assert({
          action: "bash",
          resources: [input.input],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        .pipe(
          Effect.mapError(() => new ToolFailure({ message: "Permission denied: shared terminal" })),
          Effect.andThen(
            service.execute({
              sessionID: context.sessionID,
              input: input.input,
              idleMs: input.idle_ms,
              timeoutMs: input.timeout_ms,
            }),
          ),
          Effect.mapError(
            (error) =>
              new ToolFailure({
                message:
                  error._tag === "SessionTerminal.NotSharedError"
                    ? "The shared terminal is private. Ask the user to enable agent sharing in the Terminal panel."
                    : "The shared terminal exited before the command finished.",
              }),
          ),
        ),
  })
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Pty.node, Location.node, EventV2.node],
})
