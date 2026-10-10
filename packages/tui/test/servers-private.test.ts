import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { scratch, server, desktop, local, open, cleanup, persistent } from "./servers-fixture"

describe("private headless server", () => {
  async function fakeForge(body: string) {
    const directory = await scratch()
    const script = join(directory, "forge")
    await writeFile(script, `#!${process.execPath}\n${body}`)
    await chmod(script, 0o755)
    return script
  }

  test("starts forge serve with a generated password and reuses it", async () => {
    const forge = await fakeForge(`
if (process.argv[2] !== "serve") process.exit(2)
const password = process.env.FORGE_SERVER_PASSWORD
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
  request.headers.get("authorization") === "Basic " + btoa("forge:" + password)
    ? Response.json({ healthy: true, version: "9.9.9" })
    : new Response(null, { status: 401 }) })
console.log("forge server listening on http://127.0.0.1:" + listener.port)
`)
    const servers = local(await scratch(), { forge })
    cleanup.push(() => servers.stopHeadless())
    const entry = (await servers.scan()).find((item) => item.target.kind === "headless")!
    const endpoint = await open(servers, entry.target)
    expect(endpoint.version).toBe("9.9.9")
    expect(endpoint.password).toHaveLength(32)
    expect((await open(servers, entry.target)).url).toBe(endpoint.url)
    expect((await servers.scan()).find((item) => item.target.kind === "headless")?.detail).toStartWith("Running · port")
  })

  test("a private server that exits is no longer offered as running", async () => {
    const forge = await fakeForge(`
const password = process.env.FORGE_SERVER_PASSWORD
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
  request.headers.get("authorization") === "Basic " + btoa("forge:" + password)
    ? Response.json({ healthy: true, version: "9.9.9" })
    : new Response(null, { status: 401 }) })
console.log("forge server listening on http://127.0.0.1:" + listener.port)
setTimeout(() => process.exit(0), 1500)
`)
    const servers = local(await scratch(), { forge })
    cleanup.push(() => servers.stopHeadless())
    const detail = async () => (await servers.scan()).find((item) => item.target.kind === "headless")!.detail
    await open(servers, (await servers.scan()).find((item) => item.target.kind === "headless")!.target)
    expect(await detail()).toStartWith("Running")
    for (let wait = 0; wait < 50 && (await detail()).startsWith("Running"); wait++) await Bun.sleep(100)
    expect(await detail()).toStartWith("forge serve from")
  })

  test("explains a missing vault key", async () => {
    const forge = await fakeForge(
      `console.error("Error: Persistent secret storage requires an OS-protected key"); process.exit(1)`,
    )
    const servers = local(await scratch(), { forge })
    const entry = (await servers.scan()).find((item) => item.target.kind === "headless")!
    await expect(servers.resolve(entry.target)).rejects.toThrow("Set FORGE_SECRET_VAULT_KEY_ID")
  })

  test("a desktop that predates attach records is detected by its single-instance lock", async () => {
    const home = await scratch()
    const directory = join(home, "Library", "Application Support", "com.turenlabs.forge")
    await mkdir(directory, { recursive: true })
    await symlink(`${hostname()}-${process.pid}`, join(directory, "SingletonLock"))
    const servers = local(home, { forge: await fakeForge(`process.exit(1)`) })
    const entries = await servers.scan()
    expect(entries.map((entry) => entry.target.kind)).toEqual(["headless"])
    expect(servers.problems()).toEqual([
      "TurenOS is running but does not publish its server. Update it to connect from here.",
    ])
    await expect(servers.resolve(entries[0]!.target)).rejects.toThrow("TurenOS is running and owns your local data")
    // A CLI pointed at other data does not share the desktop's database.
    const elsewhere = local(home, { forge: await fakeForge(`process.exit(1)`), env: { XDG_DATA_HOME: home } })
    await expect(elsewhere.resolve(entries[0]!.target)).rejects.toThrow("forge serve did not start")
    // Another host's lock, as on a shared home directory, is not this machine's desktop.
    await rm(join(directory, "SingletonLock"))
    await symlink(`elsewhere.example-${process.pid}`, join(directory, "SingletonLock"))
    await servers.scan()
    expect(servers.problems()).toEqual([])
  })

  test("refuses to open the desktop's data while the desktop is running", async () => {
    const home = await scratch()
    const listener = server()
    await desktop(home, listener.url.origin)
    const forge = await fakeForge(`process.exit(1)`)
    const servers = local(home, { forge })
    const entry = (await servers.scan()).find((item) => item.target.kind === "headless")!
    await expect(servers.resolve(entry.target)).rejects.toThrow("TurenOS is running and owns your local data")
  })
})

