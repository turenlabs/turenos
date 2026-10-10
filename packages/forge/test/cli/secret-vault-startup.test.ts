import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

describe("Headless serve vault bootstrap", () => {
  test("keeps a missing-key failure in the legacy runtime path for quick-connect", async () => {
    await using tmp = await tmpdir()
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          ![
            "FORGE_SERVER_MODE",
            "FORGE_SERVER_PASSWORD",
            "FORGE_SERVER_PASSWORD_CREDENTIAL",
            "FORGE_SECRET_VAULT_KEY_SOURCE",
            "FORGE_SECRET_VAULT_KEY_ID",
            "FORGE_SECRET_VAULT_KEY",
          ].includes(entry[0]),
      ),
    )
    Object.assign(env, {
      NODE_ENV: "production",
      FORGE_SERVER_MODE: "quick-connect",
      FORGE_DB: path.join(tmp.path, "forge.db"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    })
    const cli = path.resolve(import.meta.dir, "../../src/index.ts")
    const child = Bun.spawn([process.execPath, cli, "serve"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(await child.exited).not.toBe(0)
    expect(`${stdout}\n${stderr}`).toContain("Persistent secret storage requires an OS-protected key")
  }, 30_000)
})
