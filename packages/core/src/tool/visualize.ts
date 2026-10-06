export * as VisualizeTool from "./visualize"

import { ToolFailure } from "@turenlabs/llm"
import { Visualization } from "@turenlabs/schema/visualization"
import { SafeHtml } from "@turenlabs/schema/safehtml"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { VisualizationGuidance } from "./visualization-guidance"

export const name = "visualize"
export const Spec = Schema.Union([SafeHtml.Spec, Visualization.Spec])

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: [
            VisualizationGuidance.TOOL,
            "Display a finished visualization inline in chat. Supply version:1, title, and either html or chart data. HTML takes precedence when present.",
            "For custom diagrams, tables, and visual explanations, supply self-contained HTML with inline CSS and SVG. Keep the encoded payload within 512 KiB.",
            "HTML is sanitized in a no-script sandbox. No JavaScript, event handlers, links, embeds, forms, external resources, files, app bridge, or navigation. Use native details/summary and checkbox or radio controls with CSS. Escape untrusted text in markup.",
            "For interactive data charts, supply kind (bar, line, or treemap) and 1-500 items with label and nonnegative value. Optional group enables filtering; detail adds notes; unit labels values. Line charts use input order. Treemap area represents value. Chart data must fit 128 KiB. The user can filter, inspect items, and view a table locally.",
            "Collect measured data with other tools first. Label illustrative data and preserve units, source notes, and uncertainty. Use animate for bounded numeric or color timelines, not JavaScript. Do not claim interaction tests you did not run.",
          ].join(" "),
          input: Spec,
          output: Spec,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text:
                "html" in output
                  ? `Displayed HTML visualization in chat: ${output.title}.`
                  : `Displayed ${output.kind} visualization: ${output.title} (${output.items.length} items).`,
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