describe("record identity", () => {
  const hour = 3600 * 1000

  async function age(file: string, ms: number) {
    const time = new Date(Date.now() - ms)
    await utimes(file, time, time)
  }

  test("a desktop record last written before its pid started is not trusted or sent credentials", async () => {
    const home = await scratch()
    let requests = 0
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return Response.json({ healthy: true })
      },
    })
    cleanup.push(() => listener.stop(true))
    // This test process started seconds ago, so a record a day old predates it: the pid was reused.
    await age(await desktop(home, listener.url.origin), 24 * hour)
    expect(await local(home).scan()).toEqual([])
    expect(requests).toBe(0)
  })

  test("a record written after its process started is trusted", async () => {
    const home = await scratch()
    await desktop(home, server().url.origin)
    expect(await local(home).scan()).toHaveLength(1)
  })

  test("a quick-connect state older than its pid is ignored", async () => {
    const home = await scratch()
    const run = join(home, ".forge", "run")
    await mkdir(run, { recursive: true })
    for (const [name, value] of [
      ["server.pid", String(process.pid)],
      ["server.port", "4321"],
      ["server.auth", "secret"],
    ] as const) {
      await writeFile(join(run, name), value, { mode: 0o600 })
      await age(join(run, name), 24 * hour)
    }
    expect(await local(home).scan()).toEqual([])
  })

  test("a quick-connect port file older than its pid is ignored", async () => {
    const home = await scratch()
    const run = join(home, ".forge", "run")
    await mkdir(run, { recursive: true })
    for (const [name, value] of [
      ["server.pid", String(process.pid)],
      ["server.port", "4321"],
      ["server.auth", "secret"],
    ] as const)
      await writeFile(join(run, name), value, { mode: 0o600 })
    expect(await local(home).scan()).toHaveLength(1)
    await age(join(run, "server.port"), 24 * hour)
    expect(await local(home).scan()).toEqual([])
  })

  /** The persistent server's record names srv_1; the server on its socket describes itself as `descriptor`, or 404s. */
  async function described(descriptor?: Record<string, unknown>) {
    const home = await scratch()
    const socket = join(home, "server.sock")
    server("secret", descriptor ? { "/global/server": descriptor } : {}, socket)
    return persistent(home, socket)
  }

  test("a server whose serverID differs from the record's is refused", async () => {
    const servers = await described({ serverID: "srv_other", mode: "persistent" })
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
  })

  test("a server whose descriptor carries no serverID is refused", async () => {
    const servers = await described({ mode: "persistent" })
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
  })

  test("a server that names the record's serverID but is not persistent is refused", async () => {
    const servers = await described({ serverID: "srv_1", mode: "quick-connect" })
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
  })

  test("a persistent server whose serverID matches the record's is accepted", async () => {
    const servers = await described({ serverID: "srv_1", mode: "persistent" })
    expect((await servers.resolve((await servers.preferred())!)).version).toBe("1.0.32")
  })

  test("a server that answers 404 for its descriptor is refused when the record names a serverID", async () => {
    const servers = await described()
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
  })
})

test.each(["SIGTERM", "SIGHUP", "SIGINT"] as const)("private servers and tunnels are stopped when this client receives %s", async (signal) => {
  const directory = await scratch()
  const script = `
import { writeFileSync } from "node:fs"
import { running } from ${JSON.stringify(new URL("../src/servers/processes.ts", import.meta.url).href)}
const child = Bun.spawn(["sleep", "30"])
running.add(child)
writeFileSync(process.env.TUI_TEST_PID_FILE, String(child.pid))
await Bun.sleep(10_000)
`
  const file = join(directory, "child.pid")
  const client = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, TUI_TEST_PID_FILE: file },
    stdout: "ignore",
    stderr: "pipe",
  })
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  let pid = 0
  try {
    while (!pid) {
      pid = Number(await readFile(file, "utf8").catch(() => "0"))
      if (!pid) await Bun.sleep(20)
    }
    expect(alive(pid)).toBe(true)
    client.kill(signal)
    await client.exited
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL")
    client.kill()
  }
})
