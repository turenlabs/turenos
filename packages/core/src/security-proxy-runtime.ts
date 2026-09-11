export * as SecurityProxyRuntime from "./security-proxy-runtime"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { SecurityProxy } from "@turenlabs/schema/security-proxy"

export class Error extends globalThis.Error {}

export interface Interface {
  readonly execute: (command: SecurityProxy.Command) => Effect.Effect<SecurityProxy.Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/SecurityProxyRuntime") {}

export const layer = (execute: Interface["execute"]) => Layer.succeed(Service, Service.of({ execute }))

export const unavailable = layer(() => Effect.fail(new Error("The desktop Security Browser is unavailable")))

export const node = makeLocationNode({ service: Service, layer: unavailable, deps: [] })
