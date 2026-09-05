import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AbsolutePath } from "@turenlabs/core/schema"
import { Reflection } from "@turenlabs/core/reflection"
import { Project } from "@turenlabs/core/project"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionV2 } from "@turenlabs/core/session"
import { ReflectionTool } from "@turenlabs/core/tool/reflection"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_reflection_tool")
const session = SessionV2.Info.make({
  id: sessionID,
  projectID: Project.ID.make("reflection-tool"),
  title: "Reflection tool",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  location: { directory: AbsolutePath.make("/tmp/forge-reflection-tool") },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
})
const store = Layer.mock(SessionStore.Service, {
  get: () => Effect.succeed(session),
  context: () => Effect.die("unused"),
  runnerContext: () => Effect.die("unused"),
  message: () => Effect.die("unused"),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Reflection.node, ToolRegistry.node, ToolRegistry.toolsNode, ReflectionTool.node]),
    [
      [SessionStore.node, store],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)
const call = (name: string, input: unknown, id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

describe("ReflectionTool", () => {
  it.effect("registers durable work-state tools and completes a due checkpoint", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name).toSorted()).toEqual([
        "reflection_complete",
        "reflection_read",
        "reflection_state",
      ])
      const definitions = yield* toolDefinitions(registry)
      expect(definitions.find((tool) => tool.name === "reflection_state")?.inputSchema).toMatchObject({
        properties: {
          hypotheses: {
            type: "array",
            maxItems: 24,
            items: {
              type: "object",
              required: ["claim", "status"],
              properties: {
                claim: { type: "string", minLength: 1, maxLength: 2000 },
                status: { enum: ["open", "supported", "rejected", "inconclusive"] },
              },
            },
          },
        },
      })

      expect(
        yield* executeTool(
          registry,
          call(
            "reflection_state",
            {
              prediction: "Check the contract",
              hypotheses: [{ text: "Wrong property", status: "open" }],
              next_action: "Read the contract",
            },
            "call-reflection-invalid",
          ),
        ),
      ).toMatchObject({ type: "error", value: expect.stringContaining("claim") })

      expect(
        yield* executeTool(
          registry,
          call(
            "reflection_state",
            {
              prediction: "The probe will identify one caller",
              hypotheses: [{ claim: "The symbol has one caller", status: "open" }],
              next_action: "Run the probe",
            },
            "call-reflection-state",
          ),
        ),
      ).toMatchObject({ type: "json", value: { prediction: "The probe will identify one caller" } })
      expect(yield* executeTool(registry, call("reflection_read", {}, "call-reflection-read"))).toMatchObject({
        type: "json",
        value: { nextAction: "Run the probe" },
      })

      const reflection = yield* Reflection.Service
      yield* reflection.recordCompletion({ session, interval: 1 })
      yield* reflection.prompt({ session, interval: 1 })
      expect(
        yield* executeTool(
          registry,
          call(
            "reflection_complete",
            {
              critique: "The estimate was correct.",
              lessons: [
                { lesson: "Keep the probe focused.", evidence: "The isolated run produced the expected result." },
              ],
              memories: [],
            },
            "call-reflection-complete",
          ),
        ),
      ).toEqual({ type: "json", value: { completed: true } })
    }),
  )
})
