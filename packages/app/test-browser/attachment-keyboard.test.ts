import { expect, test } from "bun:test"

test("attachment cards support focus and one action per keyboard activation", async () => {
  const child = Bun.spawn([
    process.execPath, "--conditions=solid", "--conditions=browser", "--preload", "./happydom.ts",
    "./test-browser/fixtures/attachment-keyboard.ts",
  ], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" })
  const [status, output, errors] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output).toBe("attachment keyboard checks passed\n")
}, 30_000)
