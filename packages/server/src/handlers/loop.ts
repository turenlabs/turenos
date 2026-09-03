import { Loop } from "@turenlabs/core/loop"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { ConflictError, InvalidRequestError, LoopNotFoundError, LoopRunNotFoundError } from "@turenlabs/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const loopIDOf = (error: unknown, fallback: string) =>
  typeof error === "object" && error !== null && "loopID" in error && typeof error.loopID === "string"
    ? error.loopID
    : fallback

const runIDOf = (error: unknown, fallback: string) =>
  typeof error === "object" && error !== null && "runID" in error && typeof error.runID === "string"
    ? error.runID
    : fallback

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined

const loopError = (error: unknown, loopID: string) => {
  if (tagOf(error) === "LoopNotFoundError")
    return new LoopNotFoundError({
      loopID: loopIDOf(error, loopID),
      message: `Loop not found: ${loopIDOf(error, loopID)}`,
    })
  if (tagOf(error) === "LoopInvalidStateError" || tagOf(error) === "LoopActiveLimitError")
    return new ConflictError({ message: "Loop state conflicts with this operation", resource: loopID })
  return new InvalidRequestError({ message: "Invalid loop request", kind: tagOf(error) })
}

const missingLoop = (error: unknown, loopID: string) =>
  new LoopNotFoundError({
    loopID: loopIDOf(error, loopID),
    message: `Loop not found: ${loopIDOf(error, loopID)}`,
  })

const missingRun = (error: unknown, loopID: string, runID: string) => {
  if (tagOf(error) === "LoopNotFoundError") return missingLoop(error, loopID)
  return new LoopRunNotFoundError({
    loopID: loopIDOf(error, loopID),
    runID: runIDOf(error, runID),
    message: `Loop run not found: ${runIDOf(error, runID)}`,
  })
}

const runError = (error: unknown, loopID: string, runID: string) => {
  if (tagOf(error) === "LoopNotFoundError" || tagOf(error) === "LoopRunNotFoundError")
    return missingRun(error, loopID, runID)
  return new ConflictError({ message: "Loop run cannot be canceled in its current state", resource: runID })
}

export const LoopHandler = HttpApiBuilder.group(Api, "server.loop", (handlers) =>
  handlers
    .handle(
      "loop.create",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop.create(ctx.payload).pipe(Effect.mapError((error) => loopError(error, "new")))
      }),
    )
    .handle(
      "loop.list",
      Effect.fn(function* () {
        const loop = yield* Loop.Service
        return yield* loop.list()
      }),
    )
    .handle(
      "loop.get",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop
          .get(ctx.params.loopID)
          .pipe(Effect.mapError((error) => missingLoop(error, ctx.params.loopID)))
      }),
    )
    .handle(
      "loop.edit",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop
          .edit({ id: ctx.params.loopID, ...ctx.payload })
          .pipe(Effect.mapError((error) => loopError(error, ctx.params.loopID)))
      }),
    )
    .handle(
      "loop.pause",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop
          .pause(ctx.params.loopID)
          .pipe(Effect.mapError((error) => loopError(error, ctx.params.loopID)))
      }),
    )
    .handle(
      "loop.resume",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop
          .resume(ctx.params.loopID)
          .pipe(Effect.mapError((error) => loopError(error, ctx.params.loopID)))
      }),
    )
    .handle(
      "loop.delete",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        yield* loop.get(ctx.params.loopID).pipe(Effect.mapError((error) => missingLoop(error, ctx.params.loopID)))
        yield* loop.delete(ctx.params.loopID).pipe(Effect.mapError((error) => loopError(error, ctx.params.loopID)))
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "loop.runNow",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop
          .runNow({ id: ctx.params.loopID, owner: "manual" })
          .pipe(Effect.mapError((error) => loopError(error, ctx.params.loopID)))
      }),
    )
    .handle(
      "loop.runList",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop
          .listRuns(ctx.params.loopID)
          .pipe(Effect.mapError((error) => missingLoop(error, ctx.params.loopID)))
      }),
    )
    .handle(
      "loop.runGet",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        return yield* loop
          .getRun({ loopID: ctx.params.loopID, id: ctx.params.runID })
          .pipe(Effect.mapError((error) => missingRun(error, ctx.params.loopID, ctx.params.runID)))
      }),
    )
    .handle(
      "loop.runCancel",
      Effect.fn(function* (ctx) {
        const loop = yield* Loop.Service
        const sessions = yield* SessionV2.Service
        const run = yield* loop
          .cancelRun({ loopID: ctx.params.loopID, id: ctx.params.runID })
          .pipe(Effect.mapError((error) => runError(error, ctx.params.loopID, ctx.params.runID)))
        if (!run.sessionID) return run
        const sessionID = SessionV2.ID.make(run.sessionID)
        const step = run.execution?.workflow?.steps[run.currentStep]
        yield* sessions
          .cancelPendingInput({
            sessionID,
            messageID: SessionMessage.ID.make(step ? `msg_loop_${run.id}_${step.id}` : `msg_loop_${run.id}`),
          })
          .pipe(Effect.catch(() => Effect.void))
        yield* sessions.interrupt(sessionID).pipe(Effect.catch(() => Effect.void))
        return run
      }),
    ),
)
