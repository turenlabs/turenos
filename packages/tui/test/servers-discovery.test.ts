import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PasswordRequired } from "../src/servers"
import { scratch, server, desktop, local, open, healthy, persistent } from "./servers-fixture"

describe("local discovery", () => {
  test("a running desktop app is discovered first and resolves with its published credentials", async () => {
    const home = await scratch()
    const listener = server()
    await desktop(home, listener.url.origin)
    const servers = local(home)
    const [entry] = await servers.scan()
    expect(entry).toMatchObject({
      group: "This computer",
      target: { kind: "desktop", name: "TurenOS" },
      detail: `Desktop app · port ${listener.port}`,
    })
    const preferred = await servers.preferred()
    expect(preferred?.id).toBe("desktop:com.turenlabs.forge")
    expect(await open(servers, preferred!)).toMatchObject({
      url: listener.url.origin,
      username: "forge",
      password: "secret",
      version: "1.0.32",
    })
  })

  for (const [name, overrides, mode] of [
    ["a dead desktop process", { pid: 2 ** 30 }, 0o600],
    ["a non-loopback URL", { url: "http://192.168.1.2:4096" }, 0o600],
    ["a URL with a path", { url: "http://127.0.0.1:4096/prefix" }, 0o600],
    ["a missing password", { password: "" }, 0o600],
    ["a newer record version", { version: 2 }, 0o600],
    ["a record others can rewrite", {}, 0o622],
  ] as const) {
    test(`ignores ${name}`, async () => {
      const home = await scratch()
      await desktop(home, "http://127.0.0.1:4096", overrides, mode)
      expect(await local(home).scan()).toEqual([])
    })
  }

  test("ignores a record owned by another user", async () => {
    const home = await scratch()
    await desktop(home, "http://127.0.0.1:4096")
    expect(await local(home, { uid: (process.getuid?.() ?? 0) + 1 }).scan()).toEqual([])
  })

  test("a stale record that rejects its credentials fails with a restart hint", async () => {
    const home = await scratch()
    const listener = server("rotated")
    await desktop(home, listener.url.origin)
    const servers = local(home)
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow(
      "TurenOS rejected its published credentials",
    )
  })

  test("the quick-connect shim's state on this host is discovered", async () => {
    const home = await scratch()
    const listener = server()
    const run = join(home, ".forge", "run")
    await mkdir(run, { recursive: true })
    for (const [name, value] of [
      ["server.pid", String(process.pid)],
      ["server.port", String(listener.port)],
      ["server.auth", "secret"],
    ] as const)
      await writeFile(join(run, name), value, { mode: 0o600 })
    const servers = local(home)
    const target = await servers.preferred()
    expect(target?.kind).toBe("shim")
    expect(await healthy(await open(servers, target!))).toBe(200)
  })

  test("the persistent server's attach record is read on Linux", async () => {
    const home = await scratch()
    const socket = join(home, "server.sock")
    server("secret", { "/global/server": { serverID: "srv_1", mode: "persistent" } }, socket)
    const servers = await persistent(home, socket)
    const target = await servers.preferred()
    expect(target?.kind).toBe("persistent")
    expect(await open(servers, target!)).toMatchObject({ url: "http://localhost", socketPath: socket })
  })

  test("the persistent server comes before a quick-connect server, and --server persistent names it", async () => {
    const home = await scratch()
    const listener = server("secret")
    const run = join(home, ".forge", "run")
    await mkdir(run, { recursive: true })
    for (const [name, value] of [
      ["server.pid", String(process.pid)],
      ["server.port", String(listener.port)],
      ["server.auth", "secret"],
    ] as const)
      await writeFile(join(run, name), value, { mode: 0o600 })
    const servers = await persistent(home, join(home, "server.sock"))
    expect((await servers.scan()).map((entry) => entry.target.kind).slice(0, 2)).toEqual(["persistent", "shim"])
    expect((await servers.preferred())?.kind).toBe("persistent")
    await servers.load()
    expect(servers.find("persistent")).toEqual({ kind: "persistent", id: "persistent", name: "Persistent server" })
    // Only Linux hosts have one.
    expect(local(home).find("persistent")).toBeUndefined()
  })

  test("TURENOS_FORGE pins the forge binary and never falls through to PATH", async () => {
    const directory = await scratch()
    const forge = join(directory, "forge")
    await writeFile(forge, "#!/bin/sh\n", { mode: 0o755 })
    const kinds = async (TURENOS_FORGE: string) => {
      const servers = local(await scratch(), { forge: undefined, env: { TURENOS_FORGE, PATH: directory } })
      return { kinds: (await servers.scan()).map((entry) => entry.target.kind), problems: servers.problems() }
    }
    expect(await kinds("forge")).toEqual({
      kinds: [],
      problems: ["TURENOS_FORGE must be the absolute path of an executable file."],
    })
    expect((await kinds(join(directory, "missing"))).kinds).toEqual([])
    expect(await kinds(forge)).toEqual({ kinds: ["headless"], problems: [] })
  })

  test("FORGE_SERVER_PASSWORD keeps the port-4096 workflow available", async () => {
    const home = await scratch()
    const entries = await local(home, { env: { FORGE_SERVER_PASSWORD: "x" } }).scan()
    expect(entries.map((entry) => entry.target.kind)).toEqual(["env"])
  })

  test("a shell started by TurenOS does not offer its sidecar's password on port 4096", async () => {
    const home = await scratch()
    const servers = local(home, { env: { FORGE_SERVER_PASSWORD: "x", FORGE_CLIENT: "desktop" } })
    expect(await servers.scan()).toEqual([])
    expect(await servers.preferred()).toBeUndefined()
  })
})

