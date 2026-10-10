import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// Isolate context mocks and Solid's browser export from the unit-suite module cache.
test("latest runs remain scoped to the selected server", async () => {
  const app = fileURLToPath(new URL("../../../", import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=solid",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-fixtures/latest-runs.browser.test.ts",
    ],
    { cwd: app, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
}, 30_000)
