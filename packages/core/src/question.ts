export * as QuestionV2 from "./question"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { Question } from "@turenlabs/schema/question"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionV2.RejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("QuestionV2.NotFoundError", {
  requestID: ID,
}) {}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Question") {}

interface Pending {
  readonly request: Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const pending = new Map<ID, Pending>()

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const items = Array.from(pending.values())
        pending.clear()
        yield* Effect.forEach(items, (item) => Deferred.fail(item.deferred, new RejectedError()), { discard: true })
        yield* Effect.forEach(
          items,
          (item) =>
            events.publish(Event.Rejected, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
            }),
          { discard: true },
        )
      }),
    )

    const take = (requestID: ID) => {
      const existing = pending.get(requestID)
      if (existing) pending.delete(requestID)
      return existing
    }

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
          const request: Request = { id, ...input }
          pending.set(id, { request, deferred })
          return yield* events.publish(Event.Asked, request).pipe(
            Effect.andThen(
              restore(Deferred.await(deferred)).pipe(
                Effect.onInterrupt(() =>
                  Effect.suspend(() => {
                    const existing = take(request.id)
                    if (!existing || existing.deferred !== deferred) return Effect.void
                    return Deferred.fail(deferred, new RejectedError()).pipe(
                      Effect.andThen(
                        events.publish(Event.Rejected, {
                          sessionID: request.sessionID,
                          requestID: request.id,
                        }),
                      ),
                    )
                  }),
                ),
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = take(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events
            .publish(Event.Replied, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              answers: input.answers.map((answer) => [...answer]),
            })
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Effect.sync(() => pending.set(input.requestID, existing)) : Effect.void,
              ),
            )
          yield* Deferred.succeed(existing.deferred, input.answers)
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = take(requestID)
          if (!existing) return yield* new NotFoundError({ requestID })
          yield* events
            .publish(Event.Rejected, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
            })
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Effect.sync(() => pending.set(requestID, existing)) : Effect.void,
              ),
            )
          yield* Deferred.fail(existing.deferred, new RejectedError())
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node] })
