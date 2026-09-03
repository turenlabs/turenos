import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Project } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { ToolInterceptor } from "@turenlabs/core/tool/interceptor"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { SessionToolProvider } from "@turenlabs/core/tool/session-provider"
import { Tool } from "@turenlabs/core/tool/tool"
import { YolkTool } from "@turenlabs/core/tool/yolk"
import { YolkAnalyzer } from "@turenlabs/core/tool/yolk-analyzer"
import { ToolOutputStore } from "@turenlabs/core/tool-output-store"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Semaphore } from "effect"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const events: string[] = []
const baselines = new Set<string>()
const activation = { enabled: false }
const directory = AbsolutePath.make("/tmp/yolk")
const analyzer = Layer.succeed(
  YolkAnalyzer.Service,
  YolkAnalyzer.Service.of({
    inspect: (input) => Effect.succeed(JSON.stringify({ target: input.symbol })),
    before: (event) =>
      Effect.sync(() => {
        baselines.add(event.assistantMessageID)
        events.push(`before:${event.callID}`)
      }),
    after: (event) =>
      Effect.sync(() => {
        baselines.delete(event.assistantMessageID)
        events.push(`after:${event.callID}`)
        return "Yolk changed"
      }),
    discard: (event) =>
      Effect.sync(() => {
        if (baselines.delete(event.assistantMessageID)) events.push(`discard:${event.callID}`)
      }),
  }),
)
const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const layer = AppNodeBuilder.build(
  LayerNode.group([ToolRegistry.node, ToolInterceptor.node, SessionToolProvider.node, YolkTool.node]),
  [
    [YolkAnalyzer.node, analyzer],
    [
      ExtensionRuntime.node,
      Layer.mock(ExtensionRuntime.Service, { enabled: () => Effect.succeed(activation.enabled) }),
    ],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of({ directory, project: { id: Project.ID.make("yolk"), directory } }),
      ),
    ],
    [ToolOutputStore.node, outputStore],
  ],
)
const it = testEffect(layer)
const sessionID = SessionV2.ID.make("ses_yolk")
const target = {
  sessionID,
  model: ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }),
  directory,
}
const rawMaterialize = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const session = yield* (yield* SessionToolProvider.Service).forExecution(target)
  return yield* registry.materialize({ session })
})
const materialize = rawMaterialize
const settleInline = (input: ToolRegistry.ExecuteInput) =>
  rawMaterialize.pipe(Effect.flatMap((current) => current.settle({ ...input, inline: true })))

const write = Tool.make({
  description: "Write",
  input: Schema.Struct({ content: Schema.String }),
  output: Schema.String,
  execute: ({ content }) => {
    if (content === "interrupt") return Effect.interrupt
    return Effect.promise(async () => {
      if (content === "change") await new Promise((resolve) => setTimeout(resolve, 10))
      if (content === "disable") activation.enabled = false
      return "written"
    })
  },
  toModelOutput: ({ output }) => [{ type: "text", text: output }],
})

describe("YolkTool", () => {
  it.effect("updates inspect_change and mutation hooks on the next turn", () =>
    Effect.gen(function* () {
      activation.enabled = false
      expect((yield* materialize).definitions.map((tool) => tool.name)).not.toContain("inspect_change")

      activation.enabled = true
      events.length = 0
      const registry = yield* ToolRegistry.Service
      yield* registry.register({ write })
      expect((yield* materialize).definitions.map((tool) => tool.name)).toContain("inspect_change")

      expect(
        (yield* settleInline({
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "inspect", name: "inspect_change", input: { symbol: "demo.value" } },
        })).result,
      ).toEqual({ type: "text", value: JSON.stringify({ target: "demo.value" }) })

      expect(
        (yield* settleInline({
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "write", name: "write", input: { content: "change" } },
        })).result,
      ).toEqual({
        type: "content",
        value: [
          { type: "text", text: "written" },
          { type: "text", text: "Yolk changed" },
        ],
      })
      expect(events).toEqual(["before:write", "after:write"])

      events.length = 0
      const turnMaterialization = yield* rawMaterialize
      const withPermit = Semaphore.makeUnsafe(2).withPermit
      const fibers = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => `turn-${index}`),
        (callID) =>
          turnMaterialization
            .settle({
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: callID, name: "write", input: { content: "change" } },
              executeWithPermit: withPermit,
            })
            .pipe(Effect.forkChild),
      )
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
      yield* turnMaterialization.completeTurn({ sessionID, assistantMessageID: toolIdentity.assistantMessageID })
      const turn = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber), { concurrency: "unbounded" })
      expect(events.filter((event) => event.startsWith("before:"))).toHaveLength(12)
      expect(events.filter((event) => event.startsWith("after:"))).toHaveLength(1)
      expect(turn.filter((settlement) => settlement.result.type === "content")).toHaveLength(1)

      events.length = 0
      const lateMaterialization = yield* rawMaterialize
      yield* lateMaterialization.completeTurn({ sessionID, assistantMessageID: toolIdentity.assistantMessageID })
      const late = yield* lateMaterialization.settle({
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "turn-late", name: "write", input: { content: "change" } },
      })
      expect(late.result.type).toBe("content")
      expect(events).toEqual(["before:turn-late", "after:turn-late"])

      events.length = 0
      activation.enabled = true
      const disabledDuringCall = yield* settleInline({
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "write-toggle", name: "write", input: { content: "disable" } },
      })
      expect(disabledDuringCall.result).toEqual({ type: "text", value: "written" })
      expect(events).toEqual(["before:write-toggle", "discard:write-toggle"])

      events.length = 0
      activation.enabled = true
      const interrupted = yield* settleInline({
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "write-interrupt", name: "write", input: { content: "interrupt" } },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)
      expect(events).toEqual(["before:write-interrupt", "discard:write-interrupt"])
      expect(baselines.size).toBe(0)

      activation.enabled = false
      expect((yield* materialize).definitions.map((tool) => tool.name)).not.toContain("inspect_change")
      const disabledWrite = yield* settleInline({
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "write-disabled", name: "write", input: { content: "change" } },
      })
      expect(disabledWrite.result).toEqual({ type: "text", value: "written" })
      expect(events).toEqual(["before:write-interrupt", "discard:write-interrupt"])
    }),
  )
})
