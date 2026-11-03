import { expect, test } from "bun:test"

for (const scenario of ["status", "replay", "live"]) {
  test(`session stream replay: ${scenario}`, async () => {
    // Isolate context mocks from the rest of the browser-condition suite.
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=solid",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "./test-browser/fixtures/session-stream-replay.ts",
        scenario,
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
}
