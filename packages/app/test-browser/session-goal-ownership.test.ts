import { expect, test } from "bun:test"

test("goal ownership handles reactive server and session transitions", async () => {
  // Keep the SDK boundary mock separate from other browser-condition suites.
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=solid",
      "--conditions=browser",
      "--test-name-pattern",
      "goal ownership",
      "./src/pages/session/goal/session-goal-controller.test.ts",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, output, errors }).toMatchObject({ status: 0 })
}, 30_000)
