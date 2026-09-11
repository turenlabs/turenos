export * as ShellJob from "./shell-job"

import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import { ToolFailure } from "@turenlabs/llm"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"
import { AppProcess } from "./process"
import { Storage } from "./storage"

export const MAX_ACTIVE = 32
export const MAX_OWNER_ACTIVE = 4
export const MAX_LIST = 32
export const INLINE_MS = 1_000
export const GRACE_MS = 10_000
export const MAX_OUTPUT_BYTES = 1024 * 1024
export const Status = Schema.Literals([
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
])
export const Info = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  status: Status,
  output: Schema.String,
  truncated: Schema.Boolean,
  exit: Schema.optional(Schema.Number),
  terminationGraceExceeded: Schema.optional(Schema.Boolean),
  createdAt: Schema.Number,
})
export type Info = typeof Info.Type
export const Record = Schema.Struct({
  ...Info.fields,
  identity: Schema.String,
  request: Schema.String,
  owner: Schema.String,
  host: Schema.String,
  ownerPID: Schema.Number,
  delivery: Schema.Literals(["inline", "pending", "sent"]),
})
type Record = typeof Record.Type
export type Notify = (info: Info) => Effect.Effect<void>
export type Start = {
  sessionID: string
  messageID: string
  callID: string
  request: string
  timeout: number
  run: Effect.Effect<AppProcess.RunResult, AppProcess.AppProcessError>
  notify?: Notify
}
export interface Interface {
  start: (input: Start) => Effect.Effect<Info, ToolFailure>
  observe: (sessionID: string, id: string) => Effect.Effect<Info, ToolFailure>
  list: (sessionID: string) => Effect.Effect<ReadonlyArray<Info>>
  wait: (sessionID: string, id: string, timeout: number) => Effect.Effect<Info, ToolFailure>
  detach: (sessionID: string, id: string) => Effect.Effect<Info, ToolFailure>
  cancel: (sessionID: string, id: string) => Effect.Effect<Info, ToolFailure>
  deliver: (sessionID: string, notify: Notify) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@forge/ShellJob") {}
export const recordScope = Storage.Scope.make("internal/shell-jobs/records")
export const outputScope = Storage.Scope.make("internal/shell-jobs/output")
const runtimes = new Set<string>()
const live = (info: Info) => info.status === "running" || info.status === "stopping"
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Record))
const prefix = (sessionID: string) => `job_${createHash("sha256").update(sessionID).digest("hex")}_`
const summary = (record: Record): Info => ({
  id: record.id,
  sessionID: record.sessionID,
  status: record.status,
  output: record.output,
  truncated: record.truncated,
  exit: record.exit,
  terminationGraceExceeded: record.terminationGraceExceeded,
  createdAt: record.createdAt,
})

/** Server-PID existence probe only, never a command PID or a termination signal.
 * A reused PID is deliberately treated conservatively as a possible live owner.
 */
const ownerGone = (record: Record) => {
  if (record.host !== os.hostname()) return Effect.succeed(false)
  if (record.ownerPID === process.pid) return Effect.succeed(!runtimes.has(record.owner))
  return Effect.try({ try: () => process.kill(record.ownerPID, 0), catch: (error) => error }).pipe(
    Effect.as(false),
    Effect.catch((error) => Effect.succeed(error instanceof Error && "code" in error && error.code === "ESRCH")),
  )
}

