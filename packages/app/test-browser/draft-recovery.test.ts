import { expect, test } from "bun:test"

test("draft recovery preserves persisted content across tab and renderer lifecycles", async () => {
  // Isolate the JSX compiler from other browser-condition tests and their mocks.
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=solid",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/draft-recovery.ts",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output).toEndWith("draft recovery lifecycle checks passed\n")
}, 30_000)
