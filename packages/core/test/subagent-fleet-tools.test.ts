import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { ConfigSubagent } from "@turenlabs/core/config/subagent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { ProjectV2 } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecutionControl } from "@turenlabs/core/session/execution-control"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SwarmRoom } from "@turenlabs/core/team/room"
import { SubagentTool } from "@turenlabs/core/tool/subagent"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { testEffect } from "./lib/effect"
import { expectInvariants, finish, model } from "./lib/fleet"

// The fleet driven through the materialized subagent tools, as a model would
// call them. Permission is stubbed so a test can deny single actions, and config
// so the concurrency limit comes from the test rather than the machine.
const directory = AbsolutePath.make(process.cwd())
const allowAll: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
const denied = new Set<string>()
let maxConcurrent = 2

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AgentV2.node,
      Database.node,
      EventV2.node,
      SessionCreation.node,
      SessionStore.node,
      SessionTaskV2.node,
      SwarmRoom.node,
      ToolRegistry.node,
      SubagentTool.node,
    ]),
    [
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.sync(() => [
                new Config.Document({
                  type: "document",
                  info: new Config.Info({ subagents: new ConfigSubagent.Info({ max_concurrent: maxConcurrent }) }),
                }),
              ]),
          }),
        ),
      ],
      [Location.node, Location.boundNode({ directory })],
      [
        PermissionV2.node,
        Layer.mock(PermissionV2.Service, {
          assert: (input: PermissionV2.AssertInput) =>
            denied.has(input.action) ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        }),
      ],
      [
        ProjectV2.node,
        Layer.mock(ProjectV2.Service, {
          resolve: (input: AbsolutePath) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
        }),
      ],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.fnUntraced(function* (suffix: string, limit: number) {
  denied.clear()
  maxConcurrent = limit
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) => {
    editor.update(AgentV2.ID.make("build"), (agent) => {
      agent.mode = "primary"
      agent.permissions = [...allowAll]
    })
    editor.update(AgentV2.ID.make("explore"), (agent) => {
      agent.mode = "subagent"
      agent.hidden = false
      agent.permissions = [...allowAll]
    })
  })
  const creation = yield* SessionCreation.Service
  return yield* creation.create({
    id: SessionSchema.ID.make(`ses_fleet_tools_${suffix}`),
    agent: AgentV2.ID.make("build"),
    model,
    location: { directory },
  })
})

/** Materializes the tools a Session's next provider turn would see. */
const toolsFor = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const registry = yield* ToolRegistry.Service
  const subagents = yield* SubagentTool.Service
  const session = yield* subagents.forExecution({ sessionID, control: SessionExecutionControl.noop, model })
  return yield* registry.materialize({ permissions: allowAll, session })
})

/** Records one assistant tool call in `sessionID` and settles it through the materialized tool. */
const call = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  suffix: string,
  name: string,
  value: unknown,
  agent = AgentV2.ID.make("build"),
) {
  const events = yield* EventV2.Service
  const assistantMessageID = SessionMessage.ID.make(`msg_fleet_tools_${suffix}`)
  const callID = `call_fleet_tools_${suffix}`
  const timestamp = yield* DateTime.now
  yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp, agent, model })
  yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, callID, timestamp, name })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID,
    assistantMessageID,
    callID,
    timestamp,
    tool: name,
    input: {},
    provider: { executed: false },
  })
  const tools = yield* toolsFor(sessionID)
  return (yield* tools.settle({
    sessionID,
    agent,
    assistantMessageID,
    call: { type: "tool-call", id: callID, name, input: value },
  })).result
})

const item = (description: string, extra: Record<string, unknown> = {}) => ({
  agent: "explore",
  description,
  prompt: `Handle ${description}.`,
  ...extra,
})

