import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { NpmConfig } from "@turenlabs/core/npm-config"
import { tmpdir } from "./fixture/tmpdir"

describe("NpmConfig.load", () => {
  test("reads registry from project .npmrc", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.registry).toBe("https://registry.example.test/")
  })

  test("reads scoped registries from project .npmrc", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "@acme:registry=https://npm.acme.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config["@acme:registry"]).toBe("https://npm.acme.test/")
  })

  test("flattens boolean and list options", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "ignore-scripts=true\nomit[]=dev\nomit[]=optional\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.ignoreScripts).toBe(true)
    expect(config.omit).toEqual(["dev", "optional"])
  })

  // `@npmcli/config` writes `process.env.NODE_ENV = "production"` on the host process - not on the
  // env copy it is handed - as soon as the resolved config omits dev dependencies. Asking npm for a
  // registry URL must not move the whole process into production mode: the secret vault only offers
  // its ephemeral key while NODE_ENV is "test", so the leak turned every later vault build in the
  // same process into "Persistent secret storage requires an OS-protected key".
  test("does not leak npm's production NODE_ENV into the host process", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit[]=dev\n")
    const before = process.env.NODE_ENV

    await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(process.env.NODE_ENV).toBe(before)
  })
})

describe("NpmConfig.registry", () => {
  test("normalizes configured registry without trailing slash", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })

  test("leaves configured registry without trailing slash unchanged", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })
})
