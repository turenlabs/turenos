import { expect, test } from "bun:test"

test("security proxy preserves paged history, Repeater drafts, diffs, and complete exports", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=solid",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/security-proxy.ts",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output).toEndWith("security proxy checks passed\n")
}, 30_000)
