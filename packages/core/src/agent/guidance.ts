export * as AgentGuidance from "./guidance"

import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionSchema } from "../session/schema"
import { SessionTaskV2 } from "../session/task"
import { SystemContext } from "../system-context/index"
import { interruptName, listName, notifyParentName, peekName, sendName, spawnName, waitName } from "../tool/subagent"
import { TeamBoardTool } from "../tool/team-board"

const Summary = Schema.Struct({
  id: AgentV2.ID,
  description: Schema.String.pipe(Schema.optional),
})

const State = Schema.Struct({
  tools: Schema.Array(Schema.String),
  agents: Schema.Array(Summary),
  limit: Schema.Int.pipe(Schema.optional),
  notify: Schema.Boolean.pipe(Schema.optional),
  unavailable: Schema.Literal("max_depth").pipe(Schema.optional),
})
type State = typeof State.Type

// `notify_parent` is deliberately absent: it exists only in a task-owned child
// catalog, so listing it here would teach a tool the parent cannot call.
const toolNames = [
  spawnName,
  sendName,
  waitName,
  interruptName,
  listName,
  peekName,
  TeamBoardTool.postName,
  TeamBoardTool.readName,
]

const render = (state: State) => {
  if (state.unavailable === "max_depth")
    return [
      "Nested delegation is unavailable because this session is already at the maximum subagent depth. Complete the assigned work directly and do not call spawn_agent.",
      ...(state.tools.includes(TeamBoardTool.postName) && state.tools.includes(TeamBoardTool.readName)
        ? [
            `Team coordination remains available: read sibling findings with ${TeamBoardTool.readName} before overlapping work and publish evidence, status, and leads with ${TeamBoardTool.postName}; each post queues an advisory the parent session sees at its next provider-turn boundary.`,
          ]
        : []),
      ...(state.tools.includes(listName) && state.tools.includes(sendName)
        ? [`Siblings stay reachable through ${listName} and ${sendName}.`]
        : []),
      ...(state.notify === true
        ? [`Escalate blockers or needed decisions to the parent session with ${notifyParentName}.`]
        : []),
      "<available_subagent_tools>",
      ...state.tools.map((tool) => `  <tool>${escapeXml(tool)}</tool>`),
      "</available_subagent_tools>",
    ].join("\n")
  const available = new Set(state.agents.map((agent) => agent.id))
  return [
    "Use durable specialized subagents when independent work can run in parallel or when a separate review perspective materially improves confidence.",
    "<subagent_workflow>",
    `  1. Use ${spawnName} for independent exploration or research assignments in the same provider turn so they run in parallel; it returns after admission, not after child completion.`,
    ...(state.limit === undefined
      ? []
      : [
          `  At most ${state.limit} subagents run at once for this session. Plan fan-out in waves of ${state.limit} or fewer; a further ${spawnName} fails until one settles.`,
        ]),
    "  2. Split implementation into disjoint workers with non-overlapping write roots. Do not assign duplicate work.",
    "  When spawning, omit model unless a specific override is required; an omitted model uses the child agent's configured default, then inherits the parent session's model.",
    ...(state.tools.includes(TeamBoardTool.postName) && state.tools.includes(TeamBoardTool.readName)
      ? [
          `  3. Keep working on non-overlapping work after spawning. Children should publish evidence, status, and leads with ${TeamBoardTool.postName}; read incoming work with ${TeamBoardTool.readName} before duplicating it. Each board post, ${notifyParentName} advisory, and child settle notice arrives as a queued advisory message at your next provider-turn boundary — continue working; they do not interrupt in-flight work.`,
        ]
      : [
          "  3. Keep working on non-overlapping work after spawning; do not block the parent just to monitor a child. A child's settle notice arrives as a queued advisory message at your next provider-turn boundary without interrupting in-flight work.",
        ]),
    ...(state.tools.includes(waitName)
      ? [
          `  4. Use ${waitName} only as an explicit final-report barrier when you need complete terminal results; it is not the normal step after spawning.`,
        ]
      : []),
    ...(state.tools.includes(sendName)
      ? [
          `  Use ${sendName} to steer a running child mid-flight — clarify or extend its bounded assignment; the instruction promotes at the child's next provider-turn boundary.`,
        ]
      : []),
    ...(state.tools.includes(peekName)
      ? [
          `  Use ${peekName} to tail a running child's transcript — prompts, replies, and tool-call inputs without output bodies — before steering or interrupting it.`,
        ]
      : []),
    ...(available.has(AgentV2.ID.make("adversarial-review"))
      ? [
          "  5. Use adversarial-review at most once per task, and only when the implemented change touches a concrete high-risk boundary such as authorization, persistence, concurrency, security isolation, destructive host behavior, or protocol compatibility. Skip it for routine local changes, documentation, tests, and low-risk refactors. Include the original requested outcomes and constraints, the exact changed paths and regions or a bounded diff, and relevant verification evidence; keep the writer's implementation summary separate so the reviewer can reconstruct actual behavior independently. Treat its evidence as input, not authority; repair only confirmed defects, and do not launch a second review after repairs.",
        ]
      : [
          "  5. When a listed specialist is suitable for independent review, ask it to challenge the result. Treat its evidence as input, not authority; repair only confirmed defects.",
        ]),
    ...(available.has(AgentV2.ID.make("qualification"))
      ? [
          "  6. Delegate exact bounded verification to qualification, then synthesize the result and remaining blockers yourself.",
        ]
      : [
          "  6. When a listed specialist is suitable for verification, delegate exact bounded checks, then synthesize the result and remaining blockers yourself.",
        ]),
    ...(state.tools.includes(interruptName)
      ? [`  7. Use ${interruptName} when a child is obsolete or off track.`]
      : []),
    ...(state.tools.includes(listName)
      ? [
          `  Use ${listName} to recover durable child IDs and status; result and error previews appear only after a task settles.`,
        ]
      : []),
    "  Avoid nested delegation. Keep each assignment bounded, self-contained, and explicit about expected evidence.",
    "</subagent_workflow>",
    "<available_subagent_tools>",
    ...state.tools.map((tool) => `  <tool>${escapeXml(tool)}</tool>`),
    "</available_subagent_tools>",
    "<available_subagents>",
    ...state.agents.flatMap((agent) => [
      "  <agent>",
      `    <id>${escapeXml(agent.id)}</id>`,
      ...(agent.description === undefined ? [] : [`    <description>${escapeXml(agent.description)}</description>`]),
      "  </agent>",
    ]),
    "</available_subagents>",
  ].join("\n")
}

