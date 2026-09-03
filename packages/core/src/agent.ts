export * as AgentV2 from "./agent"

import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, Types } from "effect"
import { Agent } from "@turenlabs/schema/agent"
import { TeamBoard } from "@turenlabs/schema/team-board"
import { State } from "./state"
import { ExtensionRuntime } from "./extension"
import { Permission } from "@turenlabs/schema/permission"

export const ID = Agent.ID
export type ID = typeof ID.Type
export const defaultID = ID.make("build")
export const teamBoardActions = TeamBoard.toolActions

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Draft = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly default: () => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Agent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const extensions = yield* ExtensionRuntime.Service
    const extensionAgents = yield* catalogAgents(extensions)
    const state = State.create<Data, Draft>({
      initial: () => ({
        agents: new Map(extensionAgents.map((agent) => [agent.id, agent as Types.DeepMutable<Info>])),
      }),
      draft: (draft) => ({
        list: () => Array.fromIterable(draft.agents.values()) as Info[],
        get: (id) => draft.agents.get(id),
        default: (id) => {
          draft.default = id
        },
        update: (id, fn) => {
          const current = draft.agents.get(id) ?? (Info.empty(id) as Types.DeepMutable<Info>)
          if (!draft.agents.has(id)) draft.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          draft.agents.delete(id)
        },
      }),
    })
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(ID.make("build")))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("AgentV2.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      default: Effect.fn("AgentV2.default")(function* () {
        return selectedDefault()
      }),
      resolve: Effect.fn("AgentV2.resolve")(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("AgentV2.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault()
        return { id: info?.id ?? defaultID, info }
      }),
      all: Effect.fn("AgentV2.all")(function* () {
        return Array.fromIterable(state.get().agents.values())
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [ExtensionRuntime.node] })

const readActions = ["read", "grep", "glob", "list", "lsp"]
const binaryActions = [
  "binary_inspect",
  "extract_strings",
  "hexview",
  "decompile",
  "yara_scan",
  "pcap_inspect",
  "office_inspect",
  "protocol_inspect",
  "wasm_inspect",
  "binwalk_scan",
  "carve_embedded",
]

const catalogAgents = Effect.fn("AgentV2.catalogAgents")(function* (runtime: ExtensionRuntime.Interface) {
  const manifests = yield* runtime.manifests()
  const dataActions = manifests.flatMap((manifest) =>
    manifest.contributions.flatMap((contribution) =>
      contribution.type === "data" && contribution.adapter.startsWith("security:") ? contribution.tools.allow : [],
    ),
  )
  return (yield* ExtensionRuntime.enabledSkills(runtime)).flatMap(({ contribution }) => {
    if (!contribution.agent || contribution.source.type !== "catalog") return []
    const actions = [
      ...readActions,
      ...teamBoardActions,
      ...(contribution.agent.profile === "binary" ? binaryActions : []),
      ...(contribution.agent.profile === "data" ? dataActions : []),
    ]
    const permissions: Permission.Ruleset = [
      { action: "*", resource: "*", effect: "deny" },
      ...actions.map((action): Permission.Rule => ({ action, resource: "*", effect: "allow" })),
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "read", resource: "*.env.*", effect: "deny" },
      { action: "read", resource: "*.env.example", effect: "allow" },
      ...(contribution.agent.profile === "binary" ? binaryActions : []).flatMap((action): Permission.Rule[] => [
        { action, resource: "*.env", effect: "deny" },
        { action, resource: "*.env.*", effect: "deny" },
        { action, resource: "*.env.example", effect: "allow" },
      ]),
    ]
    return [
      Info.make({
        id: ID.make(contribution.id),
        request: { headers: {}, body: {} },
        system: contribution.source.content,
        description: contribution.description,
        mode: "subagent",
        hidden: false,
        ...(contribution.agent.steps ? { steps: contribution.agent.steps } : {}),
        permissions,
      }),
    ]
  })
})
