export * as GlobTool from "./glob"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { NonNegativeInt, RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

/**
 * Line counts ship with the listing because "which files exist" and "how big are
 * they" are one orientation question; without them models pair a glob with a
 * `wc -l $(find ...)` shell probe and spend a whole extra provider round trip.
 */
export const Entry = Schema.Struct({
  ...FileSystem.Entry.fields,
  lines: NonNegativeInt.pipe(Schema.optional),
}).annotate({ identifier: "GlobTool.Entry" })

export const Output = Schema.Array(Entry)
type ModelOutput = typeof Output.Encoded

// Counting reads file contents, so a repo-wide glob keeps listing only.
const LINE_COUNT_LIMIT = 1_000

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines =
    output.length === 0
      ? ["No files found"]
      : output.map((item) => (item.lines === undefined ? item.path : `${item.path} (${item.lines} lines)`))
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find files by glob pattern within the active Location. Returns concise relative file resources, each with its line count when the result set is small enough to measure. Use a relative path to narrow the search and limit to bound the result count. Do not follow this with a shell command to count lines or list the same files again.",
          input: Input,
          output: Output,
          // Location-relative on purpose: re-absolutizing prefixed every entry with the
          // workspace root, kilobytes of repeated prefix on large result sets. Relative
          // paths resolve fine in every follow-up tool.
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: input.path ?? ".",
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const cwd = path.resolve(location.directory, input.path ?? ".")
              const files = yield* ripgrep.glob({
                cwd,
                pattern: input.pattern,
                limit: input.limit ?? Number.MAX_SAFE_INTEGER,
              })
              // Counts are an affordance, not the answer. A failed count degrades to a
              // plain listing instead of failing a search that already succeeded.
              const counts =
                files.length > LINE_COUNT_LIMIT
                  ? undefined
                  : yield* ripgrep
                      .lines({ cwd, files: files.map((entry) => entry.path) })
                      .pipe(Effect.orElseSucceed(() => undefined))
              return files.map((entry) =>
                Entry.make({
                  ...entry,
                  path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                  lines: counts?.get(entry.path),
                }),
              )
            }).pipe(
              Effect.mapError(() => new ToolFailure({ message: `Unable to find files matching ${input.pattern}` })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, Ripgrep.node, Location.node, PermissionV2.node],
})
