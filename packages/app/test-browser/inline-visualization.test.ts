import { expect, test } from "bun:test"

test("registered inline tools render their completed content in the transcript wrapper", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=solid",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/inline-visualization.ts",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output).toEndWith("inline visualization checks passed\n")
}, 30_000)
