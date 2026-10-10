import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { bypassLoopbackProxy } from "../src/server/proxy"
import { PasswordRequired } from "../src/servers"
import { agent, world } from "./agent-fixture"
import { scratch, server, desktop, local, open, cleanup } from "./servers-fixture"

describe("verification bounds", () => {
  /** A server whose `path` answers with an endless body, counting what the client pulled; health is normal. */
  function endless(path: string) {
    let pulled = 0
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== `Basic ${btoa("forge:secret")}`)
          return new Response(null, { status: 401 })
        const requested = new URL(request.url).pathname
        if (requested !== path) {
          return requested === "/global/health"
            ? Response.json({ healthy: true, version: "1.0.32" })
            : new Response(null, { status: 404 })
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 65536
              controller.enqueue(new Uint8Array(65536).fill(32))
            },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    cleanup.push(() => listener.stop(true))
    return { url: listener.url.origin, pulled: () => pulled }
  }

  test("a health answer over the verification limit is refused without being buffered", async () => {
    const home = await scratch()
    const fixture = endless("/global/health")
    await desktop(home, fixture.url)
    const servers = local(home)
    const started = Date.now()
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("is not answering")
    expect(Date.now() - started).toBeLessThan(4000)
    expect(fixture.pulled()).toBeLessThan(8 * 1024 * 1024)
  })

  test("a server descriptor over the verification limit is refused", async () => {
    const home = await scratch()
    const fixture = endless("/global/server")
    const record = join(home, "attach.json")
    await writeFile(
      record,
      JSON.stringify({ version: 1, serverID: "srv_1", url: fixture.url, username: "forge", password: "secret" }),
    )
    const servers = local(home, { platform: "linux", uid: undefined, persistentRecord: record })
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
    expect(fixture.pulled()).toBeLessThan(8 * 1024 * 1024)
  })

  test("a desktop SSH list over the import limit is ignored", async () => {
    const home = await scratch()
    const fixture = endless("/global/storage")
    await desktop(home, fixture.url)
    const servers = local(home)
    await servers.importDesktop(await open(servers, (await servers.preferred())!))
    expect((await servers.scan()).map((entry) => entry.group)).toEqual(["This computer"])
    expect(fixture.pulled()).toBeLessThan(8 * 1024 * 1024)
  })
})

test("verifying a local record bypasses inherited proxies", async () => {
  const direct: (string | null)[] = []
  const proxied: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      direct.push(request.headers.get("authorization"))
      return Response.json({ healthy: true, version: "1.0.32" })
    },
  })
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      proxied.push(request.url)
      return Response.json({ healthy: true, version: "1.0.32" })
    },
  })
  cleanup.push(() => server.stop(true), () => proxy.stop(true))
  // The record must be written by the process whose pid it names, so the child writes it.
  const script = `
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServers } from ${JSON.stringify(new URL("../src/servers.ts", import.meta.url).href)}
const home = process.env.TUI_TEST_HOME
const directory = join(home, "Library", "Application Support", "com.turenlabs.forge")
await mkdir(directory, { recursive: true })
const record = { version: 1, url: process.env.TUI_TEST_URL, username: "forge", password: "secret", pid: process.pid }
await writeFile(join(directory, "attach.json"), JSON.stringify(record), { mode: 0o600 })
const servers = createServers({ home, platform: "darwin", env: {}, forge: null, config: join(home, "servers.json") })
const endpoint = await servers.resolve(await servers.preferred())
endpoint.close?.()
`
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: {
      ...process.env,
      TUI_TEST_HOME: await scratch(),
      TUI_TEST_URL: server.url.origin,
      HTTP_PROXY: proxy.url.href,
      HTTPS_PROXY: proxy.url.href,
      ALL_PROXY: proxy.url.href,
      http_proxy: proxy.url.href,
      https_proxy: proxy.url.href,
      all_proxy: proxy.url.href,
      NO_PROXY: "",
      no_proxy: "",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(direct).toEqual([`Basic ${btoa("forge:secret")}`])
  expect(proxied).toEqual([])
})

