import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { AgentImprovement } from "@turenlabs/core/agent/improvement"
import { Config } from "@turenlabs/core/config"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { FileMutation } from "@turenlabs/core/file-mutation"
import { Location } from "@turenlabs/core/location"
import { LocationMutation } from "@turenlabs/core/location-mutation"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionExecutionControl } from "@turenlabs/core/session/execution-control"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { AgentImprovementTool } from "@turenlabs/core/tool/agent-improvement"
import { ApplyPatchTool } from "@turenlabs/core/tool/apply-patch"
import { EditTool } from "@turenlabs/core/tool/edit"
import { SubagentTool } from "@turenlabs/core/tool/subagent"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { WriteTool } from "@turenlabs/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("model"),
})
const assertions: PermissionV2.AssertInput[] = []

// Recording-but-permissive permission stub: agent_doc must assert the read
// before serving the definition, and this suite records those assertions
// without denying anything. The write-surface test below swaps in the real
// service so write-root denials are evaluated for real.
const recordingPermission = Layer.mock(PermissionV2.Service, {
  assert: (input: PermissionV2.AssertInput) =>
    Effect.sync(() => {
      assertions.push(input)
    }),
})

const harness = (
  directory: AbsolutePath,
  permission: Layer.Layer<PermissionV2.Service> | LayerNode.Node<PermissionV2.Service, never, LayerNode.Tag>,
) =>
  AppNodeBuilder.build(
    LayerNode.group([
      AgentV2.node,
      AgentImprovement.node,
      Database.node,
      EventV2.node,
      SessionCreation.node,
      SessionTaskV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SubagentTool.node,
      PermissionV2.node,
      LocationMutation.node,
      FileMutation.node,
      WriteTool.node,
      EditTool.node,
      ApplyPatchTool.node,
    ]),
    [
      [Location.node, Layer.succeed(Location.Service, location({ directory }))],
      [PermissionV2.node, permission],
      [
        PermissionSaved.node,
        Layer.mock(PermissionSaved.Service, {
          add: () => Effect.void,
          list: () => Effect.succeed([]),
          remove: () => Effect.void,
        }),
      ],
      [
        PermissionChecks.node,
        Layer.mock(PermissionChecks.Service, {
          enforced: () => Effect.succeed(false),
          set: () => Effect.void,
          untilDisabled: () => Effect.never,
        }),
      ],
      [
        ProjectV2.node,
        Layer.mock(ProjectV2.Service, {
          resolve: (input: AbsolutePath) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
        }),
      ],
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () => Effect.sync(() => []),
          }),
        ),
      ],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )

const scaffold = <A, E, R>(
  directory: AbsolutePath,
  permission: Layer.Layer<PermissionV2.Service> | LayerNode.Node<PermissionV2.Service, never, LayerNode.Tag>,
  body: (sessionID: SessionSchema.ID) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    assertions.length = 0
    yield* (yield* AgentV2.Service).transform((editor) => {
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.mode = "primary"
        agent.description = "Build harness agent"
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      })
      editor.update(AgentV2.ID.make("explore"), (agent) => {
        agent.mode = "subagent"
        agent.hidden = false
        agent.description = "Explores and improves its own definition"
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      })
    })
    const session = yield* (yield* SessionCreation.Service).create({
      id: SessionSchema.ID.make("ses_self_improve"),
      agent: AgentV2.ID.make("build"),
      model,
      location: { directory },
    })
    return yield* body(session.id)
  }).pipe(Effect.provide(harness(directory, permission)))

const withWorkspace = <A, E, R>(
  permission: Layer.Layer<PermissionV2.Service> | LayerNode.Node<PermissionV2.Service, never, LayerNode.Tag>,
  body: (directory: AbsolutePath) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(AbsolutePath.make(tmp.path)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const assistant = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  suffix: string,
  name: string,
  callID = "call-doc",
) {
  const id = SessionMessage.ID.make(`msg_self_improve_${suffix}`)
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID: id,
    timestamp: yield* DateTime.now,
    agent: AgentV2.ID.make("build"),
    model,
  })
  yield* events.publish(SessionEvent.Tool.Input.Started, {
    sessionID,
    assistantMessageID: id,
    timestamp: yield* DateTime.now,
    callID,
    name,
  })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID,
    assistantMessageID: id,
    timestamp: yield* DateTime.now,
    callID,
    tool: name,
    input: {},
    provider: { executed: false },
  })
  return id
})

