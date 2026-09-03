export * as YolkTool from "./yolk"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ExtensionRuntime } from "../extension"
import { Location } from "../location"
import { Tool } from "./tool"
import { ToolInterceptor } from "./interceptor"
import { SessionToolProvider } from "./session-provider"
import { YolkAnalyzer } from "./yolk-analyzer"

export const name = "inspect_change"
const extensionID = "turenlabs/yolk"
const mutationTools = new Set(["write", "edit", "apply_patch"])

export const Input = Schema.Struct({
  symbol: Schema.optional(
    Schema.NonEmptyString.annotate({
      description: "Function or method symbol. Omit it and pass path to discover valid symbols first.",
    }),
  ),
  path: Schema.optional(
    Schema.NonEmptyString.annotate({
      description: "Source path used to discover or narrow symbols, relative to the workspace root.",
    }),
  ),
  symbols: Schema.optional(
    Schema.Array(Schema.NonEmptyString).annotate({
      description: "Exact function or method symbols to inspect together using one index",
    }),
  ),
  paths: Schema.optional(
    Schema.Array(Schema.NonEmptyString).annotate({
      description: "Source paths to discover together or use as inspection context",
    }),
  ),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const extensions = yield* ExtensionRuntime.Service
    const location = yield* Location.Service
    const analyzer = yield* YolkAnalyzer.Service
    const interceptors = yield* ToolInterceptor.Service
    const providers = yield* SessionToolProvider.Service
    const inspect = Tool.make({
      description:
        "Inspect static impact for a named function or method, or discover indexed symbols by passing a source path. Yolk does not observe Solid/React tracking or store reads inside callees. Use path-first discovery when the exact symbol is unknown; never create probe files. Unknown or partial confidence is not a diagnosis.",
      input: Input,
      output: Schema.String,
      toModelOutput: ({ output }) => [{ type: "text", text: output }],
      execute: (input) =>
        input.symbol || input.path || input.symbols?.length || input.paths?.length
          ? analyzer.inspect({
              symbol: input.symbol?.trim(),
              path: input.path?.trim(),
              symbols: input.symbols?.map((symbol) => symbol.trim()),
              paths: input.paths?.map((path) => path.trim()),
            })
          : Effect.fail(new Tool.Failure({ message: "Pass symbol, path, symbols, or paths" })),
    })
    yield* providers.add({
      tools: (input) =>
        input.directory === location.directory
          ? extensions.enabled(extensionID).pipe(Effect.map((enabled) => (enabled ? { [name]: inspect } : {})))
          : Effect.succeed({}),
    })

    const turns = new Map<
      string,
      {
        calls: Set<string>
        afters: ToolInterceptor.AfterEvent[]
        closed: boolean
        closedSignal: PromiseWithResolvers<void>
        done: PromiseWithResolvers<void>
        running: boolean
      }
    >()
    const closedTurns = new Set<string>()
    const turnKey = (event: ToolInterceptor.Identity) => `${event.sessionID}:${event.assistantMessageID}`
    const complete = (key: string, event: ToolInterceptor.Identity) =>
      Effect.gen(function* () {
        const turn = turns.get(key)
        if (!turn || !turn.closed || turn.calls.size > 0 || turn.running) return
        turn.running = true
        yield* Effect.gen(function* () {
          const owner = turn.afters.findLast((item) => !item.denied)
          if (!owner || !(yield* extensions.enabled(extensionID))) {
            yield* analyzer.discard(owner ?? event)
          } else {
            const note = yield* analyzer.after(owner)
            if (note) owner.notes.push(note)
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              turns.delete(key)
              turn.done.resolve()
            }),
          ),
        )
      })

    yield* interceptors.hook.before((event) =>
      Effect.gen(function* () {
        if (!mutationTools.has(event.tool) || !(yield* extensions.enabled(extensionID))) return
        const key = turnKey(event)
        const turn =
          turns.get(key) ??
          (() => {
            const closed = closedTurns.has(key)
            const closedSignal = Promise.withResolvers<void>()
            if (closed) closedSignal.resolve()
            return {
              calls: new Set<string>(),
              afters: [],
              closed,
              closedSignal,
              done: Promise.withResolvers<void>(),
              running: false,
            }
          })()
        turn.calls.add(event.callID)
        turns.set(key, turn)
        yield* analyzer.before(event)
      }),
    )
    yield* interceptors.hook.after((event) =>
      Effect.gen(function* () {
        if (!mutationTools.has(event.tool)) return
        const key = turnKey(event)
        const turn = turns.get(key)
        if (!turn?.calls.delete(event.callID)) return
        turn.afters.push(event)
        yield* Effect.promise(() => turn.closedSignal.promise)
        yield* complete(key, event)
        yield* Effect.promise(() => turn.done.promise)
      }),
    )
    yield* interceptors.hook.finalize((event) =>
      Effect.gen(function* () {
        if (!mutationTools.has(event.tool)) return
        const key = turnKey(event)
        const turn = turns.get(key)
        if (!turn?.calls.delete(event.callID)) return
        yield* complete(key, event)
      }),
    )
    yield* interceptors.hook.turnComplete((event) =>
      Effect.gen(function* () {
        const key = `${event.sessionID}:${event.assistantMessageID}`
        closedTurns.add(key)
        const turn = turns.get(key)
        if (!turn) return
        turn.closed = true
        turn.closedSignal.resolve()
        yield* complete(key, {
          ...event,
          agent: "",
          callID: "",
          tool: "provider-turn",
        })
      }),
    )
  }),
)

export const node = makeLocationNode({
  name: "tool/yolk",
  layer,
  deps: [ExtensionRuntime.node, Location.node, YolkAnalyzer.node, SessionToolProvider.node, ToolInterceptor.node],
})
