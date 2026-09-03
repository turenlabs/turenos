import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { configErrorMessage } from "@/util/error"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@forge/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

/**
 * A defect's own account of itself, plus any errno underneath it.
 *
 * `NamedError` subclasses pass their *name* to `Error`, so `.message` on a `ConfigInvalidError` is
 * the literal string "ConfigInvalidError" and every structured issue -- which key, which file, what
 * was wrong with it -- sits unread on `.data`. `configErrorMessage` is the formatter that already
 * knows how to spell those out, so it gets first refusal before the generic path runs.
 */
function describe(defect: unknown): string {
  const structured = configErrorMessage(defect)
  if (structured) return structured
  if (!(defect instanceof Error)) return typeof defect === "string" ? defect : "unknown error"
  const parts = [defect.message]
  const code = (defect as { code?: unknown }).code
  if (typeof code === "string" && !parts.includes(code)) parts.push(code)
  const cause = (defect as { cause?: unknown }).cause
  if (cause instanceof Error && !parts.includes(cause.message)) parts.push(cause.message)
  return parts.filter(Boolean).join(": ") || "unknown error"
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    // `load` declares no error channel, so everything it can go wrong with
    // arrives as a defect — an unreadable directory (macOS denies these for
    // ~/Documents and friends until consent is given), a missing path, a failed
    // bootstrap. Uncaught, that left the request as a 503 with an empty body,
    // which tells the user nothing and tells a log even less.
    const loaded = yield* store.load({ directory }).pipe(
      Effect.map((ctx) => ({ ok: true as const, ctx })),
      Effect.catchDefect((defect) => Effect.succeed({ ok: false as const, defect })),
    )
    if (!loaded.ok) {
      yield* Effect.logError("failed to load instance for request", { directory, defect: describe(loaded.defect) })
      return HttpServerResponse.text(`Cannot open ${directory}: ${describe(loaded.defect)}`, {
        status: 503,
        contentType: "text/plain; charset=utf-8",
      })
    }
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, loaded.ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
