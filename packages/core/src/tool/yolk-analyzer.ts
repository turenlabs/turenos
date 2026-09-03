export * as YolkAnalyzer from "./yolk-analyzer"

import { Cause, Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { createYolkRuntime, formatSemanticDiff, hasYolkChanges, type InspectInput } from "../yolk"
import { Tool } from "./tool"
import type { ToolInterceptor } from "./interceptor"
import { EventV2 } from "../event"
import { Watcher } from "../filesystem/watcher"

export interface Interface {
  readonly inspect: (input: InspectInput) => Effect.Effect<string, Tool.Failure>
  readonly before: (event: ToolInterceptor.BeforeEvent) => Effect.Effect<void>
  readonly after: (event: ToolInterceptor.AfterEvent) => Effect.Effect<string | undefined>
  readonly discard: (event: ToolInterceptor.Identity) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/YolkAnalyzer") {}

const key = (event: { sessionID: string; assistantMessageID: string }) =>
  `${event.sessionID}:${event.assistantMessageID}`

function changedPaths(event: ToolInterceptor.Identity & { input?: unknown }) {
  if (!event.input || typeof event.input !== "object") return []
  const input = event.input as Record<string, unknown>
  const paths = typeof input.path === "string" ? [input.path] : []
  if (typeof input.patchText !== "string") return paths
  return [
    ...paths,
    ...[...input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!),
  ]
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const events = yield* EventV2.Service
    const runtime = createYolkRuntime(location.directory)
    yield* Effect.addFinalizer(() => Effect.promise(runtime.dispose).pipe(Effect.ignore))
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== location.directory)
        return Effect.void
      const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
      return Effect.sync(() => runtime.invalidate([data.file]))
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({
      inspect: (input) =>
        Effect.tryPromise({
          try: (signal) => runtime.inspect(input, signal).then((report) => JSON.stringify(report, null, 2)),
          catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
        }),
      before: (event) =>
        Effect.tryPromise({
          try: (signal) => runtime.before(key(event), signal),
          catch: errorMessage,
        }).pipe(
          Effect.tapError(() => Effect.sync(() => runtime.discard(key(event)))),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Yolk pre-edit snapshot failed", { cause }),
          ),
        ),
      after: (event) => {
        runtime.invalidate(changedPaths(event))
        if (event.denied) {
          runtime.discard(key(event), changedPaths(event))
          return Effect.succeed(undefined)
        }
        return Effect.tryPromise({
          try: (signal) => runtime.after(key(event), signal),
          catch: errorMessage,
        }).pipe(
          Effect.map((report) => (report && hasYolkChanges(report) ? formatSemanticDiff(report) : undefined)),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("Yolk post-edit comparison failed", { cause }).pipe(Effect.as(undefined)),
          ),
        )
      },
      discard: (event) => Effect.sync(() => runtime.discard(key(event), changedPaths(event))),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node, EventV2.node] })
