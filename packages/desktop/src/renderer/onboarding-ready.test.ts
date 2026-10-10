import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("release notes wait for onboarding evaluation and persisted completion", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      "--conditions=solid",
      "--preload",
      "../app/happydom.ts",
      "./test-fixtures/onboarding-ready.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
  expect(stdout).toContain("onboarding ready gate: hidden, visible, completion, teardown verified")
})
