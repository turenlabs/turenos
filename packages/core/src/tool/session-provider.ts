export * as SessionToolProvider from "./session-provider"

import { Context, Effect, Layer, Scope } from "effect"
import type { WorkspaceID } from "@turenlabs/schema/workspace-id"
import { AgentV2 } from "../agent"
import { makeGlobalNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { SessionSchema } from "../session/schema"
import { Tool } from "./tool"
import type { Definition, Interface as McpSource } from "./mcp"

export interface Target {
  readonly sessionID: SessionSchema.ID
  readonly model: ModelV2.Ref
  readonly directory?: AbsolutePath
  readonly workspaceID?: WorkspaceID
  readonly permissions?: PermissionV2.Ruleset
  readonly agent?: AgentV2.ID
  readonly mcpDefinitions?: ReadonlyArray<Definition>
  readonly mcpSource?: McpSource
  readonly mcpPermission?: PermissionV2.Interface
  readonly mcpSelectedKeys?: ReadonlyArray<string>
  readonly advanceMcpTurn?: boolean
}

/**
 * Contributes tools to one provider turn of a specific Session. A provider that
 * has nothing for the Session returns an empty record, so a registration that
 * belongs to one workflow never widens the toolset of unrelated Sessions.
 */
export interface Provider {
  readonly tools: (input: Target) => Effect.Effect<Readonly<Record<string, Tool.AnyTool>>>
}

export interface Interface {
  /** Registers a provider for the lifetime of the calling scope. */
  readonly add: (provider: Provider) => Effect.Effect<void, never, Scope.Scope>
  readonly forExecution: (input: Target) => Effect.Effect<Readonly<Record<string, Tool.AnyTool>>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionToolProvider") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Insertion-ordered so a later registration wins a name collision.
    const providers = new Set<Provider>()

    return Service.of({
      add: Effect.fn("SessionToolProvider.add")(function* (provider) {
        providers.add(provider)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            providers.delete(provider)
          }),
        )
      }),
      forExecution: Effect.fn("SessionToolProvider.forExecution")(function* (input) {
        const contributed = yield* Effect.forEach([...providers], (provider) => provider.tools(input))
        return contributed.reduce<Record<string, Tool.AnyTool>>((all, tools) => ({ ...all, ...tools }), {})
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
