import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServers, type Target } from "../src/servers"

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const uid = process.getuid!()
const other = uid + 1
const PASSWORD = "synthetic-password"
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

/** One /proc/net/tcp row, in the layout the kernel prints. */
function row(local: string, owner: number, state = "0A") {
  return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${String(owner).padStart(5)}        0 12345 1\n`
}
const tcp = (...rows: string[]) => HEADER + rows.join("")
const LOOPBACK = "0100007F:1000"
const ANY = "00000000:1000"
const MAPPED = "0000000000000000FFFF00000100007F:1000"
const ANY6 = "00000000000000000000000000000000:1000"
const LOCAL6 = "00000000000000000000000000000001:1000"

/** A synthetic server that counts every request it receives, with or without credentials. */
function counting() {
  const seen: (string | null)[] = []
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization"))
      if (request.headers.get("authorization") !== `Basic ${btoa(`forge:${PASSWORD}`)}`)
        return new Response(null, { status: 401 })
      return Response.json({ healthy: true, version: "1.0.32" })
    },
  })
  cleanup.push(() => listener.stop(true))
  return { origin: listener.url.origin, seen }
}

async function setup(files: { tcp?: string; tcp6?: string } | undefined, platform: NodeJS.Platform = "linux") {
  const home = await mkdtemp(join(tmpdir(), "turen-tui-listener-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const servers = createServers({
    home,
    platform,
    uid,
    env: { FORGE_SERVER_PASSWORD: PASSWORD, XDG_CONFIG_HOME: home },
    forge: null,
    config: join(home, "servers.json"),
    persistentRecord: join(home, "missing.json"),
    readProc: (path) => (files ? (path.endsWith("tcp6") ? files.tcp6 : files.tcp) : undefined),
  })
  const [entry] = await servers.scan()
  const server = counting()
  // The check judges port 4096 from /proc; the request itself goes to the synthetic server.
  const target = { ...(entry!.target as Extract<Target, { kind: "env" }>), url: server.origin }
  return { servers, entry: entry!, target, server }
}

describe("the port-4096 listener's owner", () => {
  test("a listener owned by this user receives the password", async () => {
    const { servers, target, server } = await setup({ tcp: tcp(row(LOOPBACK, uid)) })
    const endpoint = await servers.resolve(target)
    expect(endpoint.password).toBe(PASSWORD)
    expect(server.seen).toContain(`Basic ${btoa(`forge:${PASSWORD}`)}`)
  })

  test("another user's listener is refused and nothing is sent to it", async () => {
    const { servers, target, server } = await setup({ tcp: tcp(row(LOOPBACK, other)) })
    const failure = await servers.resolve(target).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      "The listener on 127.0.0.1:4096 belongs to another user, so FORGE_SERVER_PASSWORD was not sent.",
    )
    expect((failure as Error).message).not.toContain(PASSWORD)
    expect(server.seen).toEqual([])
  })

  test("a foreign listener beside our own still refuses", async () => {
    const { servers, target, server } = await setup({ tcp: tcp(row(LOOPBACK, uid), row(ANY, other)) })
    await expect(servers.resolve(target)).rejects.toThrow("belongs to another user")
    expect(server.seen).toEqual([])
  })

  test("no listener fails fast without sending anything", async () => {
    const { servers, target, server } = await setup({ tcp: tcp(), tcp6: tcp() })
    await expect(servers.resolve(target)).rejects.toThrow("Nothing is listening on 127.0.0.1:4096.")
    expect(server.seen).toEqual([])
  })

  test.each([
    ["::1", { tcp6: tcp(row(LOCAL6, other)) }],
    ["another port", { tcp: tcp(row("0100007F:1001", other)) }],
    ["a connection that is not listening", { tcp: tcp(row(LOOPBACK, other, "01")) }],
    ["an address that is not loopback", { tcp: tcp(row("0100A8C0:1000", other)) }],
  ])("%s does not count as a listener", async (_, files) => {
    const { servers, target, server } = await setup(files)
    await expect(servers.resolve(target)).rejects.toThrow("Nothing is listening")
    expect(server.seen).toEqual([])
  })

  test.each([
    ["0.0.0.0", { tcp: tcp(row(ANY, other)) }],
    ["::", { tcp6: tcp(row(ANY6, other)) }],
    ["::ffff:127.0.0.1", { tcp6: tcp(row(MAPPED, other)) }],
  ])("%s answers on 127.0.0.1, so its owner is checked", async (_, files) => {
    const { servers, target, server } = await setup(files)
    await expect(servers.resolve(target)).rejects.toThrow("belongs to another user")
    expect(server.seen).toEqual([])
  })

  test.each([
    ["0.0.0.0", { tcp: tcp(row(ANY, uid)) }],
    ["::ffff:127.0.0.1", { tcp6: tcp(row(MAPPED, uid)) }],
  ])("our own listener on %s is accepted", async (_, files) => {
    const { servers, target } = await setup(files)
    expect((await servers.resolve(target)).password).toBe(PASSWORD)
  })

  test("an unreadable /proc refuses instead of guessing", async () => {
    const { servers, target, server } = await setup(undefined)
    await expect(servers.resolve(target)).rejects.toThrow("Cannot tell who owns the listener")
    expect(server.seen).toEqual([])
  })

  test("the picker row says when nothing is listening, and when another user is", async () => {
    expect((await setup({ tcp: tcp() })).entry.detail).toBe("127.0.0.1:4096 · not listening")
    expect((await setup({ tcp: tcp(row(LOOPBACK, other)) })).entry.detail).toBe("127.0.0.1:4096 · owned by another user")
    expect((await setup({ tcp: tcp(row(LOOPBACK, uid)) })).entry.detail).toBe("127.0.0.1:4096 · FORGE_SERVER_PASSWORD")
  })

  test("only Linux can pick port 4096 without being asked", async () => {
    const mac = await setup(undefined, "darwin")
    expect(mac.entry.target.kind).toBe("env")
    expect(await mac.servers.preferred()).toBeUndefined()
    const linux = await setup({ tcp: tcp(row(LOOPBACK, uid)) })
    expect((await linux.servers.preferred())?.kind).toBe("env")
  })
})
