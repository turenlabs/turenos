import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { PermissionV2 } from "@turenlabs/core/permission"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { RosettaExecTool, isX86_64Elf } from "@turenlabs/core/tool/rosetta-exec"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

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

describe("RosettaExecTool", () => {
  it.effect("recognizes only little-endian x86-64 ELF", () =>
    Effect.sync(() => {
      expect(
        isX86_64Elf(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x3e, 0])),
      ).toBe(true)
      expect(
        isX86_64Elf(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x3e, 0])),
      ).toBe(false)
    }),
  )

  it.live("executes the admitted ELF through the first-party harness", () => {
    const executable = process.env.TUREN_ROSETTA_TEST_ELF
    if (!executable) return Effect.logWarning("TUREN_ROSETTA_TEST_ELF is not configured")
    const directory = executable.slice(0, executable.lastIndexOf("/"))
    const file = executable.slice(executable.lastIndexOf("/") + 1)
    return Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["rosetta_exec"])
      const result = yield* executeTool(registry, {
        sessionID: SessionV2.ID.make("ses_rosetta_exec_test"),
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-rosetta-exec",
          name: "rosetta_exec",
          input: { path: file, timeout: 30_000 },
        },
      })
      expect(result.type).toBe("text")
      if (result.type === "text") expect(result.value).toContain("hello from x86_64 through Rosetta")
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, RosettaExecTool.node]),
          [
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
              ),
            ],
            [PermissionV2.node, permission],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        ),
      ),
    )
  })
})
