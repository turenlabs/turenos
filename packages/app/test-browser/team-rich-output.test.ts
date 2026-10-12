import { expect, test } from "bun:test"

test("Team rich output loads near the viewport and preserves text, previews, and successful output", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=solid",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/team-rich-output.ts",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output).toEndWith("Team rich output checks passed\n")
}, 30_000)
