import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, QuestionNotFoundError } from "../errors"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    const tasks = yield* SessionTaskV2.Service

    const assertRequestMutation = Effect.fn("QuestionHttpApi.assertRequestMutation")(function* (requestID: QuestionID) {
      const request = (yield* svc.list()).find((item) => item.id === requestID)
      if (!request) return
      yield* tasks.authorizeMutation({ sessionID: request.sessionID }).pipe(
        Effect.catchTag(
          "SessionTask.OwnedSessionError",
          (error) =>
            new InvalidRequestError({
              kind: "session_task_owned",
              message: `${error.message}: ${error.sessionID} is owned by ${error.taskID}`,
            }),
        ),
      )
    })

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      yield* assertRequestMutation(ctx.params.requestID)
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* assertRequestMutation(ctx.params.requestID)
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
