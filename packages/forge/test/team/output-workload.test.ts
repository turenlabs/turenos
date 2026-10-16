import { expect, test } from "bun:test"

test("actual runtime workload executes tools, reconciles retries, cancels providers, and tears down", async () => {
  const child = Bun.spawn(
    [process.execPath, "run", "script/team-output-runtime-workload.ts", "1", "1000", "250", "32768"],
    {
      env: { ...process.env, NODE_ENV: "test", FORGE_TEST_KIMI: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 50_000,
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stderr).toBe(0)
  const rows = stdout.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return []
    const value = JSON.parse(line)
    return value.harnessSHA256 ? [value] : []
  })
  const summary = rows.find((row) => row.phase === "summary")
  expect(summary.counts).toEqual({
    factories: 1,
    cancelled: 1,
    tools: 1,
    generatedToolBytes: 32768,
    providerCalls: 5,
    providerAborts: 1,
  })
  expect(summary.idleSamples).toBeGreaterThanOrEqual(3)
  expect(summary.durableBytes).toBeGreaterThan(0)
  expect(summary.nativeBytes).toBeNull()
  expect(rows.some((row) => row.phase === "services-disposed")).toBe(true)
  expect(rows.some((row) => row.phase === "post-cleanup")).toBe(true)
}, 60_000)
