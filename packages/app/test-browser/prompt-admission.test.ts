import { expect, test } from "bun:test"

test("prompt admission survives uncertain HTTP delivery and renderer lifecycles", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=solid", "--conditions=browser", "./test-browser/fixtures/prompt-admission.ts"],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  )
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output).toEndWith("prompt admission lifecycle checks passed\n")
}, 30_000)
