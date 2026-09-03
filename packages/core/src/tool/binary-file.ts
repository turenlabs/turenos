import { ToolFailure } from "@turenlabs/llm"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import type { Tool } from "./tool"

export const MAX_ANALYSIS_BYTES = 32 * 1024 * 1024

export const read = Effect.fn("BinaryTool.read")(function* (
  path: string,
  action: string,
  context: Tool.Context,
  mutation: LocationMutation.Interface,
  fs: FSUtil.Interface,
  permission: PermissionV2.Interface,
) {
  const source = {
    type: "tool" as const,
    messageID: context.assistantMessageID,
    callID: context.toolCallID,
  }
  const target = yield* mutation.resolve({ path, kind: "file" })
  if (target.externalDirectory)
    yield* permission.assert({
      ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
      sessionID: context.sessionID,
      agent: context.agent,
      source,
    })
  yield* permission.assert({
    action,
    resources: [target.resource],
    save: ["*"],
    sessionID: context.sessionID,
    agent: context.agent,
    source,
  })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(target.canonical, { flag: "r" })
      const info = yield* file.stat
      if (info.type !== "File") return yield* new ToolFailure({ message: `${path} is not a file` })
      if (info.size <= 0) return yield* new ToolFailure({ message: `${path} is empty` })
      if (info.size > MAX_ANALYSIS_BYTES)
        return yield* new ToolFailure({
          message: `${path} exceeds the ${MAX_ANALYSIS_BYTES / 1024 / 1024} MiB binary analysis limit`,
        })

      const bytes = yield* file.readAlloc(Number(info.size))
      if (bytes._tag === "None" || bytes.value.length !== Number(info.size))
        return yield* new ToolFailure({ message: `Unable to read all bytes from ${path}` })
      return { bytes: bytes.value, resource: target.resource }
    }),
  )
})
