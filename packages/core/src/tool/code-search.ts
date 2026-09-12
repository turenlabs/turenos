export * as CodeSearchTool from "./code-search"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { RelativePath } from "../schema"
import { CodeSearch } from "../search"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "code_search"

export const Input = Schema.Struct({
  queries: Schema.NonEmptyArray(Schema.NonEmptyString).annotate({
    description:
      "One to four phrasings of what you're looking for. Pass variants when the answer's vocabulary might differ from yours — e.g. ['verify artifact integrity', 'sha256 checksum mismatch']. Each query is scored independently and results merge by best rank.",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to scope the search. Defaults to the whole active Location.",
  }),
  limit: Schema.Number.pipe(Schema.optional).annotate({
    description: "Maximum results to return (default 20, max 40)",
  }),
})

export const Output = Schema.Array(CodeSearch.Hit)
type ModelOutput = typeof Output.Encoded

const toModelOutput = (output: ModelOutput) => {
  if (output.length === 0) return "No results found"
  const lines = [`Found ${output.length} results`]
  for (const hit of output) {
    const head = `${hit.path}:${hit.line}`
    const label = [hit.name, hit.kind].filter(Boolean).join(" ")
    lines.push(`${head}${label ? `  ${label}` : ""}${hit.snippet ? `  — ${hit.snippet}` : ""}`)
  }
  return lines.join("\n")
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const search = yield* CodeSearch.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Ranked semantic-and-structural search over the codebase: function/type declarations, file paths, and content are indexed per Location. Prefer this over grep when looking for where something is implemented, how a concept is expressed, or what calls a symbol ('callers of X'). Pass 1-4 query phrasings — the caller's rephrasing is the main lever on result quality. Returns ranked file:line anchors; follow up with read or grep on the hits.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [...input.queries],
                save: ["*"],
                metadata: { root: ".", path: input.path, limit: input.limit },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              return yield* search.search({ queries: input.queries, path: input.path, limit: input.limit })
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to search for ${input.queries[0]}` }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/code-search",
  layer,
  deps: [ToolRegistry.node, Location.node, PermissionV2.node, CodeSearch.node],
})
