import { expect, test } from "bun:test"
import { readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { hashAttributionSources, prepareAttributionRoot } from "./process-attribution"

test("source identity hashes every launch file without starting Electron", async () => {
  const hashes = await hashAttributionSources()
  expect(Object.keys(hashes)).toEqual([
    "process-attribution.ts",
    "process-attribution-electron.cjs",
    "process-attribution-bun.ts",
    "../src/main/sidecar-supervisor.ts",
  ])
  for (const [file, hash] of Object.entries(hashes)) {
    expect(hash).toBe(Bun.CryptoHasher.hash("sha256", await Bun.file(join(import.meta.dir, file)).bytes(), "hex"))
  }
})

test("scratch preparation isolates every data directory and creates a fresh private key", () => {
  const first = prepareAttributionRoot()
  const second = prepareAttributionRoot()
  try {
    expect(first.env.FORGE_SECRET_VAULT_KEY).not.toBe(second.env.FORGE_SECRET_VAULT_KEY)
    expect(Buffer.from(first.env.FORGE_SECRET_VAULT_KEY!, "base64").length).toBe(32)
    expect(first.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(first.env.PATH).toBeUndefined()
    for (const name of ["HOME", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      expect(first.env[name]!.startsWith(first.root + "/")).toBe(true)
      expect(statSync(first.env[name]!).mode & 0o777).toBe(0o700)
    }
    expect(statSync(first.root).mode & 0o777).toBe(0o700)
    expect(statSync(join(first.root, "isolation.json")).mode & 0o777).toBe(0o600)
    const receipt = readFileSync(join(first.root, "isolation.json"), "utf8")
    expect(receipt).not.toContain(first.env.FORGE_SECRET_VAULT_KEY!)
    expect(JSON.parse(receipt).directoriesPrivate).toBe(true)
  } finally {
    rmSync(first.root, { recursive: true })
    rmSync(second.root, { recursive: true })
  }
})

test("owned Bun fixture reports allocation and release, then exits", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "process-attribution-bun.ts")], {
    env: {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const timer = setTimeout(() => child.kill(), 5000)
  try {
    child.stdin.write("stop\n")
    child.stdin.end()
    const rows = (await new Response(child.stdout).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(await child.exited).toBe(0)
    expect(rows.map((row) => row.phase)).toEqual(["allocated", "released"])
    expect(rows.every((row) => row.pid === child.pid && row.parentPid === process.pid)).toBe(true)
    expect(rows.every((row) => row.rss > 0 && row.external >= 0 && row.nativeAllocationBytes === null)).toBe(true)
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
})