type LoadInput =
  | AgentV2.Selection
  | {
      readonly agent: AgentV2.Selection
      readonly sessionID: SessionSchema.ID
    }

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/AgentGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const tasks = yield* SessionTaskV2.Service

    const available = Effect.fn("AgentGuidance.available")(function* (input: LoadInput) {
      const selection = "agent" in input ? input.agent : input
      const sessionID = "agent" in input ? input.sessionID : undefined
      const info = selection.info
      if (!info) return
      const owner = sessionID ? yield* tasks.owner(sessionID) : undefined
      const authority = sessionID ? yield* tasks.authority(sessionID) : undefined
      const rulesets = authority
        ? [
            authority.parentPermissions,
            ...authority.ancestorPermissionSets,
            authority.childPermissions,
            authority.hardPermissions,
          ]
        : [info.permissions]
      const allowed = (action: string, resource: string) =>
        rulesets.every((rules) => PermissionV2.evaluate(action, resource, rules).effect !== "deny")
      const tools = toolNames.filter((name) => allowed(name, "*"))
      if (owner && owner.depth >= SessionTaskV2.MAX_DEPTH)
        return {
          tools: tools.filter((name) => name !== spawnName),
          agents: [],
          notify: allowed(notifyParentName, "*"),
          unavailable: "max_depth" as const,
        }
      if (!tools.includes(spawnName)) return
      const visible = (yield* agents.all())
        .filter(
          (agent) =>
            agent.id !== selection.id && agent.mode !== "primary" && !agent.hidden && allowed(spawnName, agent.id),
        )
        .map((agent) => ({ id: agent.id, description: agent.description }))
        .toSorted((a, b) => a.id.localeCompare(b.id))
      if (visible.length === 0) return
      // Read per observation, not once per session: `SystemContext` re-runs this
      // effect every reconcile, so a changed `subagents.max_concurrent` reaches
      // the model as an update instead of being baked into the baseline.
      const limit = SessionTaskV2.resolveActiveLimit(
        Config.latest(yield* config.entries(), "subagents")?.max_concurrent,
      )
      return { tools, agents: visible, limit }
    })

    return Service.of({
      load: Effect.fn("AgentGuidance.load")(function* (selection) {
        const current = yield* available(selection)
        if (!current) return SystemContext.empty
        return SystemContext.make({
          key: SystemContext.Key.make("core/subagent-guidance"),
          codec: Schema.toCodecJson(State),
          load: available(selection).pipe(Effect.map((value) => value ?? SystemContext.unavailable)),
          baseline: render,
          update: (_previous, value) =>
            [
              "The available subagent tools, concurrency limit, or specialist catalog changed. This guidance supersedes the previous subagent guidance.",
              render(value),
            ].join("\n"),
          removed: () =>
            "Subagent guidance is no longer available. Do not use previously listed subagent tools or specialist IDs.",
        })
      }),
    })
  }),
)

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [AgentV2.node, Config.node, SessionTaskV2.node] })
