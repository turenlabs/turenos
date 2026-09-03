import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AutomationTool } from "@turenlabs/core/tool/automation"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { Loop } from "@turenlabs/core/loop"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_automation_tool_test")
const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("openai"),
  id: ModelV2.ID.make("gpt-5.6-sol"),
  variant: ModelV2.VariantID.make("high"),
})
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Loop.node, ToolRegistry.node, ToolRegistry.toolsNode, AutomationTool.node]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const call = (name: string, input: unknown, id = `call-${name}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const created = (registry: ToolRegistry.Interface, overrides: Record<string, unknown> = {}) =>
  executeTool(
    registry,
    call("automation_create", {
      name: "Daily briefing",
      interval_seconds: Loop.MIN_INTERVAL_SECONDS,
      steps: [
        { name: "Gather news", task: "Collect today's headlines" },
        { name: "Summarize", task: "Summarize {{ steps.gather_news.output }}" },
      ],
      ...overrides,
    }),
  )

describe("AutomationTool", () => {
  it.effect("registers all three tools in the Location graph", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name).sort()).toEqual([
        "automation_create",
        "automation_list",
        "automation_update",
      ])
    }),
  )

  it.effect("creates a workflow Automation with derived step IDs in the session's directory", () =>
    Effect.gen(function* () {
      assertions.length = 0
      deny = false
      const registry = yield* ToolRegistry.Service
      const result = yield* created(registry)
      expect(result).toMatchObject({
        type: "json",
        value: {
          name: "Daily briefing",
          status: "active",
          interval_seconds: Loop.MIN_INTERVAL_SECONDS,
          directory: "/project",
          steps: [
            { id: "gather_news", name: "Gather news", type: "agent", task: "Collect today's headlines" },
            { id: "summarize", name: "Summarize", type: "agent", task: "Summarize {{ steps.gather_news.output }}" },
          ],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "automation_create", resources: ["Daily briefing"] }])

      const loops = yield* Loop.Service
      const stored = yield* loops.list()
      expect(stored.map((info) => info.workflow?.steps.map((step) => step.id))).toEqual([["gather_news", "summarize"]])
    }),
  )

  it.effect("creates, lists, updates, and resets inherited and step models", () =>
    Effect.gen(function* () {
      deny = false
      const registry = yield* ToolRegistry.Service
      const automation = yield* created(registry, {
        agent: "build",
        model,
        steps: [
          { name: "Inherit model", task: "Use the inherited model" },
          { name: "Override model", task: "Use a step model", model: { ...model, variant: "medium" } },
        ],
      })
      const value = (automation as { readonly value: { readonly id: string } }).value

      expect(automation).toMatchObject({
        value: {
          agent: "build",
          model,
          steps: [
            { id: "inherit_model", model: null },
            { id: "override_model", model: { ...model, variant: "medium" } },
          ],
        },
      })
      expect(yield* executeTool(registry, call("automation_list", {}))).toMatchObject({
        value: [{ id: value.id, model }],
      })

      const updated = { ...model, variant: ModelV2.VariantID.make("medium") }
      expect(
        yield* executeTool(
          registry,
          call("automation_update", { id: value.id, agent: "explore", model: updated }, "call-update-model"),
        ),
      ).toMatchObject({ value: { id: value.id, agent: "explore", model: updated } })
      expect(
        yield* executeTool(
          registry,
          call("automation_update", { id: value.id, agent: null, model: null }, "call-reset-model"),
        ),
      ).toMatchObject({ value: { id: value.id, agent: null, model: null } })
    }),
  )

  it.effect("lists, pauses, and deletes an Automation", () =>
    Effect.gen(function* () {
      deny = false
      const registry = yield* ToolRegistry.Service
      const automation = yield* created(registry, { name: "Docs drift" })
      const id = (automation as { readonly value: { readonly id: string } }).value.id

      expect(yield* executeTool(registry, call("automation_list", {}))).toMatchObject({
        value: [{ id, name: "Docs drift" }],
      })
      expect(
        yield* executeTool(registry, call("automation_update", { id, status: "paused" }, "call-pause")),
      ).toMatchObject({
        value: { id, status: "paused" },
      })
      expect(
        yield* executeTool(registry, call("automation_update", { id, status: "deleted" }, "call-delete")),
      ).toMatchObject({ value: null })
      expect(yield* (yield* Loop.Service).list()).toEqual([])
    }),
  )

  it.effect("rejects a step binding that references a later step", () =>
    Effect.gen(function* () {
      deny = false
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(
        registry,
        call("automation_create", {
          name: "Backwards",
          interval_seconds: Loop.MIN_INTERVAL_SECONDS,
          steps: [
            { name: "First", task: "Needs {{ steps.second.output }}" },
            { name: "Second", task: "Runs later" },
          ],
        }),
      )
      expect(result).toEqual({ type: "error", value: "Automation step first must reference an earlier step" })
    }),
  )

  it.effect("creates nothing when permission is denied", () =>
    Effect.gen(function* () {
      deny = true
      const registry = yield* ToolRegistry.Service
      expect(yield* created(registry, { name: "Denied" })).toEqual({
        type: "error",
        value: "Permission to run automation_create was declined",
      })
      expect(yield* (yield* Loop.Service).list()).toEqual([])
    }),
  )
})
