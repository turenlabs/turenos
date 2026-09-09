import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { AgentGuidance } from "@turenlabs/core/agent/guidance"
import { Config } from "@turenlabs/core/config"
import { ConfigSubagent } from "@turenlabs/core/config/subagent"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { AgentPlugin } from "@turenlabs/core/plugin/agent"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SystemContext } from "@turenlabs/core/system-context"
import { interruptName, listName, sendName, spawnName, waitName } from "@turenlabs/core/tool/subagent"
import { TeamBoardTool } from "@turenlabs/core/tool/team-board"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const sessionID = SessionSchema.ID.make("ses_guidance_child")
let owner: SessionTaskV2.Info | undefined
let authority: SessionTaskV2.Authority | undefined
let maxConcurrent: number | undefined
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AgentV2.node, AgentGuidance.node]), [
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        Config.Service.of({
          entries: () =>
            Effect.sync(() => [
              new Config.Document({
                type: "document",
                info: new Config.Info(
                  maxConcurrent === undefined
                    ? {}
                    : { subagents: new ConfigSubagent.Info({ max_concurrent: maxConcurrent }) },
                ),
              }),
            ]),
        }),
      ),
    ],
    [
      SessionTaskV2.node,
      Layer.mock(SessionTaskV2.Service, {
        authority: () => Effect.succeed(authority),
        owner: () => Effect.succeed(owner),
      }),
    ],
  ]),
)

const setup = Effect.fnUntraced(function* () {
  owner = undefined
  authority = undefined
  maxConcurrent = undefined
  const agents = yield* AgentV2.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
    Effect.provideService(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
    ),
  )
  return { agents, guidance: yield* AgentGuidance.Service }
})

