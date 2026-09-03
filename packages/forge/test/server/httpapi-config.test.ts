import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-forge-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "omits retired extension authority keys",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
        },
      })
      const headers = { "content-type": "application/json", "x-forge-directory": tmp.path }
      const listed = yield* Effect.promise(async () => app().request("/config", { headers }))
      const body = (yield* Effect.promise(() => listed.json())) as Record<string, unknown>
      for (const retired of ["mcp", "references"]) expect(body[retired]).toBeUndefined()

      for (const retired of ["mcp", "references"]) {
        const response = yield* Effect.promise(async () =>
          app().request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              formatter: false,
              lsp: false,
              [retired]: {},
            }),
          }),
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).not.toHaveProperty(retired)
      }

      // `provider` and `plugin` are not retired: provider configuration is written from
      // Settings and plugins are declared in config, so both have to survive a round trip.
      for (const kept of [{ provider: {} }, { plugin: [] }]) {
        const key = Object.keys(kept)[0]!
        const response = yield* Effect.promise(async () =>
          app().request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({ formatter: false, lsp: false, ...kept }),
          }),
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toHaveProperty(key)
      }
    }),
  )
})
