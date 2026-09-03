import { Effect, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationError, LocationServices } from "@turenlabs/core/location-services"
import { PluginTrust } from "@turenlabs/core/plugin/trust"
import { ProjectV2 } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/schema/schema"

/**
 * Records the approval a person would give in the trust dialog for a test project's plugin files.
 *
 * Plugins and tools that live in the opened directory do not run until the exact bytes on disk are
 * approved, so a test that needs one to load has to answer that prompt first. This drives the real
 * `PluginTrust` service rather than replacing it, so the gate stays live and only the human answer
 * is supplied -- and it writes the decision directly instead of going through the HTTP endpoint,
 * whose handler reopens every instance and would tear down whatever the test has already built.
 *
 * Call it after the project's files are final and before the first request opens the instance: the
 * decision is bound to a fingerprint of those bytes, and anything written afterwards invalidates it.
 */
export const trustProject = (directory: string) =>
  Effect.gen(function* () {
    const trust = yield* PluginTrust.Service
    const status = yield* trust.status({ directory, root: directory })
    if (status.status !== "pending") return status.status
    const decided = yield* trust
      .decide({ directory, root: directory, fingerprint: status.fingerprint, decision: "allow" })
      .pipe(Effect.orDie)
    return decided.status
  }).pipe(Effect.provide(AppNodeBuilder.build(PluginTrust.node)))

export const PluginTrustTest = {
  projects: Layer.mock(ProjectV2.Service)({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
  locations: Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make(() => Layer.empty as Layer.Layer<LocationServices, LocationError>, { idleTimeToLive: "1 minute" }),
  ),
  layer: Layer.succeed(
    PluginTrust.Service,
    PluginTrust.Service.of({
      status: (input) => Effect.succeed({ status: "none", root: AbsolutePath.make(input.root), files: [] }),
      decide: (input) =>
        Effect.succeed({
          status: input.decision === "allow" ? "trusted" : "denied",
          root: AbsolutePath.make(input.root),
          fingerprint: input.fingerprint,
          files: [],
        }),
    }),
  ),
}
