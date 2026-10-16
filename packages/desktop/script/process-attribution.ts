import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { createHash, randomBytes } from "node:crypto"

export function prepareAttributionRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "turenos-attribution-")))
  const env: Record<string, string> = {}
  for (const name of ["HOME", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    env[name] = join(root, name.toLowerCase())
    mkdirSync(env[name]!, { mode: 0o700 })
  }
  env.FORGE_SECRET_VAULT_KEY_ID = "scratch-attribution"
  env.FORGE_SECRET_VAULT_KEY = randomBytes(32).toString("base64")
  writeFileSync(
    join(root, "isolation.json"),
    JSON.stringify({
      disposable: true,
      inheritedEnvironment: false,
      freshKeyBytes: 32,
      directoriesPrivate: Object.values(env)
        .slice(0, 6)
        .every((path) => (statSync(path).mode & 0o777) === 0o700),
      applicationImported: false,
      productionDataOpened: false,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  )
  return { root, env }
}

export async function hashAttributionSources() {
  return Object.fromEntries(
    await Promise.all(
      [
        "process-attribution.ts",
        "process-attribution-electron.cjs",
        "process-attribution-bun.ts",
        "../src/main/sidecar-supervisor.ts",
      ].map(async (file) => [
        file,
        createHash("sha256")
          .update(await Bun.file(join(import.meta.dir, file)).bytes())
          .digest("hex"),
      ]),
    ),
  )
}

if (import.meta.main) {
  const electron = process.argv[2]
  const idleMs = Number(process.argv[3] ?? 4000)
  if (!electron || !isAbsolute(electron) || !statSync(electron).isFile())
    throw new Error("Supply an existing absolute Electron binary path")
  if (!Number.isInteger(idleMs) || idleMs < 1000 || idleMs > 60000)
    throw new Error("Idle duration must be 1000-60000 ms")
  const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir, stdout: "pipe" })
  if (source.exitCode) throw new Error("Cannot identify source")
  const scratch = prepareAttributionRoot()
  const sourceHashes = await hashAttributionSources()
  writeFileSync(
    join(scratch.root, "source.json"),
    JSON.stringify({
      head: source.stdout.toString().trim(),
      sourceHashes,
      idleMs,
      sampleMs: 500,
      allocatedBytesPerTarget: 4 * 1024 * 1024,
    }) + "\n",
    { mode: 0o600 },
  )
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/main/sidecar-supervisor.ts")],
    target: "node",
    format: "cjs",
  })
  if (!build.success) throw new Error("Supervisor build failed")
  writeFileSync(join(scratch.root, "supervisor.cjs"), await build.outputs[0]!.text(), { mode: 0o600 })
  const fixture = Bun.spawn(
    [
      electron,
      join(import.meta.dir, "process-attribution-electron.cjs"),
      scratch.root,
      process.execPath,
      String(idleMs),
    ],
    {
      env: scratch.env,
      detached: true,
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const timer = setTimeout(() => {
    try {
      process.kill(-fixture.pid, "SIGKILL")
    } catch {
      /* Owned group already exited. */
    }
  }, idleMs + 20000)
  const rows: unknown[] = []
  try {
    const reader = fixture.stdout.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    let bytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new Error("Metric output limit exceeded")
      pending += decoder.decode(chunk.value, { stream: true })
      const lines = pending.split("\n")
      pending = lines.pop()!
      for (const line of lines.filter(Boolean)) rows.push(JSON.parse(line))
    }
    if (pending.trim() || (await fixture.exited)) throw new Error("Electron fixture failed; inspect private metrics")
    const records = rows as Record<string, unknown>[]
    if (
      !records.some((row) => row.role === "lifecycle" && row.passed === true) ||
      !records.some((row) => row.role === "identity" && row.profileIsolated === true) ||
      !["bun-fixture", "electron-main", "renderer", "renderer-heap"].every((role) =>
        records.some((row) => row.role === role),
      )
    ) {
      throw new Error("Required process attribution or lifecycle evidence is missing")
    }
  } finally {
    clearTimeout(timer)
    try {
      process.kill(-fixture.pid, "SIGKILL")
    } catch {
      /* Only the owned fixture group is targeted. */
    }
    await fixture.exited
    writeFileSync(
      join(scratch.root, "metrics.ndjson"),
      rows
        .map((row) =>
          JSON.stringify({
            sourceHead: source.stdout.toString().trim(),
            controllerBun: Bun.version,
            ...(row as object),
          }),
        )
        .join("\n") + "\n",
      { mode: 0o600 },
    )
    console.log(JSON.stringify({ root: scratch.root, rows: rows.length, electronExit: fixture.exitCode }))
  }
}