/** Global runner: admission is durable before fork; no persisted command is ever replayed. */
export const make = Effect.gen(function* () {
  const storage = yield* Storage.Service
  const serviceScope = yield* Scope.Scope
  const owner = randomUUID()
  runtimes.add(owner)
  const lock = KeyedMutex.makeUnsafe<string>()
  const lifecycle = { closing: false }
  const active = new Map<
    string,
    {
      sessionID: string
      fiber: Fiber.Fiber<AppProcess.RunResult, AppProcess.AppProcessError>
      done: Deferred.Deferred<void>
      cancelled: boolean
      notify?: Notify
    }
  >()
  const address = (id: string) => ({ scope: recordScope, key: Storage.Key.make(id) })
  const save = (record: Record) =>
    storage.set({ ...address(record.id), value: JSON.stringify(record) }).pipe(Effect.as(record))
  const read = Effect.fn("ShellJob.read")(function* (sessionID: string, id: string) {
    if (!id.startsWith(prefix(sessionID)))
      return yield* new ToolFailure({ message: "Shell job not found in this session" })
    const row = yield* storage.get(address(id))
    if (!row) return yield* new ToolFailure({ message: "Shell job not found in this session" })
    const record = decode(row.value)
    if (record.sessionID !== sessionID)
      return yield* new ToolFailure({ message: "Shell job not found in this session" })
    return record
  })
  const recover = Effect.fn("ShellJob.recover")(function* (row: Storage.State) {
    const record = decode(row.value)
    if (!live(record) || !(yield* ownerGone(record))) return record
    const interrupted: Record = {
      ...record,
      status: "interrupted",
      output: "Process ownership was lost; completion is unknown. This command will not be rerun.",
    }
    return yield* storage
      .compareAndSwap({ ...address(record.id), expectedRevision: row.revision, value: JSON.stringify(interrupted) })
      .pipe(
        Effect.as(interrupted),
        Effect.catchTag("Storage.RevisionConflict", () => read(record.sessionID, record.id).pipe(Effect.orDie)),
      )
  })
  // Bounded metadata-only pages; captured output is in a separate namespace.
  let cursor: Storage.QueryInput["cursor"]
  while (true) {
    const rows = yield* storage.query({ scope: recordScope, prefix: "job_", limit: MAX_LIST, cursor })
    for (const row of rows) yield* recover(row)
    const last = rows.at(-1)
    if (rows.length < MAX_LIST || !last) break
    cursor = { key: last.key, timeCreated: last.timeCreated }
  }
  const observe: Interface["observe"] = Effect.fn("ShellJob.observe")(function* (sessionID, id) {
    const record = yield* read(sessionID, id)
    const output = live(record) ? undefined : yield* storage.get({ scope: outputScope, key: Storage.Key.make(id) })
    return { ...summary(record), output: record.output || output?.value || "" }
  })
  const deliverOne = (sessionID: string, id: string, notify: Notify) =>
    lock
      .withLock(id)(
        Effect.gen(function* () {
          const record = yield* read(sessionID, id)
          if (live(record) || record.delivery !== "pending") return
          // Callback must durably admit its deterministic notification before succeeding.
          const sent = yield* notify(summary(record)).pipe(
            Effect.as(true),
            Effect.catchCause((cause) => Effect.logError(cause).pipe(Effect.as(false))),
          )
          if (sent) yield* save({ ...record, delivery: "sent" })
        }),
      )
      .pipe(Effect.catchCause(Effect.logError))
  const stop = (id: string) =>
    lock.withLock(id)(
      Effect.gen(function* () {
        const current = active.get(id)
        if (!current) return
        const record = yield* read(current.sessionID, id)
        if (!live(record)) return
        current.cancelled = true
        yield* save({ ...record, status: "stopping", output: "Cancellation requested; process teardown is pending." })
        // Waiting on interruption can hang on inherited stdio; never await it here.
        yield* Fiber.interrupt(current.fiber).pipe(Effect.forkDetach({ startImmediately: true }))
      }),
    )
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      lifecycle.closing = true
      const current = [...active.entries()]
      yield* Effect.forEach(current, ([id]) => stop(id).pipe(Effect.ignore), {
        concurrency: "unbounded",
        discard: true,
      })
      yield* Effect.forEach(current, ([, job]) => Fiber.await(job.fiber), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.timeoutOption(GRACE_MS))
      // Late process teardown cannot mutate a subsequently reconstructed service's rows.
      runtimes.delete(owner)
    }),
  )
  const start: Interface["start"] = (input) =>
    lock.withLock("admission")(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (lifecycle.closing) return yield* new ToolFailure({ message: "Shell job runner is shutting down" })
          if (
            !Number.isSafeInteger(input.timeout) ||
            input.timeout < 1 ||
            input.timeout > 600_000 ||
            Buffer.byteLength(input.request) > 256 * 1024
          )
            return yield* new ToolFailure({ message: "Invalid shell job request bounds" })
          const identity = JSON.stringify([input.sessionID, input.messageID, input.callID])
          const id = `${prefix(input.sessionID)}${createHash("sha256").update(identity).digest("hex")}`
          const row = yield* storage.get(address(id))
          if (row) {
            const record = yield* recover(row)
            if (record.identity !== identity || record.request !== input.request)
              return yield* new ToolFailure({ message: "Shell job identity conflicts with an earlier command" })
            return yield* observe(input.sessionID, id)
          }
          if (active.size >= MAX_ACTIVE)
            return yield* new ToolFailure({
              message: `Shell job limit reached (${active.size}/${MAX_ACTIVE} active across all sessions). Retry after running jobs complete.`,
            })
          const ownerJobs = [...active.entries()].flatMap(([id, job]) => (job.sessionID === input.sessionID ? [id] : []))
          if (ownerJobs.length >= MAX_OWNER_ACTIVE) {
            // The bare rejection invited blind retries: name the occupants and the remedy so the
            // next action is shell_job wait/status/cancel on a listed job, not another bash call.
            const occupants = yield* Effect.forEach(
              ownerJobs,
              (id) =>
                read(input.sessionID, id).pipe(
                  Effect.map(
                    (record) => `${record.id} ${record.status} ${Math.round((Date.now() - record.createdAt) / 1000)}s`,
                  ),
                ),
              { concurrency: "unbounded" },
            )
            return yield* new ToolFailure({
              message: `Session active shell job limit reached (${ownerJobs.length}/${MAX_OWNER_ACTIVE} in use: ${occupants.join(", ")}). Use shell_job list/status/output/wait/cancel on a listed job to free a slot, or retry once one completes.`,
            })
          }
          const record: Record = {
            id,
            sessionID: input.sessionID,
            identity,
            request: input.request,
            owner,
            ownerPID: process.pid,
            host: os.hostname(),
            delivery: "inline",
            status: "running",
            output: "",
            truncated: false,
            createdAt: Date.now(),
          }
          const admitted = yield* storage
            .compareAndSwap({ ...address(id), expectedRevision: null, value: JSON.stringify(record) })
            .pipe(
              Effect.as(true),
              Effect.catchTag("Storage.RevisionConflict", () => Effect.succeed(false)),
            )
          if (!admitted) {
            const existing = yield* read(input.sessionID, id)
            if (existing.identity !== identity || existing.request !== input.request)
              return yield* new ToolFailure({ message: "Shell job identity conflicts with an earlier command" })
            return summary(existing)
          }
          // Detached only from the originating tool. The service finalizer above owns interruption.
          const fiber = yield* input.run.pipe(Effect.interruptible, Effect.forkDetach({ startImmediately: true }))
          const current = {
            sessionID: input.sessionID,
            fiber,
            done: yield* Deferred.make<void>(),
            cancelled: false,
            notify: input.notify,
          }
          active.set(id, current)
          yield* Effect.gen(function* () {
            const bounded = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(input.timeout + GRACE_MS))
            if (Option.isNone(bounded)) {
              yield* lock.withLock(id)(
                read(input.sessionID, id).pipe(
                  Effect.flatMap((latest) =>
                    save({
                      ...latest,
                      status: "stopping",
                      terminationGraceExceeded: true,
                      output: "Timeout exceeded; process teardown is pending and the command may still be running.",
                    }),
                  ),
                ),
              )
              yield* Fiber.interrupt(fiber).pipe(Effect.forkDetach({ startImmediately: true }))
            }
            const exit = Option.isSome(bounded) ? bounded.value : yield* Fiber.await(fiber)
            if (lifecycle.closing) return
            yield* lock.withLock(id)(
              Effect.gen(function* () {
                const latest = yield* read(input.sessionID, id)
                const cause = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
                const timedOut =
                  cause instanceof AppProcess.AppProcessError &&
                  cause.cause instanceof Error &&
                  cause.cause.message === "Timed out"
                const output = Exit.isSuccess(exit)
                  ? (exit.value.output?.toString("utf8") ?? "")
                  : current.cancelled
                    ? "Cancellation teardown completed."
                    : timedOut
                      ? `Command exceeded timeout of ${input.timeout} ms. Retry with a larger timeout if the command is expected to take longer.`
                      : "Shell execution failed."
                const captured = new TextDecoder().decode(Buffer.from(output).subarray(0, MAX_OUTPUT_BYTES), {
                  stream: true,
                })
                yield* storage.set({ scope: outputScope, key: Storage.Key.make(id), value: captured })
                yield* save({
                  ...latest,
                  status: current.cancelled
                    ? "cancelled"
                    : timedOut || Option.isNone(bounded)
                      ? "timed_out"
                      : Exit.isSuccess(exit) && exit.value.exitCode === 0
                        ? "completed"
                        : "failed",
                  output: "",
                  truncated:
                    Buffer.byteLength(output) > MAX_OUTPUT_BYTES ||
                    (Exit.isSuccess(exit) && exit.value.outputTruncated === true),
                  ...(Exit.isSuccess(exit) ? { exit: exit.value.exitCode } : {}),
                })
              }),
            )
            active.delete(id)
            yield* Deferred.succeed(current.done, undefined)
            if (current.notify) yield* deliverOne(input.sessionID, id, current.notify)
          }).pipe(
            Effect.interruptible,
            Effect.catchCause(Effect.logError),
            Effect.forkIn(serviceScope, { startImmediately: true }),
          )
          return summary(record)
        }),
      ),
    )
  const wait: Interface["wait"] = Effect.fn("ShellJob.wait")(function* (sessionID, id, timeout) {
    const record = yield* read(sessionID, id)
    const current = active.get(id)
    if (live(record) && current)
      yield* Deferred.await(current.done).pipe(Effect.timeoutOption(Math.min(610_000, Math.max(1, timeout))))
    return yield* observe(sessionID, id)
  })
  return Service.of({
    start,
    observe,
    wait,
    list: (sessionID) =>
      storage
        .query({ scope: recordScope, prefix: prefix(sessionID), limit: MAX_LIST, order: "time-created-desc" })
        .pipe(Effect.map((rows) => rows.map((row) => summary(decode(row.value))))),
    detach: (sessionID, id) =>
      lock.withLock(id)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const record = yield* read(sessionID, id)
            // Settlement and this decision share a lock: completed quick commands stay inline.
            if (live(record) && record.delivery === "inline") yield* save({ ...record, delivery: "pending" })
            return yield* observe(sessionID, id)
          }),
        ),
      ),
    cancel: (sessionID, id) =>
      Effect.gen(function* () {
        const record = yield* read(sessionID, id)
        if (!live(record)) return yield* observe(sessionID, id)
        if (!active.has(id))
          return yield* new ToolFailure({ message: "This process does not own the shell job; no PID was signalled" })
        yield* stop(id)
        return yield* observe(sessionID, id)
      }),
    deliver: (sessionID, notify) =>
      Effect.gen(function* () {
        let cursor: Storage.QueryInput["cursor"]
        while (true) {
          const rows = yield* storage.query({
            scope: recordScope,
            prefix: prefix(sessionID),
            limit: MAX_LIST,
            order: "time-created-desc",
            cursor,
          })
          for (const row of rows) {
            const record = decode(row.value)
            if (record.delivery === "pending" && !live(record)) yield* deliverOne(sessionID, record.id, notify)
          }
          const last = rows.at(-1)
          if (rows.length < MAX_LIST || !last) break
          cursor = { key: last.key, timeCreated: last.timeCreated }
        }
      }),
  })
})
export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [Storage.node] })
