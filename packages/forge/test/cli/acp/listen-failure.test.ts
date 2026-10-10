import { expect, test } from "bun:test"
import { access } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

const cli = path.resolve(import.meta.dir, "../../../src/index.ts")
const worker = path.resolve(import.meta.dir, "../../../../core/test/fixture/database-owner-lock-worker.ts")

test("acp exits non-zero with the error on stderr when the database is owned by another server", async () => {
  await using tmp = await tmpdir()
  const database = path.join(tmp.path, "forge.db")
  const ready = path.join(tmp.path, "ready")
  const holder = Bun.spawn([process.execPath, worker, database, ready], { stdout: "ignore", stderr: "ignore" })
  try {
    for (let attempt = 0; attempt < 500 && (await access(ready).then(() => false, () => true)); attempt++)
      await Bun.sleep(10)

    const child = Bun.spawn([process.execPath, "run", "--conditions=browser", cli, "acp", "--port", "0"], {
      cwd: tmp.path,
      env: {
        ...process.env,
        FORGE_DB: database,
        FORGE_SECRET_VAULT_KEY_ID: "acp-test",
        FORGE_SECRET_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      },
      // A client that stays connected: only an exit on the listen failure ends the process.
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000)
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    clearTimeout(timeout)

    expect(child.signalCode).toBeNull()
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Database is already owned by another server")
    expect(stdout).toBe("")
  } finally {
    holder.kill("SIGKILL")
    await holder.exited
  }
}, 60_000)