describe("subagent fleet tools", () => {
  it.effect("runs a wave larger than the concurrency limit through spawn, interrupt, and wait", () =>
    Effect.gen(function* () {
      const root = yield* setup("wave", 2)
      const tasks = yield* SessionTaskV2.Service
      const store = yield* SessionStore.Service
      expect(
        yield* call(root.id, "wave_spawn", SubagentTool.spawnBatchName, {
          wave: "slice",
          items: ["one", "two", "three", "four", "five"].map((name) => item(name)),
        }),
      ).toMatchObject({ type: "json", value: { counts: { queued: 3, running: 2, failed: 0 } } })

      // One member finishes and promotion starts the next, as the driver would.
      const wave = yield* tasks.list({ parentSessionID: root.id, wave: "slice" })
      yield* finish(wave[0])
      yield* tasks.promote(root.id, 2)
      expect((yield* tasks.list({ parentSessionID: root.id, wave: "slice" })).map((task) => task.status)).toEqual([
        "completed",
        "running",
        "running",
        "queued",
        "queued",
      ])

      expect(yield* call(root.id, "wave_interrupt", SubagentTool.interruptName, { wave: "slice" })).toMatchObject({
        type: "json",
        value: { interrupted: 4, remaining: 0 },
      })
      expect(yield* call(root.id, "wave_wait", SubagentTool.waitName, { wave: "slice" })).toMatchObject({
        type: "json",
        value: { timed_out: false, parked: false, counts: { queued: 0, running: 0, terminal: 5 }, truncated: false },
      })
      // Queued members were cancelled without ever starting a child Session.
      expect(yield* store.get(wave[3].childSessionID)).toBeUndefined()
      expect(yield* store.get(wave[4].childSessionID)).toBeUndefined()
    }),
  )

  it.effect("gates orchestrate on its own permission and offers spawn tools only to orchestrators", () =>
    Effect.gen(function* () {
      const root = yield* setup("orchestrate_gate", 4)
      const tasks = yield* SessionTaskV2.Service
      denied.add("orchestrate")
      expect(
        yield* call(root.id, "gate_denied", SubagentTool.spawnName, item("denied", { orchestrate: true })),
      ).toMatchObject({ type: "error" })
      expect(yield* tasks.list({ parentSessionID: root.id })).toEqual([])

      denied.clear()
      expect(
        yield* call(root.id, "gate_allowed", SubagentTool.spawnName, item("allowed", { orchestrate: true })),
      ).toMatchObject({ type: "json" })
      const orchestrator = (yield* tasks.list({ parentSessionID: root.id }))[0]
      expect(orchestrator.authority.orchestrate).toBe(true)
      const names = (yield* toolsFor(orchestrator.childSessionID)).definitions.map((definition) => definition.name)
      expect(names).toEqual(expect.arrayContaining([SubagentTool.spawnName, SubagentTool.spawnBatchName]))

      expect(
        yield* call(
          orchestrator.childSessionID,
          "gate_worker",
          SubagentTool.spawnName,
          item("worker"),
          AgentV2.ID.make("explore"),
        ),
      ).toMatchObject({ type: "json" })
      const worker = (yield* tasks.list({ parentSessionID: orchestrator.childSessionID }))[0]
      const workerNames = (yield* toolsFor(worker.childSessionID)).definitions.map((definition) => definition.name)
      expect(workerNames).not.toContain(SubagentTool.spawnName)
      expect(workerNames).not.toContain(SubagentTool.spawnBatchName)
    }),
  )

  // Regression for the PR #93 quota bypass, reproduced through the tools a
  // model calls.
  it.effect("holds an orchestrator resumed through send_agent to the orchestrator quota", () =>
    Effect.gen(function* () {
      const root = yield* setup("resume_quota", 2)
      const tasks = yield* SessionTaskV2.Service
      yield* call(root.id, "resume_a", SubagentTool.spawnName, item("slice a", { orchestrate: true }))
      const first = (yield* tasks.list({ parentSessionID: root.id }))[0]
      yield* finish(first)
      yield* call(root.id, "resume_b", SubagentTool.spawnName, item("slice b", { orchestrate: true }))
      yield* call(root.id, "resume_c", SubagentTool.spawnName, item("slice c", { orchestrate: true }))
      const [, second, third] = yield* tasks.list({ parentSessionID: root.id })
      expect([second.status, third.status]).toEqual(["running", "queued"])

      const resumed = yield* call(root.id, "resume_send", SubagentTool.sendName, {
        task_id: first.id,
        prompt: "Take the next slice.",
      })
      yield* expectInvariants(root.id, 2)
      expect(resumed).toMatchObject({ type: "error" })

      yield* call(second.childSessionID, "resume_w", SubagentTool.spawnName, item("worker"), AgentV2.ID.make("explore"))
      const worker = (yield* tasks.list({ parentSessionID: second.childSessionID }))[0]
      expect(worker.status).toBe("queued")
      expect(yield* tasks.promote(root.id, 2)).toEqual([worker.childSessionID])
    }),
  )
})
