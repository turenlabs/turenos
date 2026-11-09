import { expect, test } from "bun:test"

test("persisted file attachments render as safe cards", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=solid",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/sent-file-cards.ts",
    ],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output).toEndWith("sent file cards checks passed\n")
}, 30_000)
