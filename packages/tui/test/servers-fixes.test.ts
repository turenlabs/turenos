import { describe, expect, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Target } from "../src/servers"
import { cleanup, desktop, local, open, scratch, server } from "./servers-fixture"

const PASSWORD = "synthetic-password"
const uid = process.getuid!()
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

describe("persistent attach record", () => {
  test("a missing record reads as the user-facing message, not a raw ENOENT", async () => {
    const home = await scratch()
    const servers = local(home, {
      platform: "linux",
      uid: undefined,
      persistentRecord: join(home, "absent.json"),
      persistentSocket: join(home, "server.sock"),
    })
    const failure = await servers.resolve({ kind: "persistent", id: "persistent", name: "Persistent" }).catch((e) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain("attach record is missing or unreadable")
    expect(failure.message).not.toContain("ENOENT")
  })
})

describe("a saved URL server's password from the environment", () => {
  /** A synthetic server counting each request's credentials, and a servers list whose /proc says `owner` holds it. */
  async function loopback(owner: number) {
    const seen: (string | null)[] = []
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization"))
        return request.headers.get("authorization") === `Basic ${btoa(`forge:${PASSWORD}`)}`
          ? Response.json({ healthy: true, version: "1.0.32" })
          : new Response(null, { status: 401 })
      },
    })
    cleanup.push(() => listener.stop(true))
    const home = await scratch()
    const hex = listener.port!.toString(16).toUpperCase().padStart(4, "0")
    const row = `   0: 0100007F:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${owner}        0 1 1\n`
    const servers = local(home, {
      platform: "linux",
      uid,
      env: { TURENOS_TEST_PASSWORD: PASSWORD },
      persistentRecord: join(home, "absent.json"),
      readProc: (path) => (path.endsWith("tcp6") ? HEADER : HEADER + row),
    })
    const target: Target = {
      kind: "url",
      id: "saved:loopback",
      name: "loopback",
      url: listener.url.origin,
      passwordEnv: "TURENOS_TEST_PASSWORD",
      saved: false,
    }
    return { servers, target, seen }
  }

  test("another user's listener is refused and no credentials are sent", async () => {
    const { servers, target, seen } = await loopback(uid + 1)
    await expect(servers.resolve(target)).rejects.toThrow("belongs to another user")
    expect(seen).toEqual([])
  })

  test("a listener owned by this user receives the password", async () => {
    const { servers, target, seen } = await loopback(uid)
    expect((await servers.resolve(target)).password).toBe(PASSWORD)
    expect(seen).toContain(`Basic ${btoa(`forge:${PASSWORD}`)}`)
  })

  test("a typed password is not subject to the owner check", async () => {
    const { servers, target, seen } = await loopback(uid + 1)
    servers.remember(target, PASSWORD)
    expect((await servers.resolve(target)).password).toBe(PASSWORD)
    expect(seen).toContain(`Basic ${btoa(`forge:${PASSWORD}`)}`)
  })
})

describe("importing the desktop's SSH servers", () => {
  test("a desktop answering { state: null } clears servers imported earlier", async () => {
    const home = await scratch()
    const routes: Record<string, unknown> = {
      "/global/storage": {
        state: {
          value: JSON.stringify([{ id: "ssh:dad@10.0.0.4", host: "10.0.0.4", user: "dad", displayName: "eaw" }]),
        },
      },
    }
    await desktop(home, server("secret", routes).url.origin)
    const servers = local(home)
    const endpoint = await open(servers, (await servers.preferred())!)
    const imported = async () => {
      await servers.importDesktop(endpoint)
      return (await servers.scan()).filter((entry) => entry.group === "From TurenOS Desktop").map((e) => e.target.name)
    }
    expect(await imported()).toEqual(["eaw"])
    routes["/global/storage"] = { state: null }
    expect(await imported()).toEqual([])
  })
})

describe("reconnecting to the private server", () => {
  /** A forge whose first health answer is good and every later one is a 500, and which records its pid. */
  async function failingForge(pidFile: string) {
    const script = join(await scratch(), "forge")
    await writeFile(
      script,
      `#!${process.execPath}
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const password = process.env.FORGE_SERVER_PASSWORD
let answered = 0
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) =>
  request.headers.get("authorization") !== "Basic " + btoa("forge:" + password)
    ? new Response(null, { status: 401 })
    : answered++ === 0 ? Response.json({ healthy: true, version: "9.9.9" }) : new Response(null, { status: 500 }) })
console.log("forge server listening on http://127.0.0.1:" + listener.port)
`,
    )
    await chmod(script, 0o755)
    return script
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test("a running server that fails verification is killed and forgotten", async () => {
    const pidFile = join(await scratch(), "pid")
    const servers = local(await scratch(), { forge: await failingForge(pidFile) })
    cleanup.push(() => servers.stopHeadless())
    const headless = async () => (await servers.scan()).find((entry) => entry.target.kind === "headless")!
    await open(servers, (await headless()).target)
    const pid = Number(await readFile(pidFile, "utf8"))
    expect((await headless()).detail).toStartWith("Running")
    await expect(servers.resolve((await headless()).target)).rejects.toThrow("The private server stopped responding.")
    expect((await headless()).detail).not.toStartWith("Running")
    for (let wait = 0; wait < 50 && alive(pid); wait++) await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  })
})