describe("saved servers", () => {
  test("URL and SSH servers persist privately without passwords and reload", async () => {
    const home = await scratch()
    const servers = local(home)
    await servers.add({ address: "https://turen.example", username: "operator" })
    await servers.add({ address: "dad@10.0.0.4:2222", name: "lab" })
    await expect(servers.add({ address: "https://other.example", name: "lab" })).rejects.toThrow("exists")
    const file = join(home, "servers.json")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(await readFile(file, "utf8"))
    expect(saved.servers.map(({ id: _, ...rest }: { id: string }) => rest)).toEqual([
      { name: "turen.example", url: "https://turen.example", username: "operator" },
      { name: "lab", ssh: "dad@10.0.0.4:2222" },
    ])
    const reloaded = local(home)
    await reloaded.load()
    expect((await reloaded.scan()).map((entry) => [entry.group, entry.target.name, entry.detail])).toEqual([
      ["Saved", "turen.example", "https://turen.example"],
      ["Saved", "lab", "ssh dad@10.0.0.4:2222"],
    ])
    await reloaded.remove(reloaded.find("lab")!)
    expect(JSON.parse(await readFile(file, "utf8")).servers).toHaveLength(1)
  })

  for (const address of ["https://turen.example/prefix", "ftp://x", "-oProxyCommand=sh", "a b", "user@@host", "host:0", "host%h", "host;x", "host`x`"])
    test(`rejects the address ${JSON.stringify(address)}`, async () => {
      await expect(local(await scratch()).add({ address })).rejects.toThrow()
    })

  test("invalid saved entries are reported, skipped, and written back unchanged", async () => {
    const home = await scratch()
    const bad = { name: "bad", ssh: "-oProxyCommand=x", note: "hand edited" }
    await writeFile(
      join(home, "servers.json"),
      JSON.stringify({ servers: [{ name: "ok", url: "https://ok.example" }, bad] }),
      { mode: 0o600 },
    )
    const servers = local(home)
    await servers.load()
    expect((await servers.scan()).map((entry) => entry.target.name)).toEqual(["ok"])
    expect(servers.problems()).toEqual([`Skipped server 2 in ${join(home, "servers.json")}; it is kept unchanged.`])
    await servers.add({ address: "dad@10.0.0.4", name: "lab" })
    const written = JSON.parse(await readFile(join(home, "servers.json"), "utf8")).servers
    expect(written.map((item: { name: string }) => item.name)).toEqual(["ok", "lab", "bad"])
    expect(written[2]).toEqual(bad)
  })

  for (const [name, contents, mode, message] of [
    ["a file others can rewrite", JSON.stringify({ servers: [] }), 0o664, "must be a private file you own"],
    ["malformed JSON", "{ not json", 0o600, "is not a valid server list"],
  ] as const)
    test(`${name} is reported and never overwritten`, async () => {
      const home = await scratch()
      const file = join(home, "servers.json")
      await writeFile(file, contents, { mode })
      await chmod(file, mode)
      const servers = local(home)
      await servers.load()
      expect(servers.problems().join(" ")).toContain(message)
      await expect(servers.add({ address: "https://new.example" })).rejects.toThrow(message)
      expect(await readFile(file, "utf8")).toBe(contents)
    })

  test("a newer servers.json version is reported and never rewritten", async () => {
    const home = await scratch()
    const file = join(home, "servers.json")
    const contents = JSON.stringify({ version: 2, servers: [{ name: "ok", url: "https://ok.example" }] })
    await writeFile(file, contents, { mode: 0o600 })
    const servers = local(home)
    await servers.load()
    expect(servers.problems().join(" ")).toContain("written by a newer version")
    await expect(servers.add({ address: "https://new.example" })).rejects.toThrow("written by a newer version")
    expect(await readFile(file, "utf8")).toBe(contents)
  })

  test("a failed write leaves no temporary file beside servers.json", async () => {
    const home = await scratch()
    const servers = local(home)
    await servers.load()
    // A directory in the way makes the final rename fail.
    await mkdir(join(home, "servers.json", "keep"), { recursive: true })
    await expect(servers.add({ address: "https://new.example" })).rejects.toThrow()
    expect(await readdir(home)).toEqual(["servers.json"])
  })

  test("passwordEnv must name a TurenOS variable", async () => {
    const home = await scratch()
    const entry = (name: string, passwordEnv: string) => ({ name, url: `https://${name}.example`, passwordEnv })
    await writeFile(
      join(home, "servers.json"),
      JSON.stringify({
        servers: [
          entry("team", "TEAM_TURENOS_PASSWORD"),
          entry("lower", "forge_team_pw"),
          entry("token", "GITHUB_TOKEN"),
          entry("sidecar", "FORGE_SERVER_PASSWORD"),
        ],
      }),
      { mode: 0o600 },
    )
    const servers = local(home)
    await servers.load()
    expect((await servers.scan()).map((item) => item.target.name)).toEqual(["team", "lower"])
    const file = join(home, "servers.json")
    expect(servers.problems()).toEqual(
      [3, 4].map(
        (index) =>
          `Skipped server ${index} in ${file}; it is kept unchanged. passwordEnv must name a TURENOS or FORGE variable other than FORGE_SERVER_PASSWORD.`,
      ),
    )
  })

  test("a URL server asks for a password and uses the remembered one", async () => {
    const home = await scratch()
    const listener = server()
    const servers = local(home)
    const target = await servers.add({ address: listener.url.origin })
    const failure = await servers.resolve(target).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PasswordRequired)
    servers.remember(target, "secret")
    expect(await healthy(await open(servers, target))).toBe(200)
  })

  test("credentials are refused over plain HTTP to a non-loopback host", async () => {
    const servers = local(await scratch())
    const target = await servers.add({ address: "http://turen.example" })
    servers.remember(target, "secret")
    await expect(servers.resolve(target)).rejects.toThrow("require HTTPS")
  })
})
