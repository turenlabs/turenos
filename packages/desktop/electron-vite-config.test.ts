import { expect, test } from "bun:test"

// The config reads the Sentry environment at import time, so each case imports its own copy.
async function load(tag: string, sentry: boolean, command: "build" | "serve") {
  const keys = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"] as const
  const previous = keys.map((key) => process.env[key])
  keys.forEach((key) => {
    if (sentry) process.env[key] = "test"
    if (!sentry) delete process.env[key]
  })
  const module = await import(`./electron.vite.config.ts?${tag}`).finally(() => {
    keys.forEach((key, index) => {
      const value = previous[index]
      if (value === undefined) delete process.env[key]
      if (value !== undefined) process.env[key] = value
    })
  })
  if (typeof module.default !== "function") return module.default
  return module.default({ command, mode: command === "build" ? "production" : "development" })
}

test("production builds minify main, preload and renderer", async () => {
  const config = await load("minify", false, "build")
  expect(config.main.build.minify).toBeTruthy()
  expect(config.preload.build.minify).toBeTruthy()
  expect(config.renderer.build.minify).toBeTruthy()
})

test("dev keeps main and preload output readable", async () => {
  const config = await load("dev", false, "serve")
  expect(config.main.build.minify).toBeFalsy()
  expect(config.preload.build.minify).toBeFalsy()
  expect(config.renderer.build.minify).toBeFalsy()
})

test("renderer maps are generated only when the Sentry plugin will upload them", async () => {
  expect((await load("no-sentry", false, "build")).renderer.build.sourcemap).toBeFalsy()
  expect((await load("sentry", true, "build")).renderer.build.sourcemap).toBe("hidden")
})
