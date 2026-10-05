import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

// The full application's route requirements are supplied by its assembled layers.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, { headers: { "x-forge-directory": directory } }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("PTY authorization preflight through the full application", () => {
  test("rejects an invalid ticket before looking up a missing PTY", async () => {
    await using dir = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const response = await request("/api/pty/pty_missing/connect?ticket=invalid", dir.path)
    expect(response.status).toBe(403)
    expect(await response.text()).toBe("")
  })

  test("does not boot Location services for an invalid ticket", async () => {
    await using dir = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using marker = await tmpdir({ config: { formatter: false, lsp: false } })
    expect((await request("/api/pty/pty_missing/connect?ticket=invalid", dir.path)).status).toBe(403)

    // The real file logger batches writes. Wait for a later request's log as a
    // flush barrier, matching httpapi-v2-pty.test.ts, without changing logging.
    expect((await request("/path", marker.path)).status).toBe(200)
    const log = path.join(process.env["XDG_DATA_HOME"]!, "forge", "log", "forge.log")
    const lines = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const lines = (
            await Bun.file(log)
              .text()
              .catch(() => "")
          ).split("\n")
          return lines.some((line) => line.includes("creating instance") && line.includes(marker.path))
            ? lines
            : undefined
        }),
        "File logger did not flush the marker request",
        "10 seconds",
      ),
    )
    const boots = lines.filter((line) => line.includes("booting location services") && line.includes(dir.path))
    expect(boots).toEqual([])
  })
})
