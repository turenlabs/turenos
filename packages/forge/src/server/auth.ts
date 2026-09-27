export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@turenlabs/core/flag/flag"
import { createHash, timingSafeEqual } from "node:crypto"
import { Config as EffectConfig, Context, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export class ListenerCredentials extends Context.Service<ListenerCredentials, Credentials>()(
  "@forge/ListenerCredentials",
) {}

export const listenerLayer = (credentials: Credentials) =>
  Layer.succeed(ListenerCredentials)(ListenerCredentials.of(credentials))

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@forge/ServerAuthConfig", {
  password: EffectConfig.string("FORGE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("FORGE_SERVER_USERNAME").pipe(EffectConfig.withDefault("forge")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  if (Option.isNone(config.password)) return false
  // Compare fixed-length digests so response time doesn't reveal how much of a guess matched.
  const username = safeEqual(credentials.username, config.username)
  const password = safeEqual(Redacted.value(credentials.password), config.password.value)
  return username && password
}

function safeEqual(a: string, b: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest()
  return timingSafeEqual(digest(a), digest(b))
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.FORGE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.FORGE_SERVER_USERNAME ?? "forge"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
