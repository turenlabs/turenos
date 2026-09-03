import { describe, expect } from "bun:test"
import { Effect, Exit, Schema, Scope } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionToolProvider } from "@turenlabs/core/tool/session-provider"
import { Tool } from "@turenlabs/core/tool/tool"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionToolProvider.node])))

const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("model"),
})
const member = SessionSchema.ID.make("ses_provider_member")
const outsider = SessionSchema.ID.make("ses_provider_outsider")

const marker = (value: string) =>
  Tool.make({
    description: `Returns ${value}`,
    input: Schema.Struct({}),
    output: Schema.Struct({ value: Schema.String }),
    execute: () => Effect.succeed({ value }),
  })

const provider = (sessionID: SessionSchema.ID, tools: Readonly<Record<string, Tool.AnyTool>>) => ({
  tools: (input: SessionToolProvider.Target) => Effect.succeed(input.sessionID === sessionID ? tools : {}),
})

describe("SessionToolProvider", () => {
  it.effect("contributes tools only to the sessions a provider targets", () =>
    Effect.gen(function* () {
      const providers = yield* SessionToolProvider.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* providers.add(provider(member, { pt_board: marker("board") }))

          expect(Object.keys(yield* providers.forExecution({ sessionID: member, model }))).toEqual(["pt_board"])
          expect(yield* providers.forExecution({ sessionID: outsider, model })).toEqual({})
        }),
      )
    }),
  )

  it.effect("merges providers with the later registration winning a name collision", () =>
    Effect.gen(function* () {
      const providers = yield* SessionToolProvider.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* providers.add(provider(member, { pt_board: marker("first"), pt_goal: marker("goal") }))
          yield* providers.add(provider(member, { pt_board: marker("second") }))

          const tools = yield* providers.forExecution({ sessionID: member, model })
          expect(Object.keys(tools).toSorted()).toEqual(["pt_board", "pt_goal"])
          expect(Tool.definition("pt_board", tools.pt_board!).description).toBe("Returns second")
        }),
      )
    }),
  )

  it.effect("drops a provider when its registration scope closes", () =>
    Effect.gen(function* () {
      const providers = yield* SessionToolProvider.Service
      const scope = yield* Scope.make()
      yield* providers.add(provider(member, { pt_board: marker("board") })).pipe(Scope.provide(scope))
      expect(Object.keys(yield* providers.forExecution({ sessionID: member, model }))).toEqual(["pt_board"])

      yield* Scope.close(scope, Exit.void)
      expect(yield* providers.forExecution({ sessionID: member, model })).toEqual({})
    }),
  )
})
