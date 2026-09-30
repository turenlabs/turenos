import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { Flag } from "@turenlabs/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  FORGE_SERVER_PASSWORD: Flag.FORGE_SERVER_PASSWORD,
  FORGE_SERVER_USERNAME: Flag.FORGE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.FORGE_SERVER_PASSWORD = original.FORGE_SERVER_PASSWORD
  Flag.FORGE_SERVER_USERNAME = original.FORGE_SERVER_USERNAME
  delete process.env.FORGE_SERVER_PASSWORD
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.FORGE_SERVER_PASSWORD = undefined
    Flag.FORGE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the forge username", () => {
    Flag.FORGE_SERVER_PASSWORD = "secret"
    Flag.FORGE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("forge:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.FORGE_SERVER_PASSWORD = "secret"
    Flag.FORGE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.FORGE_SERVER_PASSWORD = "secret"
    Flag.FORGE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("explicit protected credentials never become a global fallback", () => {
    Flag.FORGE_SERVER_PASSWORD = undefined
    Flag.FORGE_SERVER_USERNAME = undefined
    expect(ServerAuth.headers({ password: "file-secret" })).toEqual({
      Authorization: `Basic ${Buffer.from("forge:file-secret").toString("base64")}`,
    })
    expect(ServerAuth.header()).toBeUndefined()
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secre") }, config)).toBe(false)
    expect(
      ServerAuth.authorized(
        { username: "alice", password: Redacted.make("secret") },
        { ...config, password: Option.none() },
      ),
    ).toBe(false)
  })

  test("claimPassword removes the password from the environment but keeps auth enforced", async () => {
    Flag.FORGE_SERVER_PASSWORD = undefined
    process.env.FORGE_SERVER_PASSWORD = "claimed-secret"

    expect(ServerAuth.claimPassword()).toBe("claimed-secret")
    expect(process.env.FORGE_SERVER_PASSWORD).toBeUndefined()
    expect(ServerAuth.header()).toBe(`Basic ${Buffer.from("forge:claimed-secret").toString("base64")}`)
    // The in-process handler reads the environment after the claim; it must not see an unsecured server.
    const config = await Effect.runPromise(
      ServerAuth.Config.useSync((value) => value).pipe(
        Effect.provide(ServerAuth.Config.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))),
      ),
    )
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "forge", password: Redacted.make("claimed-secret") }, config)).toBe(true)
  })
})
