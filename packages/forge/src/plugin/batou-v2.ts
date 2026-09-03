export * as BatouScannerLive from "./batou-v2"

import { Location } from "@turenlabs/core/location"
import { BatouScanner } from "@turenlabs/core/tool/batou-scanner"
import { Effect, Layer } from "effect"
import { makeLocationNode } from "@turenlabs/core/effect/app-node"
import { errorMessage } from "@/util/error"
import { BatouPlugin } from "./batou"

const layer = Layer.effect(
  BatouScanner.Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const hooks = BatouPlugin(
      { directory: location.directory },
      {
        isEnabled: () => Promise.resolve(true),
      },
    )
    const before = hooks["tool.execute.before"]
    const after = hooks["tool.execute.after"]

    return BatouScanner.Service.of({
      before: (event) =>
        Effect.promise(async () => {
          if (!before) return undefined
          try {
            await before({ tool: event.tool, sessionID: event.sessionID, callID: event.callID }, { args: event.input })
            return undefined
          } catch (error) {
            return errorMessage(error)
          }
        }),
      after: (event) =>
        Effect.promise(async () => {
          if (!after) return []
          const output = { title: "", output: "", metadata: {} }
          await after(
            {
              tool: event.tool,
              sessionID: event.sessionID,
              callID: event.callID,
              args: event.input,
            },
            output,
          )
          const note = output.output.trim()
          return note ? [note] : []
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: BatouScanner.Service,
  layer,
  deps: [Location.node],
})
