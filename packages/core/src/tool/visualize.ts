export * as VisualizeTool from "./visualize"

import { ToolFailure } from "@turenlabs/llm"
import { Visualization } from "@turenlabs/schema/visualization"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "visualize"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Show an interactive visualization inline in the app. Supply version:1, title, kind (bar, line, or treemap), and 1-500 items with label and nonnegative value. Optional group enables filtering; detail adds item notes; unit labels values. Line charts use input order as the horizontal axis. Treemap area represents value. Data must fit 128 KiB. Use measured data from other tools; never invent measurements. No HTML, JavaScript, URLs, files, or network access. The user can filter, inspect items, and view a table without another model call.",
          input: Visualization.Spec,
          output: Visualization.Spec,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Displayed ${output.kind} visualization: ${output.title} (${output.items.length} items).`,
            },
          ],
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              .pipe(
                Effect.map(() => input),
                Effect.mapError(() => new ToolFailure({ message: "Visualization permission denied" })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/visualize",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
