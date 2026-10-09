import { describe, expect, test } from "bun:test"
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const key = Buffer.alloc(32, 7).toString("base64")
const wrongKey = Buffer.alloc(32, 9).toString("base64")
const password = "persistent-http-password"
const cli = path.resolve(import.meta.dir, "../../src/index.ts")

async function setup(root: string) {
  const sockets = path.join(await realpath(root), "sockets")
  await mkdir(sockets, { mode: 0o700 })
  await chmod(sockets, 0o700)
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
    TEST_SOCKET_DIRECTORY: sockets,
    NODE_ENV: "production",
    FORGE_SERVER_MODE: "persistent",
    FORGE_PERSISTENT_UNIT: "1",
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

let socketSequence = 0
function serve(env: Record<string, string>, ...extra: string[]) {
  return Bun.spawn(
    [
      process.execPath,
      cli,
      "serve",
      "--key-source",
      "systemd-credentials",
      "--port",
      "0",
      ...(extra.includes("--socket-path")
        ? []
        : ["--socket-path", path.join(env.TEST_SOCKET_DIRECTORY, `${++socketSequence}.sock`)]),
      ...extra,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
}

async function listening(child: ReturnType<typeof serve>) {
  const reader = child.stdout.getReader()
  let output = ""
  while (true) {
    const next = await reader.read()
    if (next.done) throw new Error(`serve exited before listening: ${output}${await new Response(child.stderr).text()}`)
    output += new TextDecoder().decode(next.value)
    const url = /listening on unix:(\S+)/.exec(output)?.[1]
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

/** A persistent configuration error exits 78 with one line on stderr naming what to fix. */
async function configFailure(child: ReturnType<typeof serve>) {
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited).toBe(78)
  expect(stdout).not.toContain("listening on")
  expect(
    stderr
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("heap watchdog")),
  ).toHaveLength(1)
  return stderr
}

describe("persistent forge serve", () => {
  test("holds the owner lock, keeps secrets out of the environment, and rejects wrong key bytes", async () => {
    await using tmp = await tmpdir()
    const { dirs, env } = await setup(tmp.path)

    const first = serve(env)
    try {
      const socketPath = await listening(first)
      const health = new URL("/global/health", "http://localhost")
      expect((await fetch(health, { unix: socketPath })).status).toBe(401)
      const authorization = `Basic ${btoa(`forge:${password}`)}`
      expect((await fetch(health, { unix: socketPath, headers: { authorization } })).status).toBe(200)

      const descriptor = await (
        await fetch("http://localhost/global/server", { unix: socketPath, headers: { authorization } })
      ).json()
      expect(descriptor).toMatchObject({
        serverID: "persistent-test",
        keyID: "host-key",
        mode: "persistent",
        keySource: "systemd-credentials",
        listener: `unix:${socketPath}`,
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
    expect(await failure(serve({ ...env, FORGE_SERVER_PASSWORD: password }))).toContain(
      "must not be set in the initial environment: FORGE_SERVER_PASSWORD",
    )
  }, 90_000)

  test("exits 78 with a one-line message for every configuration error", async () => {
    await using tmp = await tmpdir()
    const { env } = await setup(tmp.path)
    const without = (name: string) => Object.fromEntries(Object.entries(env).filter((entry) => entry[0] !== name))

    expect(await configFailure(serve(without("FORGE_PERSISTENT_UNIT")))).toContain(
      "re-run `forge persistent install --apply` with this forge binary",
    )
    expect(await configFailure(serve({ ...env, FORGE_PERSISTENT_UNIT: "0" }))).toContain(
      "re-run `forge persistent install --apply` with this forge binary",
    )
    expect(await configFailure(serve({ ...env, FORGE_SECRET_VAULT_KEY: key }))).toContain(
      "must not be set in the initial environment",
    )
    expect(await configFailure(serve({ ...env, FORGE_SERVER_PASSWORD: password }))).toContain(
      "must not be set in the initial environment: FORGE_SERVER_PASSWORD",
    )
    expect(await configFailure(serve(without("CREDENTIALS_DIRECTORY")))).toContain(
      "systemd credential directory is unavailable",
    )
    expect(await configFailure(serve(without("FORGE_SERVER_PASSWORD_CREDENTIAL")))).toContain(
      "requires FORGE_SERVER_PASSWORD_CREDENTIAL",
    )
    expect(await configFailure(serve({ ...env, FORGE_SERVER_PASSWORD_CREDENTIAL: "missing-credential" }))).toContain(
      "cannot read the server password credential",
    )

    const broken = path.join(tmp.path, "broken-credentials")
    await mkdir(broken)
    await writeFile(path.join(broken, "forge-secret-vault-key-id"), "host-key\n")
    await writeFile(path.join(broken, "forge-server-password"), `${password}\n`)
    expect(await configFailure(serve({ ...env, CREDENTIALS_DIRECTORY: broken }))).toContain(
      "cannot read the secret vault key credential",
    )
    await writeFile(path.join(broken, "forge-secret-vault-key"), "not-a-key\n")
    expect(await configFailure(serve({ ...env, CREDENTIALS_DIRECTORY: broken }))).toContain(
      "secret vault key source contains invalid key material",
    )
  }, 90_000)

  test("refuses a non-loopback listener and mDNS with exit 78", async () => {
    await using tmp = await tmpdir()
    const { env } = await setup(tmp.path)

    expect(await configFailure(serve(env, "--hostname", "0.0.0.0"))).toContain("must listen on a loopback hostname")
    expect(await configFailure(serve(env, "--mdns"))).toContain("must listen on a loopback hostname")
    expect(await configFailure(serve(env, "--hostname", "127.0.0.1", "--mdns"))).toContain("must not publish over mDNS")
  }, 90_000)

  test("rejects TCP, unsafe socket parents, and existing targets with exit 78", async () => {
    await using tmp = await tmpdir()
    const { env } = await setup(tmp.path)
    expect(await configFailure(serve(env, "--socket-path", ""))).toContain("TCP listeners are not permitted")
    expect(await configFailure(serve(env, "--socket-path", "relative.sock"))).toContain("socket path must be absolute")
    await chmod(env.TEST_SOCKET_DIRECTORY, 0o770)
    expect(await configFailure(serve(env))).toContain("must not allow group or other write access")
    await chmod(env.TEST_SOCKET_DIRECTORY, 0o707)
    expect(await configFailure(serve(env))).toContain("must not allow group or other write access")
    await chmod(env.TEST_SOCKET_DIRECTORY, 0o700)
    const occupied = path.join(env.TEST_SOCKET_DIRECTORY, "occupied.sock")
    await writeFile(occupied, "keep")
    expect(await configFailure(serve(env, "--socket-path", occupied))).toContain("socket path already exists")
    expect(await Bun.file(occupied).text()).toBe("keep")
  }, 90_000)

  test("keeps the credential locations and key variables away from spawned processes", async () => {
    await using tmp = await tmpdir()
    const { env } = await setup(tmp.path)
    const dumped = path.join(tmp.path, "child-env")
    const child = serve(env)
    try {
      const socketPath = await listening(child)
      const response = await fetch("http://localhost/pty", {
        unix: socketPath,
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`forge:${password}`)}`,
          "content-type": "application/json",
          "x-forge-directory": tmp.path,
        },
        body: JSON.stringify({ command: "/bin/sh", args: ["-c", `env > ${dumped}`] }),
      })
      expect(response.status).toBe(200)
      let output = ""
      for (let attempt = 0; attempt < 100 && !output.includes("FORGE_PID"); attempt++) {
        output = await Bun.file(dumped)
          .text()
          .catch(() => "")
        await Bun.sleep(50)
      }
      expect(output).toContain("FORGE_PID")
      expect(output).not.toContain("CREDENTIALS_DIRECTORY")
      expect(output).not.toContain("FORGE_SERVER_PASSWORD")
      expect(output).not.toContain("FORGE_SECRET_VAULT_KEY")
    } finally {
      child.kill()
      await child.exited
    }
  }, 90_000)
})
