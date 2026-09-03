export * as BatouTool from "./batou"

import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ExtensionRuntime } from "../extension"
import { BatouScanner } from "./batou-scanner"
import { ToolInterceptor } from "./interceptor"

const extensionID = "turenlabs/batou"
const tools = new Set(["write", "edit", "apply_patch"])

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const extensions = yield* ExtensionRuntime.Service
    const scanner = yield* BatouScanner.Service
    const interceptors = yield* ToolInterceptor.Service
    const active = new Set<string>()
    const key = (event: ToolInterceptor.Identity) => `${event.sessionID}\0${event.callID}`

    yield* interceptors.hook.before((event) =>
      Effect.gen(function* () {
        if (!tools.has(event.tool) || !(yield* extensions.enabled(extensionID))) return
        active.add(key(event))
        const reason = yield* scanner.before(event)
        if (!reason) return
        active.delete(key(event))
        event.decision = { type: "deny", reason }
      }),
    )

    yield* interceptors.hook.after((event) =>
      Effect.gen(function* () {
        if (!tools.has(event.tool) || !active.delete(key(event))) return
        const notes = yield* scanner.after(event)
        if (event.denied || event.result.type === "error") return
        event.notes.push(...notes)
      }),
    )
  }),
)

export const node = makeLocationNode({
  name: "tool-batou",
  layer,
  deps: [ExtensionRuntime.node, BatouScanner.node, ToolInterceptor.node],
})
