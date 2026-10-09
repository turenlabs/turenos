export * as AnimateTool from "./animate"

import { ToolFailure } from "@turenlabs/llm"
import { Animation } from "@turenlabs/schema/animation"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { VisualizationGuidance } from "./visualization-guidance"

export const name = "animate"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: [
            VisualizationGuidance.TOOL,
            "Display a bounded animation inline in chat. Supply version:1, title, optional description, self-contained html, and 1-128 tracks. Keep encoded JSON within 512 KiB.",
            "Each track targets a literal element ID, not a selector. Supply property, 2-32 keyframes, duration in milliseconds (100-60000), and optional at in milliseconds (default zero). Every track must finish within 60000 milliseconds.",
            "Numeric properties: x, y, translateX, translateY, rotate, scale, opacity, cx, cy, r, width, height, strokeDashoffset, textContent. Values must be finite with absolute value at most 1000000. Opacity is 0-1; scale is 0-100; r, width, and height are 0-10000. Fill and stroke accept only #RGB or #RRGGBB color keyframes.",
            "The trusted renderer uses linear timing and starts paused. Use duration and at to represent scientific timing faithfully. Preserve measured values and units; label illustrative motion. No autoplay, loops, callbacks, selectors, URLs, arbitrary properties, or agent JavaScript.",
            "HTML is sanitized. No event handlers, external resources, app bridge, files, navigation, or downloads. Use visualize for static HTML or bar, line, and treemap charts.",
          ].join(" "),
          input: Animation.Spec,
          output: Animation.Spec,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `Displayed animation in chat: ${output.title} (${output.tracks.length} tracks; paused).`,
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
                Effect.mapError(() => new ToolFailure({ message: "Animation permission denied" })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/animate",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