test("the loopback proxy bypass covers the bracketed IPv6 host", () => {
  const saved = [process.env.NO_PROXY, process.env.no_proxy]
  cleanup.push(() => {
    for (const [name, value] of [["NO_PROXY", saved[0]], ["no_proxy", saved[1]]] as const)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  })
  process.env.NO_PROXY = ""
  bypassLoopbackProxy(new URL("http://[::1]:4096"))
  expect(process.env.NO_PROXY!.split(",")).toEqual(expect.arrayContaining(["::1", "[::1]"]))
})

describe("an explicit URL that names a server whose record this client trusts", () => {
  /** The server's answers plus the Authorization header of every request it saw. */
  function watched(serverID?: string) {
    const seen: (string | null)[] = []
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization"))
        if (request.headers.get("authorization") !== `Basic ${btoa("forge:secret")}`)
          return new Response(null, { status: 401 })
        const path = new URL(request.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "1.0.32" })
        return path === "/global/server" ? Response.json({ serverID }) : new Response(null, { status: 404 })
      },
    })
    cleanup.push(() => listener.stop(true))
    return { origin: listener.url.origin, seen }
  }

  const named = (url: string) => ({ kind: "url", id: "cli", name: "cli", url, saved: false }) as const

  test("uses the record's credentials when no password is exported", async () => {
    const home = await scratch()
    const trusted = watched()
    await desktop(home, trusted.origin)
    const endpoint = await local(home).resolve(named(trusted.origin))
    expect(endpoint).toMatchObject({ url: trusted.origin, username: "forge", password: "secret", version: "1.0.32" })
  })

  test("keeps the record's serverID check", async () => {
    const home = await scratch()
    const impostor = watched("srv_other")
    await desktop(home, impostor.origin, { serverID: "srv_1" })
    await expect(local(home).resolve(named(impostor.origin))).rejects.toThrow("not the server that published")
  })

  test("a URL that differs by port never receives the record's password", async () => {
    const home = await scratch()
    const trusted = watched()
    const elsewhere = watched()
    await desktop(home, trusted.origin)
    await expect(local(home).resolve(named(elsewhere.origin))).rejects.toBeInstanceOf(PasswordRequired)
    expect(elsewhere.seen.every((header) => header === null)).toBe(true)
  })

  test("an exported FORGE_SERVER_PASSWORD, even an empty one, keeps the record out of it", async () => {
    const home = await scratch()
    const trusted = watched()
    await desktop(home, trusted.origin)
    const servers = local(home, { env: { FORGE_SERVER_PASSWORD: "" } })
    await expect(servers.resolve(named(trusted.origin))).rejects.toBeInstanceOf(PasswordRequired)
    expect(trusted.seen.every((header) => header === null)).toBe(true)
  })

  test("agent commands connect with the record and no exported password", async () => {
    const home = await scratch()
    const config = join(home, "config")
    const server = world({}, "secret")
    const directory = join(config, "com.turenlabs.forge")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "attach.json"),
      JSON.stringify({ version: 1, url: server.url, username: "forge", password: "secret", pid: process.pid }),
      { mode: 0o600 },
    )
    const result = await agent(["pending", "ses_main", "--json"], { url: server.url, env: { XDG_CONFIG_HOME: config } })
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })

  test("agent commands do not lend the record's password to another port", async () => {
    const home = await scratch()
    const config = join(home, "config")
    const trusted = world({}, "secret")
    const elsewhere = world({}, "secret")
    const directory = join(config, "com.turenlabs.forge")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "attach.json"),
      JSON.stringify({ version: 1, url: trusted.url, username: "forge", password: "secret", pid: process.pid }),
      { mode: 0o600 },
    )
    const result = await agent(["pending", "ses_main"], { url: elsewhere.url, env: { XDG_CONFIG_HOME: config } })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("requires a password")
  })

  test("a discovered server keeps its published username whatever --username says", async () => {
    const home = await scratch()
    const trusted = watched()
    await desktop(home, trusted.origin)
    const servers = local(home, { username: "someone-else" })
    const [entry] = await servers.scan()
    expect((await servers.resolve(entry!.target)).username).toBe("forge")
    expect((await servers.resolve(named(trusted.origin))).username).toBe("forge")
  })
})
