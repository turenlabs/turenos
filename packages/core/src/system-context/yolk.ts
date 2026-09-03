export * as YolkSystemContext from "./yolk"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ExtensionRuntime } from "../extension"
import { SystemContext } from "./index"
import { SystemContextRegistry } from "./registry"

const extensionID = "turenlabs/yolk"
const policy = [
  "Yolk change-intelligence policy:",
  "- Treat Yolk as two capabilities: explicit pre-edit risk analysis through inspect_change, and automatic post-edit validation after write, edit, or apply_patch.",
  "- Yolk indexes named functions and methods and their static call graph. It does not observe Solid/React tracking, store reads inside callees, effects, or runtime dependency leaks. Do not use it to diagnose UI reopen loops, pending-navigation races, or other reactive bugs.",
  "- Use explicit inspection only for shared named functions with non-local callers, public contracts, and security, persistence, protocol, schema, parser, or filesystem domains. Skip it for UI routing, store mutations, isolated helpers, documentation, formatting, and tests.",
  "- If exact symbols are unknown, use read or grep to identify paths, then call inspect_change with paths. Retry once with exact returned symbols. Do not guess several names and never create probe files.",
  "- Unknown, partial, or incomplete-index results are not a diagnosis. Do not treat them as extra evidence, extra review work, or a reason to keep inspecting Yolk. Continue with code reading, exact fail-before/pass-after regressions, and focused review.",
  "- Treat an automatic semantic-change note as optional caller-review guidance for named functions, not proof of a defect and not a required checkpoint for UI or reactive work. Do not claim a bug is fixed from Yolk output.",
].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const extensions = yield* ExtensionRuntime.Service
    const registry = yield* SystemContextRegistry.Service
    yield* registry.register({
      key: SystemContext.Key.make("core/yolk-policy"),
      load: Effect.suspend(() => extensions.enabled(extensionID)).pipe(
        Effect.map((enabled) =>
          enabled
            ? SystemContext.make({
                key: SystemContext.Key.make("core/yolk-policy"),
                codec: Schema.toCodecJson(Schema.String),
                load: Effect.succeed(policy),
                baseline: String,
                update: (_previous, current) => current,
                removed: () => "Yolk is disabled; stop using inspect_change and ignore the Yolk-specific policy.",
              })
            : SystemContext.empty,
        ),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "system-context/yolk",
  layer,
  deps: [ExtensionRuntime.node, SystemContextRegistry.node],
})
