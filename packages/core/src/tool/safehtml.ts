export * as SafeHtmlTool from "./safehtml"

import { ToolFailure } from "@turenlabs/llm"
import { SafeHtml } from "@turenlabs/schema/safehtml"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { VisualizationGuidance } from "./visualization-guidance"

export const name = "safehtml"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: [
            VisualizationGuidance.TOOL,
            "Display rich safe HTML directly inside the chat. No separate window, download, or setup is needed.",
            "Supply version:1, title, optional description, and html: self-contained HTML with inline CSS and SVG.",
            "Use this for custom dashboards, diagrams, charts, tables, and visual explanations. Use visualize for data-only charts with scripted filtering.",
            "Design for the user's question: give the view a clear title, units, labels, source notes, useful controls, and an empty state.",
            "Use responsive layouts, readable contrast, keyboard controls, and restrained motion. Build charts with inline SVG and style them with CSS.",
            "Collect real data with other tools first. Label illustrative data. Escape untrusted text before placing it in markup.",
            "HTML is sanitized and displayed in a no-script sandbox. JavaScript, event handlers, links, embeds, forms, and external resources do not work.",
            "For interaction use native details/summary, checkboxes, radio controls, and CSS selectors. Do not create buttons that need JavaScript.",
            "Keep styles self-contained. No network, CDN libraries, files, app bridge, popups, navigation, workers, eval, or downloads.",
            "Keep the total encoded payload under 512 KiB. Return a finished artifact, not setup instructions. Do not claim interaction tests you did not run.",
          ].join(" "),
          input: SafeHtml.Spec,
          output: SafeHtml.Spec,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Displayed Safe HTML in chat: ${output.title}.`,
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
                Effect.mapError(() => new ToolFailure({ message: "Safe HTML permission denied" })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/safehtml",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
