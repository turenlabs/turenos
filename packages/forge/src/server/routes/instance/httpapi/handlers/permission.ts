import { PermissionV1 } from "@turenlabs/core/v1/permission"
import { Permission } from "@/permission"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, PermissionNotFoundError } from "../errors"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const tasks = yield* SessionTaskV2.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      const request = (yield* svc.list()).find((item) => item.id === ctx.params.requestID)
      if (request)
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
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
