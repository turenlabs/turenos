import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("managed test override excludes native preferences", async () => {
  const { ConfigManaged } = await import("../../src/config/managed")
  expect(process.env.NODE_ENV).toBe("test")
  expect(process.env.FORGE_TEST_MANAGED_CONFIG_DIR).toBeTruthy()
  expect(await ConfigManaged.readManagedPreferences()).toBeUndefined()
})

test("actual runtime workload executes tools, reconciles retries, cancels providers, and tears down", async () => {
  await using hostile = await tmpdir({})
  const sentinel = "invalid host config sentinel"
  for (const directory of ["home/.forge", "config", "managed"]) {
    await fs.mkdir(path.join(hostile.path, directory), { recursive: true })
    await Bun.write(path.join(hostile.path, directory, "forge.json"), sentinel)
  }
  const before = (await fs.readdir(hostile.path, { recursive: true })).sort()
  const child = Bun.spawn(
    ["/bin/sh", "script/team-output-launch.sh", process.execPath, "runtime", "1", "1000", "250", "32768"],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOME: path.join(hostile.path, "home"),
        FORGE_TEST_HOME: path.join(hostile.path, "home"),
        FORGE_CONFIG: path.join(hostile.path, "config/forge.json"),
        FORGE_CONFIG_DIR: path.join(hostile.path, "config"),
        FORGE_CONFIG_CONTENT: sentinel,
        FORGE_TEST_MANAGED_CONFIG_DIR: path.join(hostile.path, "managed"),
        FORGE_PLUGIN_META_FILE: path.join(hostile.path, "plugin-meta.json"),
        FORGE_MODELS_PATH: path.join(hostile.path, "config/forge.json"),
        TUR_EN_SECRET_SENTINEL: "fake-secret-sentinel",
        OPENAI_API_KEY: "fake-secret-sentinel",
        AWS_SESSION_TOKEN: "fake-secret-sentinel",
        BASH_ENV: path.join(hostile.path, "missing-shell-startup"),
        ENV: path.join(hostile.path, "missing-shell-startup"),
        NODE_OPTIONS: "--no-warnings",
        BUN_OPTIONS: "fake-startup-sentinel",
      },
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
  expect((await fs.readdir(hostile.path, { recursive: true })).sort()).toEqual(before)
  for (const directory of ["home/.forge", "config", "managed"])
    expect(await Bun.file(path.join(hostile.path, directory, "forge.json")).text()).toBe(sentinel)
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
