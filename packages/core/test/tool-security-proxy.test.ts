import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SecurityProxyRuntime } from "@turenlabs/core/security-proxy-runtime"
import { SecurityProxyTool } from "@turenlabs/core/tool/security-proxy"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(Layer.empty)

describe("SecurityProxyTool", () => {
  it.live("registers collaborative browser tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "browser_start",
        "browser_navigate",
        "browser_status",
        "browser_intercept",
        "browser_decide",
        "browser_history",
        "browser_flow",
        "browser_replay",
        "browser_stop",
      ])
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SecurityProxyTool.node]), [
          [
            Location.node,
            Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
            ),
          ],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          [SecurityProxyRuntime.node, SecurityProxyRuntime.unavailable],
        ]),
      ),
    ),
  )
})
