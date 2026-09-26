import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const key = Buffer.alloc(32, 7).toString("base64")
const wrongKey = Buffer.alloc(32, 9).toString("base64")
const password = "persistent-http-password"
const cli = path.resolve(import.meta.dir, "../../src/index.ts")

async function setup(root: string) {
  // Stand-ins for the directories systemd mounts at $CREDENTIALS_DIRECTORY.
  const credentials = async (name: string, vaultKey: string) => {
    const dir = path.join(root, name)
    await mkdir(dir)
    await writeFile(path.join(dir, "forge-secret-vault-key-id"), "host-key\n")
    await writeFile(path.join(dir, "forge-secret-vault-key"), `${vaultKey}\n`)
    await writeFile(path.join(dir, "forge-server-password"), `${password}\n`)
    return dir
  }
  const dirs = { right: await credentials("credentials", key), wrong: await credentials("wrong-credentials", wrongKey) }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !entry[0].startsWith("FORGE_SECRET_VAULT") &&
        !entry[0].startsWith("FORGE_SERVER"),
    ),
  )
  Object.assign(env, {
    NODE_ENV: "production",
    FORGE_SERVER_MODE: "persistent",
    FORGE_SERVER_ID: "persistent-test",
    FORGE_SERVER_PASSWORD_CREDENTIAL: "forge-server-password",
    CREDENTIALS_DIRECTORY: dirs.right,
    FORGE_DB: path.join(root, "forge.db"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  })
  return { dirs, env }
}

function serve(env: Record<string, string>) {
  return Bun.spawn([process.execPath, cli, "serve", "--key-source", "systemd-credentials", "--port", "0"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function listening(child: ReturnType<typeof serve>) {
  const reader = child.stdout.getReader()
  let output = ""
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error(`serve exited before listening: ${output}${await new Response(child.stderr).text()}`)
    output += new TextDecoder().decode(next.value)
    const url = /listening on (http:\/\/\S+)/.exec(output)?.[1]
    if (url) {
      reader.releaseLock()
      return url
    }
  }
}

async function failure(child: ReturnType<typeof serve>) {
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited).not.toBe(0)
  return `${stdout}\n${stderr}`
}

describe("persistent forge serve", () => {
  test("holds the owner lock, keeps secrets out of the environment, and rejects wrong key bytes", async () => {
    await using tmp = await tmpdir()
    const { dirs, env } = await setup(tmp.path)

    const first = serve(env)
    try {
      const url = await listening(first)
      const health = new URL("/global/health", url)
      expect((await fetch(health)).status).toBe(401)
      const authorization = `Basic ${btoa(`forge:${password}`)}`
      expect((await fetch(health, { headers: { authorization } })).status).toBe(200)

      const descriptor = await (await fetch(new URL("/global/server", url), { headers: { authorization } })).json()
      expect(descriptor).toMatchObject({
        serverID: "persistent-test",
        keyID: "host-key",
        mode: "persistent",
        keySource: "systemd-credentials",
        listener: url.replace(/\/$/, "") + "/",
        dataIdentity: { databasePath: env.FORGE_DB },
      })
      expect(JSON.stringify(descriptor)).not.toContain(password)

      if (process.platform !== "win32") {
        const ps = Bun.spawnSync(["ps", "eww", "-o", "command=", "-p", String(first.pid)])
        const listing = ps.stdout.toString()
        expect(listing).toContain("serve")
        expect(listing).not.toContain(key)
        expect(listing).not.toContain(password)
      }

      expect(await failure(serve(env))).toContain("Database is already owned by another server")
    } finally {
      first.kill()
      await first.exited
    }

    expect(await failure(serve({ ...env, CREDENTIALS_DIRECTORY: dirs.wrong }))).toContain(
      "Database secret verification failed",
    )
    expect(await failure(serve({ ...env, FORGE_SECRET_VAULT_KEY: key }))).toContain(
      "must not be set in the initial environment",
    )
  }, 90_000)
})