describe("AgentGuidance", () => {
  it.effect("limits adversarial review to one high-risk pass", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      const selected = yield* context.agents.select()
      const generation = yield* SystemContext.initialize(yield* context.guidance.load(selected))

      expect(generation.baseline).toContain("<subagent_workflow>")
      expect(generation.baseline).toContain("independent exploration or research assignments in the same provider turn")
      expect(generation.baseline).toContain("returns after admission, not after child completion")
      expect(generation.baseline).toContain("non-overlapping write roots")
      expect(generation.baseline).toContain("explicit final-report barrier")
      expect(generation.baseline).toContain("Board updates stay in the background and do not wake the parent")
      expect(generation.baseline).toContain("at most once per task")
      expect(generation.baseline).toContain("concrete high-risk boundary")
      expect(generation.baseline).toContain("Skip it for routine local changes")
      expect(generation.baseline).toContain("original requested outcomes and constraints")
      expect(generation.baseline).toContain("changed paths")
      expect(generation.baseline).toContain("regions or a bounded diff")
      expect(generation.baseline).toContain("reconstruct actual behavior independently")
      expect(generation.baseline).toContain("Treat its evidence as input, not authority")
      expect(generation.baseline).toContain("repair only confirmed defects")
      expect(generation.baseline).toContain("do not launch a second review after repairs")
      expect(generation.baseline).not.toContain("After implementation, delegate an adversarial-review pass")
      expect(generation.baseline).toContain("Avoid nested delegation")
      expect(
        [spawnName, sendName, waitName, interruptName, listName, TeamBoardTool.postName, TeamBoardTool.readName].every(
          (name) => generation.baseline.includes(`<tool>${name}</tool>`),
        ),
      ).toBe(true)
      expect(
        ["adversarial-review", "explore", "general", "qualification", "research", "worker"].every((id) =>
          generation.baseline.includes(`<id>${id}</id>`),
        ),
      ).toBe(true)
    }),
  )

  it.effect("explains why nesting is unavailable at the durable task depth limit", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      owner = SessionTaskV2.Info.make({
        id: SessionTaskV2.ID.make("tsk_guidance"),
        rootSessionID: SessionSchema.ID.make("ses_guidance_root"),
        parentSessionID: SessionSchema.ID.make("ses_guidance_parent"),
        childSessionID: sessionID,
        actor: {
          sessionID: SessionSchema.ID.make("ses_guidance_parent"),
          assistantMessageID: SessionMessage.ID.make("msg_guidance"),
          toolCallID: "call-guidance",
        },
        agent: AgentV2.ID.make("explore"),
        prompt: Prompt.make({ text: "Review the implementation." }),
        description: "Review implementation",
        depth: SessionTaskV2.MAX_DEPTH,
        status: "running",
        revision: 1,
        authority: {
          parentPermissions: [],
          ancestorPermissionSets: [],
          childPermissions: [],
          hardPermissions: [],
          writeRoots: [],
          commands: [],
        },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      })
      const selected = yield* context.agents.select("explore")
      const generation = yield* SystemContext.initialize(yield* context.guidance.load({ agent: selected, sessionID }))

      expect(generation.baseline).toContain("maximum subagent depth")
      expect(generation.baseline).toContain("Team coordination remains available")
      expect(generation.baseline).toContain(`<tool>${TeamBoardTool.postName}</tool>`)
      expect(generation.baseline).toContain(`<tool>${TeamBoardTool.readName}</tool>`)
      expect(generation.baseline).not.toContain(`<tool>${spawnName}</tool>`)

      authority = SessionTaskV2.Authority.make({
        parentPermissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: TeamBoardTool.postName, resource: "*", effect: "deny" },
        ],
        ancestorPermissionSets: [],
        childPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        hardPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        writeRoots: [],
        commands: [],
      })
      const denied = yield* SystemContext.initialize(yield* context.guidance.load({ agent: selected, sessionID }))
      expect(denied.baseline).toContain(`<tool>${TeamBoardTool.readName}</tool>`)
      expect(denied.baseline).not.toContain(`<tool>${TeamBoardTool.postName}</tool>`)
    }),
  )

  it.effect("states the configured concurrency ceiling so fan-out is planned in waves", () =>
    Effect.gen(function* () {
      const context = yield* setup()

      const standard = yield* SystemContext.initialize(yield* context.guidance.load(yield* context.agents.select()))
      expect(standard.baseline).toContain(
        `At most ${SessionTaskV2.DEFAULT_ACTIVE_PER_ROOT} subagents run at once for this session`,
      )

      maxConcurrent = 7
      const configured = yield* SystemContext.initialize(yield* context.guidance.load(yield* context.agents.select()))
      expect(configured.baseline).toContain("At most 7 subagents run at once for this session")
      expect(configured.baseline).toContain("Plan fan-out in waves of 7 or fewer")
      expect(configured.baseline).not.toContain(`waves of ${SessionTaskV2.DEFAULT_ACTIVE_PER_ROOT}`)

      maxConcurrent = 10_000
      const clamped = yield* SystemContext.initialize(yield* context.guidance.load(yield* context.agents.select()))
      expect(clamped.baseline).toContain(`At most ${SessionTaskV2.MAX_ACTIVE_PER_ROOT} subagents run at once`)
    }),
  )

  it.effect("republishes the guidance when the configured concurrency ceiling changes mid-session", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      maxConcurrent = 2
      const source = yield* context.guidance.load(yield* context.agents.select())
      const generation = yield* SystemContext.initialize(source)
      expect(generation.baseline).toContain("At most 2 subagents run at once")

      expect(yield* SystemContext.reconcile(source, generation.snapshot)).toMatchObject({ _tag: "Unchanged" })

      maxConcurrent = 5
      const changed = yield* SystemContext.reconcile(source, generation.snapshot)
      expect(changed).toMatchObject({ _tag: "Updated" })
      if (changed._tag !== "Updated") throw new Error("expected an update")
      expect(changed.text).toContain("concurrency limit")
      expect(changed.text).toContain("At most 5 subagents run at once")
    }),
  )

  it.effect("renders user-defined specialists and excludes removed or spawn-denied IDs", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      yield* context.agents.transform((draft) => {
        draft.remove(AgentV2.ID.make("research"))
        draft.remove(AgentV2.ID.make("adversarial-review"))
        draft.update(AgentV2.ID.make("security-review"), (agent) => {
          agent.description = "Review <tenant> & recovery boundaries"
          agent.mode = "subagent"
        })
        draft.update(AgentV2.defaultID, (agent) => {
          agent.permissions.push({ action: spawnName, resource: "qualification", effect: "deny" })
        })
      })

      const generation = yield* SystemContext.initialize(yield* context.guidance.load(yield* context.agents.select()))

      expect(generation.baseline).toContain("<id>security-review</id>")
      expect(generation.baseline).toContain("Review &lt;tenant&gt; &amp; recovery boundaries")
      expect(generation.baseline).not.toContain("<id>research</id>")
      expect(generation.baseline).not.toContain("<id>qualification</id>")
      expect(generation.baseline).not.toContain("adversarial-review")
      expect(generation.baseline).not.toContain("verification to qualification")
      expect(generation.baseline).toContain("listed specialist is suitable for independent review")
      expect(generation.baseline).toContain("listed specialist is suitable for verification")
    }),
  )

  it.effect("omits guidance when all subagent tools are permission-disabled", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      yield* context.agents.transform((draft) =>
        draft.update(AgentV2.defaultID, (agent) => {
          agent.permissions.push(
            ...[spawnName, sendName, waitName, interruptName, listName].map((action) => ({
              action,
              resource: "*",
              effect: "deny" as const,
            })),
          )
        }),
      )

      expect(yield* SystemContext.initialize(yield* context.guidance.load(yield* context.agents.select()))).toEqual({
        baseline: "",
        snapshot: {},
      })
    }),
  )

  it.effect("does not teach nested delegation to built-in specialists", () =>
    Effect.gen(function* () {
      const context = yield* setup()

      yield* Effect.forEach(
        ["adversarial-review", "explore", "qualification", "research", "worker"],
        (id) =>
          Effect.gen(function* () {
            const selected = yield* context.agents.select(id)
            expect(yield* SystemContext.initialize(yield* context.guidance.load(selected))).toEqual({
              baseline: "",
              snapshot: {},
            })
          }),
        { discard: true },
      )
    }),
  )
})
