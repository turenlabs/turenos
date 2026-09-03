import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { HandoffTool } from "@turenlabs/core/tool/handoff"
import { Tool } from "@turenlabs/core/tool/tool"
import { ToolOutput } from "@turenlabs/llm"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make(process.cwd())
const project = AbsolutePath.make(path.dirname(directory))
const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("model"),
})
const parentID = SessionSchema.ID.make("ses_handoff_parent")
const assertions: PermissionV2.AssertInput[] = []
const wakes: string[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const projects = Layer.succeed(ProjectV2.Service, {
  resolve: (input: AbsolutePath) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
  directories: () => Effect.succeed([]),
  remember: () => Effect.void,
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      FSUtil.node,
      ProjectV2.node,
      LocationMutation.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCreation.node,
      SessionTaskV2.node,
      HandoffTool.node,
    ]),
    [
      [Location.node, Location.boundNode({ directory })],
      [PermissionV2.node, permission],
      [ProjectV2.node, projects],
    ],
  ),
)

const call = (id: string, input: { readonly title: string; readonly prompt: string; readonly project?: string }) => ({
  type: "tool-call" as const,
  id,
  name: HandoffTool.name,
  input,
})

const context = (toolCallID: string) => ({
  sessionID: parentID,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make(`msg_${toolCallID}`),
  toolCallID,
})

const control = {
  active: Effect.succeed(new Set<SessionSchema.ID>()),
  wake: (sessionID: SessionSchema.ID) => Effect.sync(() => wakes.push(sessionID)),
  interrupt: () => Effect.void,
}

describe("HandoffTool", () => {
  it.effect(
    "does not advertise the tool to task-owned sessions",
    Effect.gen(function* () {
      const handoff = yield* HandoffTool.Service
      expect(yield* handoff.forExecution({ control, model, taskOwned: true })).toEqual({})
    }),
  )

  it.effect(
    "creates and wakes a root session with a durable continuation prompt",
    Effect.gen(function* () {
      assertions.length = 0
      wakes.length = 0
      const handoff = yield* HandoffTool.Service
      const tools = yield* handoff.forExecution({ control, model, taskOwned: false })
      const output = yield* Tool.settle(
        tools[HandoffTool.name]!,
        call("call_handoff", {
          title: "Finish the parser",
          prompt: "Continue from the parser refactor. Run the tests and fix the remaining issue.",
        }),
        context("call_handoff"),
      )
      const value = ToolOutput.toResultValue(output)
      if (value.type !== "json") throw new Error("Expected structured handoff output")
      const payload = value.value as { session_id: string; message_id: string }
      const sessionID = SessionSchema.ID.make(payload.session_id)
      const messageID = SessionMessage.ID.make(payload.message_id)
      const store = yield* SessionStore.Service
      const session = yield* store.get(sessionID)
      const input = yield* Database.Service.use(({ db }) => SessionInput.find(db, messageID))

      expect(session).toMatchObject({
        id: sessionID,
        parentID: undefined,
        title: "Finish the parser",
        location: { directory },
        agent: "build",
        model,
      })
      expect(input).toMatchObject({
        id: messageID,
        sessionID,
        delivery: "steer",
        prompt: { text: "Continue from the parser refactor. Run the tests and fix the remaining issue." },
        agent: "build",
        model,
      })
      expect(wakes).toEqual([sessionID])
      expect(assertions.map((item) => item.action)).toEqual([HandoffTool.name])
    }),
  )

  it.effect(
    "retries the same tool call without creating another root session",
    Effect.gen(function* () {
      wakes.length = 0
      const handoff = yield* HandoffTool.Service
      const tool = (yield* handoff.forExecution({ control, model, taskOwned: false }))[HandoffTool.name]!
      const input = { title: "Retry handoff", prompt: "Keep working." }
      const first = yield* Tool.settle(tool, call("call_handoff_retry", input), context("call_handoff_retry"))
      const second = yield* Tool.settle(tool, call("call_handoff_retry", input), context("call_handoff_retry"))

      expect(ToolOutput.toResultValue(second)).toEqual(ToolOutput.toResultValue(first))
      expect(wakes).toHaveLength(2)
      expect(wakes[0]).toBe(wakes[1])
      expect(wakes[0]).toContain("ses_handoff_")
      expect(wakes[0]!.length).toBeLessThanOrEqual(100)

      const conflict = yield* Tool.settle(
        tool,
        call("call_handoff_retry", { title: "Different handoff", prompt: input.prompt }),
        context("call_handoff_retry"),
      ).pipe(Effect.exit)
      expect(conflict._tag).toBe("Failure")
    }),
  )

  it.effect(
    "creates a root session in an explicitly supplied project directory",
    Effect.gen(function* () {
      assertions.length = 0
      wakes.length = 0
      const handoff = yield* HandoffTool.Service
      const tools = yield* handoff.forExecution({ control, model, taskOwned: false })
      const output = yield* Tool.settle(
        tools[HandoffTool.name]!,
        call("call_handoff_project", {
          title: "Continue in the custom project",
          prompt: "Continue this work from the custom project.",
          project,
        }),
        context("call_handoff_project"),
      )
      const value = ToolOutput.toResultValue(output)
      if (value.type !== "json") throw new Error("Expected structured handoff output")
      const payload = value.value as { session_id: string; directory: string }
      const sessionID = SessionSchema.ID.make(payload.session_id)
      const store = yield* SessionStore.Service
      const session = yield* store.get(sessionID)

      expect(payload.directory).toBe(project)
      expect(session).toMatchObject({
        id: sessionID,
        parentID: undefined,
        location: { directory: project, workspaceID: undefined },
        title: "Continue in the custom project",
        agent: "build",
        model,
      })
      expect(assertions.map((item) => item.action)).toEqual(["external_directory", HandoffTool.name])
      expect(assertions[1]).toMatchObject({ action: HandoffTool.name, resources: [project] })
      expect(wakes).toEqual([sessionID])
    }),
  )
})
