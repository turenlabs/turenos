import { expect, test } from "bun:test"

for (const operation of ["archive", "delete"]) {
  for (const outcome of ["success", "failure"]) {
    test(`timeline ${operation} ${outcome} updates only the route server's home index`, async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--conditions=solid",
          "--conditions=browser",
          "--preload",
          "./happydom.ts",
          "./test-browser/fixtures/timeline-session-menu.ts",
          operation,
          outcome,
        ],
        { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
      )
      const [status, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ status, errors }).toEqual({ status: 0, errors: "" })
      expect(output).toEndWith(`timeline ${operation} ${outcome} checks passed\n`)
    }, 30_000)
  }
}
