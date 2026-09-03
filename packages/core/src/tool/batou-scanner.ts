export * as BatouScanner from "./batou-scanner"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import type { ToolInterceptor } from "./interceptor"

export interface Interface {
  readonly before: (event: ToolInterceptor.BeforeEvent) => Effect.Effect<string | undefined>
  readonly after: (event: ToolInterceptor.AfterEvent) => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/BatouScanner") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    before: () => Effect.succeed(undefined),
    after: () => Effect.succeed([]),
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