const materialize = (
  sessionID: SessionSchema.ID,
  control: SessionExecutionControl.Interface = SessionExecutionControl.noop,
) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const subagents = yield* SubagentTool.Service
    const session = yield* subagents.forExecution({ sessionID, control, model })
    return yield* registry.materialize({ permissions: [{ action: "*", resource: "*", effect: "allow" }], session })
  })

const settle = (
  tools: ToolRegistry.Materialization,
  sessionID: SessionSchema.ID,
  assistantMessageID: SessionMessage.ID,
  agent: AgentV2.ID,
  id: string,
  name: string,
  value: unknown,
) =>
  tools.settle({
    sessionID,
    agent,
    assistantMessageID,
    call: { type: "tool-call", id, name, input: value },
  })

const read = async (target: string | undefined): Promise<string | undefined> => {
  if (!target) return undefined
  return fs.readFile(target, "utf8").catch(() => undefined)
}

const proposedID = (result: ToolRegistry.Settlement["result"]) =>
  (result as { value: { proposal: { proposal_id: string } } }).value.proposal.proposal_id as AgentImprovement.ID

describe("SubagentTool self-improvement surface", () => {
  it.effect("agent_doc returns the caller's own definition and asserts the read permission", () =>
    withWorkspace(recordingPermission, (directory) =>
      scaffold(directory, recordingPermission, (sessionID) =>
        Effect.gen(function* () {
          const tools = yield* materialize(sessionID)
          const messageID = yield* assistant(sessionID, "own", SubagentTool.agentDocName)
          const result = yield* settle(
            tools,
            sessionID,
            messageID,
            AgentV2.ID.make("build"),
            "call-doc",
            SubagentTool.agentDocName,
            {},
          )

          expect(result.result).toEqual({
            type: "json",
            value: {
              agent: "build",
              description: "Build harness agent",
              mode: "primary",
              message: "Agent build is defined in code/config.",
            },
          })
          expect(assertions.map((item) => item.action)).toEqual([SubagentTool.agentDocName])
          expect(assertions[0]?.resources).toEqual(["build"])
        }),
      ),
    ),
  )

  it.effect("agent_doc reads the workspace definition file for a named agent", () =>
    withWorkspace(recordingPermission, (directory) =>
      Effect.gen(function* () {
        const definition = "## Explore\n\nPropose evidence-grounded improvements.\n"
        yield* Effect.promise(() =>
          fs
            .mkdir(path.join(directory, ".forge", "agent"), { recursive: true })
            .then(() => fs.writeFile(path.join(directory, ".forge", "agent", "explore.md"), definition)),
        )
        return yield* scaffold(directory, recordingPermission, (sessionID) =>
          Effect.gen(function* () {
            const tools = yield* materialize(sessionID)
            const messageID = yield* assistant(sessionID, "file", SubagentTool.agentDocName)
            const result = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-doc",
              SubagentTool.agentDocName,
              { agent: "explore" },
            )

            expect(result.result).toEqual({
              type: "json",
              value: {
                agent: "explore",
                description: "Explores and improves its own definition",
                mode: "subagent",
                message: definition,
              },
            })
            expect(assertions.map((item) => item.action)).toEqual([SubagentTool.agentDocName])
            expect(assertions[0]?.resources).toEqual(["explore"])
          }),
        )
      }),
    ),
  )

  it.effect("agent_doc reports code/config definitions and rejects unknown agents", () =>
    withWorkspace(recordingPermission, (directory) =>
      scaffold(directory, recordingPermission, (sessionID) =>
        Effect.gen(function* () {
          const tools = yield* materialize(sessionID)
          const messageID = yield* assistant(sessionID, "missing", SubagentTool.agentDocName)

          const codeDefined = yield* settle(
            tools,
            sessionID,
            messageID,
            AgentV2.ID.make("build"),
            "call-doc",
            SubagentTool.agentDocName,
            { agent: "explore" },
          )
          expect(codeDefined.result).toEqual({
            type: "json",
            value: {
              agent: "explore",
              description: "Explores and improves its own definition",
              mode: "subagent",
              message: "Agent explore is defined in code/config.",
            },
          })

          const unknown = yield* settle(
            tools,
            sessionID,
            messageID,
            AgentV2.ID.make("build"),
            "call-unknown",
            SubagentTool.agentDocName,
            { agent: "does-not-exist" },
          )
          expect(unknown.result).toMatchObject({ type: "error", value: "Agent is unavailable: does-not-exist" })
        }),
      ),
    ),
  )

  it.effect(
    "a spawned child can read and rewrite its own definition inside its write root and is denied outside it",
    () =>
      withWorkspace(PermissionV2.node, (directory) =>
        Effect.gen(function* () {
          const baseline = "## Explore\n\nBaseline behavior\n"
          yield* Effect.promise(() =>
            fs
              .mkdir(path.join(directory, ".forge", "agent"), { recursive: true })
              .then(() => fs.writeFile(path.join(directory, ".forge", "agent", "explore.md"), baseline)),
          )
          return yield* scaffold(directory, PermissionV2.node, (sessionID) =>
            Effect.gen(function* () {
              const parentTools = yield* materialize(sessionID)
              const spawnMessageID = yield* assistant(sessionID, "spawn", SubagentTool.spawnName, "call-spawn")
              const spawned = yield* settle(
                parentTools,
                sessionID,
                spawnMessageID,
                AgentV2.ID.make("build"),
                "call-spawn",
                SubagentTool.spawnName,
                {
                  agent: "explore",
                  description: "Self-improve",
                  prompt: "Read and improve your own agent definition.",
                  write_roots: [".forge"],
                },
              )
              expect(spawned.result.type).not.toBe("error")
              const tasks = yield* SessionTaskV2.Service
              const task = (yield* tasks.list({ parentSessionID: sessionID }))[0]!
              expect(task).toMatchObject({ agent: "explore", status: "running" })
              const childSessionID = task.childSessionID

              // The child session gets the subagent toolset (sibling send,
              // agent_doc) even though it never spawns anything itself.
              const childTools = yield* materialize(childSessionID)
              const childNames = childTools.definitions.map((definition) => definition.name)
              expect(childNames).toContain(SubagentTool.agentDocName)
              expect(childNames).toContain(SubagentTool.sendName)

              const childMessageID = SessionMessage.ID.make("msg_self_improve_child_patch")
              const improved = yield* settle(
                childTools,
                childSessionID,
                childMessageID,
                AgentV2.ID.make("explore"),
                "call-patch",
                "apply_patch",
                {
                  patchText:
                    "*** Begin Patch\n*** Update File: .forge/agent/explore.md\n@@\n-Baseline behavior\n+Evidence-grounded behavior\n*** End Patch",
                },
              )
              expect(improved.result.type).not.toBe("error")
              expect(
                yield* Effect.promise(() => fs.readFile(path.join(directory, ".forge", "agent", "explore.md"), "utf8")),
              ).toBe("## Explore\n\nEvidence-grounded behavior\n")

              // The grant is scoped: writing outside `.forge` is denied and
              // nothing lands on disk.
              const escaped = yield* settle(
                childTools,
                childSessionID,
                childMessageID,
                AgentV2.ID.make("explore"),
                "call-escape",
                "apply_patch",
                {
                  patchText: "*** Begin Patch\n*** Add File: notes.txt\n+leak\n*** End Patch",
                },
              )
              expect(escaped.result).toMatchObject({ type: "error" })
              expect(yield* Effect.promise(() => read(path.join(directory, "notes.txt")))).toBeUndefined()

              // The child now sees its own edited definition.
              const reread = yield* settle(
                childTools,
                childSessionID,
                childMessageID,
                AgentV2.ID.make("explore"),
                "call-reread",
                SubagentTool.agentDocName,
                {},
              )
              expect(reread.result).toMatchObject({
                type: "json",
                value: {
                  agent: "explore",
                  mode: "subagent",
                  message: "## Explore\n\nEvidence-grounded behavior\n",
                },
              })
            }),
          )
        }),
      ),
  )

  it.effect("the propose -> validate -> apply loop persists and lands an accepted definition", () =>
    withWorkspace(recordingPermission, (directory) =>
      Effect.gen(function* () {
        const baseline = "## Explore\n\nBaseline behavior\n"
        yield* Effect.promise(() =>
          fs
            .mkdir(path.join(directory, ".forge", "agent"), { recursive: true })
            .then(() => fs.writeFile(path.join(directory, ".forge", "agent", "explore.md"), baseline)),
        )
        return yield* scaffold(directory, recordingPermission, (sessionID) =>
          Effect.gen(function* () {
            const tools = yield* materialize(sessionID)
            const messageID = yield* assistant(sessionID, "propose", AgentImprovementTool.proposeName)
            const proposed = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-propose",
              AgentImprovementTool.proposeName,
              {
                agent: "explore",
                proposal: "## Explore\n\nRegression-gated behavior",
                rationale: "Baseline behavior misses evidence-grounded steps",
                evidence: "run 1: ignored evidence rows\nrun 2: same failure",
              },
            )
            expect(proposed.result).toMatchObject({
              type: "json",
              value: {
                proposal: {
                  agent: "explore",
                  status: "proposed",
                },
                baseline,
              },
            })
            expect(assertions.map((item) => item.action)).toEqual([AgentImprovementTool.proposeName])
            expect(assertions[0]?.resources).toEqual(["explore"])

            const proposalID = proposedID(proposed.result)

            const proposals = yield* (yield* AgentImprovement.Service).list(sessionID)
            expect(proposals).toHaveLength(1)
            expect(proposals[0]).toMatchObject({
              agent: "explore",
              status: "proposed",
              baseline,
              proposal: "## Explore\n\nRegression-gated behavior",
              evidence: "run 1: ignored evidence rows\nrun 2: same failure",
              revision: 1,
            })

            const premature = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-apply-premature",
              AgentImprovementTool.applyName,
              { proposal_id: proposalID },
            )
            expect(premature.result).toMatchObject({
              type: "error",
              value: expect.stringContaining("only validated proposals can be applied"),
            })

            const adjudicated = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-adjudicate",
              AgentImprovementTool.adjudicateName,
              {
                proposal_id: proposalID,
                pass: true,
                validation: "regression run 3: all checks green",
              },
            )
            expect(adjudicated.result).toMatchObject({
              type: "json",
              value: {
                proposal: { proposal_id: proposalID, status: "validated" },
              },
            })
            expect(assertions[assertions.length - 1]?.action).toBe(AgentImprovementTool.adjudicateName)

            const applied = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-apply",
              AgentImprovementTool.applyName,
              { proposal_id: proposalID },
            )
            expect(applied.result).toMatchObject({
              type: "json",
              value: {
                proposal: { proposal_id: proposalID, status: "accepted", path: "explore.md" },
              },
            })
            expect(
              yield* Effect.promise(() => fs.readFile(path.join(directory, ".forge", "agent", "explore.md"), "utf8")),
            ).toBe("## Explore\n\nRegression-gated behavior")
            expect(assertions[assertions.length - 1]?.action).toBe("edit")
            expect(assertions[assertions.length - 1]?.resources).toEqual([".forge/agent/explore.md"])

            const stored = yield* (yield* AgentImprovement.Service).get(proposalID)
            expect(stored).toMatchObject({ status: "accepted", validation: "regression run 3: all checks green" })
          }),
        )
      }),
    ),
  )

  it.effect("a failed validation rejects the proposal and nothing is applied", () =>
    withWorkspace(recordingPermission, (directory) =>
      Effect.gen(function* () {
        const baseline = "## Explore\n\nBaseline behavior\n"
        yield* Effect.promise(() =>
          fs
            .mkdir(path.join(directory, ".forge", "agent"), { recursive: true })
            .then(() => fs.writeFile(path.join(directory, ".forge", "agent", "explore.md"), baseline)),
        )
        return yield* scaffold(directory, recordingPermission, (sessionID) =>
          Effect.gen(function* () {
            const tools = yield* materialize(sessionID)
            const messageID = yield* assistant(sessionID, "reject", AgentImprovementTool.proposeName)
            const proposed = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-propose",
              AgentImprovementTool.proposeName,
              {
                agent: "explore",
                proposal: "## Explore\n\nUnproven behavior\n",
                rationale: "Suspected improvement",
                evidence: "single trace",
              },
            )
            const proposalID = proposedID(proposed.result)

            const rejected = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-adjudicate",
              AgentImprovementTool.adjudicateName,
              {
                proposal_id: proposalID,
                pass: false,
                validation: "regression run: regression count increased",
              },
            )
            expect(rejected.result).toMatchObject({
              type: "json",
              value: { proposal: { proposal_id: proposalID, status: "rejected" } },
            })

            const applied = yield* settle(
              tools,
              sessionID,
              messageID,
              AgentV2.ID.make("build"),
              "call-apply",
              AgentImprovementTool.applyName,
              { proposal_id: proposalID },
            )
            expect(applied.result).toMatchObject({
              type: "error",
              value: expect.stringContaining("only validated proposals can be applied"),
            })
            expect(
              yield* Effect.promise(() => fs.readFile(path.join(directory, ".forge", "agent", "explore.md"), "utf8")),
            ).toBe(baseline)
            expect(yield* (yield* AgentImprovement.Service).get(proposalID)).toMatchObject({
              status: "rejected",
              validation: "regression run: regression count increased",
            })
          }),
        )
      }),
    ),
  )

  it.effect(
    "an analyst team member runs the full loop against its own definition with the real permission engine",
    () =>
      withWorkspace(PermissionV2.node, (directory) =>
        Effect.gen(function* () {
          const baseline = "## Explore\n\nBaseline behavior\n"
          yield* Effect.promise(() =>
            fs
              .mkdir(path.join(directory, ".forge", "agent"), { recursive: true })
              .then(() => fs.writeFile(path.join(directory, ".forge", "agent", "explore.md"), baseline)),
          )
          return yield* scaffold(directory, PermissionV2.node, (sessionID) =>
            Effect.gen(function* () {
              const parentTools = yield* materialize(sessionID)
              const spawnMessageID = yield* assistant(
                sessionID,
                "loop_spawn",
                SubagentTool.spawnName,
                "call-loop-spawn",
              )
              const spawned = yield* settle(
                parentTools,
                sessionID,
                spawnMessageID,
                AgentV2.ID.make("build"),
                "call-loop-spawn",
                SubagentTool.spawnName,
                {
                  agent: "explore",
                  description: "Self-improve",
                  prompt: "Improve your definition through the gated loop.",
                  write_roots: [".forge"],
                },
              )
              expect(spawned.result.type).not.toBe("error")
              const task = (yield* (yield* SessionTaskV2.Service).list({ parentSessionID: sessionID }))[0]!
              const childTools = yield* materialize(task.childSessionID)
              const childMessageID = SessionMessage.ID.make("msg_self_improve_loop_child")

              const proposed = yield* settle(
                childTools,
                task.childSessionID,
                childMessageID,
                AgentV2.ID.make("explore"),
                "call-propose",
                AgentImprovementTool.proposeName,
                {
                  agent: "explore",
                  proposal: "## Explore\n\nTeam-validated behavior",
                  rationale: "Sibling analysts confirmed the improvement",
                  evidence: "board: recon missed endpoint; auth triaged",
                },
              )
              const proposalID = proposedID(proposed.result)

              const adjudicated = yield* settle(
                childTools,
                task.childSessionID,
                childMessageID,
                AgentV2.ID.make("explore"),
                "call-adjudicate",
                AgentImprovementTool.adjudicateName,
                {
                  proposal_id: proposalID,
                  pass: true,
                  validation: "regression: sibling re-run found all baseline findings",
                },
              )
              expect(adjudicated.result).toMatchObject({
                type: "json",
                value: { proposal: { proposal_id: proposalID, status: "validated" } },
              })

              const applied = yield* settle(
                childTools,
                task.childSessionID,
                childMessageID,
                AgentV2.ID.make("explore"),
                "call-apply",
                AgentImprovementTool.applyName,
                { proposal_id: proposalID },
              )
              expect(applied.result).toMatchObject({
                type: "json",
                value: { proposal: { proposal_id: proposalID, status: "accepted" } },
              })
              expect(
                yield* Effect.promise(() => fs.readFile(path.join(directory, ".forge", "agent", "explore.md"), "utf8")),
              ).toBe("## Explore\n\nTeam-validated behavior")

              const reread = yield* settle(
                childTools,
                task.childSessionID,
                childMessageID,
                AgentV2.ID.make("explore"),
                "call-reread",
                SubagentTool.agentDocName,
                {},
              )
              expect(reread.result).toMatchObject({
                type: "json",
                value: { agent: "explore", message: "## Explore\n\nTeam-validated behavior" },
              })
            }),
          )
        }),
      ),
  )

  it.effect("a child without the definition write root cannot apply an improvement", () =>
    withWorkspace(PermissionV2.node, (directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs
            .mkdir(path.join(directory, ".forge", "agent"), { recursive: true })
            .then(() =>
              fs.writeFile(path.join(directory, ".forge", "agent", "explore.md"), "## Explore\n\nBaseline\n"),
            ),
        )
        return yield* scaffold(directory, PermissionV2.node, (sessionID) =>
          Effect.gen(function* () {
            const parentTools = yield* materialize(sessionID)
            const spawnMessageID = yield* assistant(
              sessionID,
              "readonly_spawn",
              SubagentTool.spawnName,
              "call-ro-spawn",
            )
            const spawned = yield* settle(
              parentTools,
              sessionID,
              spawnMessageID,
              AgentV2.ID.make("build"),
              "call-ro-spawn",
              SubagentTool.spawnName,
              {
                agent: "explore",
                description: "Read only",
                prompt: "You may read but not change definitions.",
              },
            )
            expect(spawned.result.type).not.toBe("error")
            const task = (yield* (yield* SessionTaskV2.Service).list({ parentSessionID: sessionID }))[0]!
            const childTools = yield* materialize(task.childSessionID)
            const childMessageID = SessionMessage.ID.make("msg_self_improve_ro_child")

            const proposed = yield* settle(
              childTools,
              task.childSessionID,
              childMessageID,
              AgentV2.ID.make("explore"),
              "call-propose",
              AgentImprovementTool.proposeName,
              {
                agent: "explore",
                proposal: "## Explore\n\nBlocked behavior\n",
                rationale: "Read-only member",
                evidence: "trace",
              },
            )
            const proposalID = proposedID(proposed.result)
            yield* settle(
              childTools,
              task.childSessionID,
              childMessageID,
              AgentV2.ID.make("explore"),
              "call-adjudicate",
              AgentImprovementTool.adjudicateName,
              {
                proposal_id: proposalID,
                pass: true,
                validation: "regression: passed",
              },
            )
            const applied = yield* settle(
              childTools,
              task.childSessionID,
              childMessageID,
              AgentV2.ID.make("explore"),
              "call-apply",
              AgentImprovementTool.applyName,
              { proposal_id: proposalID },
            )
            expect(applied.result).toMatchObject({
              type: "error",
              value: expect.stringContaining("Permission denied: edit"),
            })
            expect(
              yield* Effect.promise(() => fs.readFile(path.join(directory, ".forge", "agent", "explore.md"), "utf8")),
            ).toBe("## Explore\n\nBaseline\n")
          }),
        )
      }),
    ),
  )
})
