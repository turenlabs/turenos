import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { bypassLoopbackProxy } from "../src/server/proxy"
import { sshEnvironment } from "../src/servers/ssh"
import { createServers, parseSshTarget, PasswordRequired, type Endpoint, type Target } from "../src/servers"

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "turen-tui-servers-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** A TurenOS-shaped server that accepts one Basic credential. */
function server(password = "secret", routes: Record<string, unknown> = {}) {
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Basic ${btoa(`forge:${password}`)}`)
        return new Response(null, { status: 401 })
      const path = new URL(request.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "1.0.32" })
      return path in routes ? Response.json(routes[path]) : new Response(null, { status: 404 })
    },
  })
  cleanup.push(() => listener.stop(true))
  return listener
}

async function desktop(home: string, url: string, overrides: Record<string, unknown> = {}, mode = 0o600) {
  const directory = join(home, "Library", "Application Support", "com.turenlabs.forge")
  await mkdir(directory, { recursive: true })
  const file = join(directory, "attach.json")
  await writeFile(
    file,
    JSON.stringify({ version: 1, url, username: "forge", password: "secret", pid: process.pid, ...overrides }),
    { mode },
  )
  await chmod(file, mode)
  return file
}

function local(home: string, extra: Parameters<typeof createServers>[0] = {}) {
  return createServers({ home, platform: "darwin", env: {}, forge: null, config: join(home, "servers.json"), ...extra })
}

async function open(servers: ReturnType<typeof createServers>, target: Target) {
  const endpoint = await servers.resolve(target)
  cleanup.push(() => endpoint.close?.())
  return endpoint
}

async function healthy(endpoint: Endpoint) {
  const response = await fetch(new URL("/global/health", endpoint.url), {
    headers: { authorization: `Basic ${btoa(`${endpoint.username}:${endpoint.password}`)}` },
  })
  return response.status
}

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
    const listener = server("secret", { "/global/server": { serverID: "srv_1" } })
    const record = join(home, "attach.json")
    await writeFile(
      record,
      JSON.stringify({
        version: 1,
        serverID: "srv_1",
        url: listener.url.origin,
        username: "forge",
        password: "secret",
      }),
    )
    const servers = local(home, { platform: "linux", uid: undefined, persistentRecord: record })
    const target = await servers.preferred()
    expect(target?.kind).toBe("persistent")
    expect((await open(servers, target!)).url).toBe(listener.url.origin)
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

test("SSH destinations cannot smuggle options", () => {
  expect(parseSshTarget("dad@10.0.0.4:2222")).toEqual({ user: "dad", host: "10.0.0.4", port: 2222 })
  expect(parseSshTarget("eaw")).toEqual({ user: undefined, host: "eaw", port: undefined })
  for (const value of ["-oProxyCommand=x", "dad@-oX", "a\nb", "host:99999", "fe80::1", "host%h", "host;x", "host`x`"])
    expect(parseSshTarget(value)).toBeUndefined()
})

describe("SSH servers", () => {
  async function fakeSsh(stdout: string | ((stdin: string) => string)) {
    const directory = await scratch()
    const log = join(directory, "ssh.log")
    const replies = join(directory, "replies.json")
    const script = join(directory, "ssh")
    await writeFile(replies, JSON.stringify(typeof stdout === "string" ? { default: stdout } : {}))
    await writeFile(
      script,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs"
import { connect, createServer } from "node:net"
const args = process.argv.slice(2)
const forward = args.indexOf("-L")
const stdin = forward === -1 ? await Bun.stdin.text() : ""
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, env: Object.keys(process.env) }) + "\\n")
if (forward !== -1) {
  const spec = args[forward + 1]
  const at = spec.lastIndexOf(":127.0.0.1:")
  createServer((socket) => {
    const upstream = connect(Number(spec.slice(at + 11)), "127.0.0.1")
    socket.pipe(upstream).pipe(socket)
  }).listen(spec.slice(0, at))
  const lifetime = Number(JSON.parse(readFileSync(${JSON.stringify(replies)}, "utf8")).tunnelLifetime)
  if (lifetime) setTimeout(() => process.exit(0), lifetime)
} else {
  const replies = JSON.parse(readFileSync(${JSON.stringify(replies)}, "utf8"))
  const key = stdin.includes("forge-remote\\" ensure") ? "ensure" : "default"
  process.stdout.write(replies[key] ?? "")
}
`,
    )
    await chmod(script, 0o755)
    const calls = async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; stdin: string; env: string[] })
    const reply = (key: string, value: string) =>
      readFile(replies, "utf8").then((text) =>
        writeFile(replies, JSON.stringify({ ...JSON.parse(text), [key]: value })),
      )
    return { script, calls, reply }
  }

  async function lab(ssh: string, env: NodeJS.ProcessEnv = {}) {
    const home = await scratch()
    const servers = local(home, { ssh, env })
    const target = await servers.add({ address: "dad@lab.example:2222", name: "lab" })
    return { servers, target }
  }

  test("attaches to a desktop-started quick-connect server through a private tunnel", async () => {
    const listener = server()
    const ssh = await fakeSsh(
      `FORGE_ATTACH missing\nFORGE_REMOTE {"port":${listener.port},"username":"forge","password":"secret"}\n`,
    )
    const { servers, target } = await lab(ssh.script)
    const endpoint = await open(servers, target)
    expect(endpoint.url).not.toBe(listener.url.origin)
    expect(await healthy(endpoint)).toBe(200)
    const [probe, tunnel] = await ssh.calls()
    expect(probe!.args.slice(-3)).toEqual(["--", "dad@lab.example", "sh -s"])
    expect(probe!.args).toEqual(expect.arrayContaining(["ControlMaster=no", "ControlPath=none"]))
    expect(probe!.args).toContain("BatchMode=yes")
    expect(probe!.args).toEqual(expect.arrayContaining(["-p", "2222"]))
    expect(tunnel!.args.slice(-2)).toEqual(["--", "dad@lab.example"])
    expect(tunnel!.args).toEqual(expect.arrayContaining(["ControlMaster=no", "ControlPath=none"]))
    expect(tunnel!.args).toContain("-N")
  })

  test("a rejected remote record never reaches the error text", async () => {
    const ssh = await fakeSsh("FORGE_ATTACH missing\nFORGE_REMOTE_STOPPED\n")
    await ssh.reply("ensure", 'FORGE_REMOTE {"port":99999,"username":"forge","password":"remote-secret"}\n')
    const { servers, target } = await lab(ssh.script, {
      FORGE_SECRET_VAULT_KEY_ID: "key-1",
      FORGE_SECRET_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    })
    const message = await servers.resolve(target).then(
      () => "",
      (error: Error) => error.message,
    )
    expect(message).toContain("did not publish a usable server record")
    expect(message).not.toContain("remote-secret")
  })

  test("a dropped tunnel keeps its loopback port reserved until the endpoint is closed", async () => {
    const listener = server()
    const ssh = await fakeSsh(
      `FORGE_ATTACH missing\nFORGE_REMOTE {"port":${listener.port},"username":"forge","password":"secret"}\n`,
    )
    await ssh.reply("tunnelLifetime", "1500")
    const { servers, target } = await lab(ssh.script)
    const endpoint = await servers.resolve(target)
    const port = Number(new URL(endpoint.url).port)
    const bound = () =>
      new Promise<boolean>((resolve) => {
        const probe = createServer()
        probe.once("error", () => resolve(true))
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)))
      })
    await Bun.sleep(2500)
    // A retrying dashboard gets errors, never another listener that could collect its password.
    expect(await healthy(endpoint).catch(() => "refused")).toBe("refused")
    expect(await bound()).toBe(true)
    endpoint.close?.()
    await Bun.sleep(50)
    expect(await bound()).toBe(false)
  })

  test("prefers a managed persistent server's attach record", async () => {
    const listener = server("secret", { "/global/server": { serverID: "srv_1" } })
    const record = {
      version: 1,
      serverID: "srv_1",
      url: `http://127.0.0.1:${listener.port}`,
      username: "forge",
      password: "secret",
    }
    const ssh = await fakeSsh(`FORGE_ATTACH readable ${JSON.stringify(record)}\nFORGE_REMOTE_STOPPED\n`)
    const { servers, target } = await lab(ssh.script)
    expect(await healthy(await open(servers, target))).toBe(200)
  })

  test("an unreadable persistent record names the operators group", async () => {
    const ssh = await fakeSsh("FORGE_ATTACH unreadable\n")
    const { servers, target } = await lab(ssh.script)
    await expect(servers.resolve(target)).rejects.toThrow("turenos-operators")
  })

  test("a stopped server is started only with a vault key, which never reaches argv", async () => {
    const listener = server()
    const ssh = await fakeSsh("FORGE_ATTACH missing\nFORGE_REMOTE_STOPPED\n")
    const stopped = await lab(ssh.script)
    await expect(stopped.servers.resolve(stopped.target)).rejects.toThrow("set FORGE_SECRET_VAULT_KEY_ID")
    await ssh.reply("ensure", `FORGE_REMOTE {"port":${listener.port},"username":"forge","password":"secret"}\n`)
    const key = Buffer.alloc(32, 7).toString("base64")
    const { servers, target } = await lab(ssh.script, {
      FORGE_SECRET_VAULT_KEY_ID: "key-1",
      FORGE_SECRET_VAULT_KEY: key,
    })
    expect(await healthy(await open(servers, target))).toBe(200)
    const calls = await ssh.calls()
    const ensure = calls.find((call) => call.stdin.includes("ensure"))!
    expect(ensure.stdin).toContain(`FORGE_SECRET_VAULT_KEY='${key}'`)
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(key)
  })

  test("a vault key id or key that could close the shell quote never reaches the ensure script", async () => {
    const ssh = await fakeSsh("FORGE_ATTACH missing\nFORGE_REMOTE_STOPPED\n")
    const key = Buffer.alloc(32, 7).toString("base64")
    for (const env of [
      { FORGE_SECRET_VAULT_KEY_ID: "key-1'; echo pwned; '", FORGE_SECRET_VAULT_KEY: key },
      { FORGE_SECRET_VAULT_KEY_ID: "key-1", FORGE_SECRET_VAULT_KEY: `${key.slice(0, 40)}'\n$(id)` },
    ]) {
      const { servers, target } = await lab(ssh.script, env)
      await expect(servers.resolve(target)).rejects.toThrow("set FORGE_SECRET_VAULT_KEY_ID")
    }
    expect((await ssh.calls()).some((call) => call.stdin.includes("ensure"))).toBe(false)
  })

  test("ssh children get a login environment, never the client's secrets", async () => {
    expect(sshEnvironment({ PATH: "/bin", LC_ALL: "C", SSH_AUTH_SOCK: "/a", FORGE_SERVER_PASSWORD: "p" })).toEqual({
      PATH: "/bin",
      LC_ALL: "C",
      SSH_AUTH_SOCK: "/a",
    })
    const listener = server()
    const ssh = await fakeSsh(
      `FORGE_ATTACH missing\nFORGE_REMOTE {"port":${listener.port},"username":"forge","password":"secret"}\n`,
    )
    const { servers, target } = await lab(ssh.script, {
      FORGE_SERVER_PASSWORD: "p",
      FORGE_SECRET_VAULT_KEY_ID: "k",
      LAB_PASSWORD: "x",
      SSH_AUTH_SOCK: "/tmp/agent",
      PATH: process.env.PATH,
    })
    await open(servers, target)
    const calls = await ssh.calls()
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.env).toContain("SSH_AUTH_SOCK")
      for (const name of ["FORGE_SERVER_PASSWORD", "FORGE_SECRET_VAULT_KEY_ID", "LAB_PASSWORD"])
        expect(call.env).not.toContain(name)
    }
  })

  test("ssh output over the probe limit fails the probe without quoting it", async () => {
    const ssh = await fakeSsh("SECRETOUTPUT".repeat(6000))
    const { servers, target } = await lab(ssh.script)
    const message = await servers.resolve(target).then(
      () => "",
      (error: Error) => error.message,
    )
    expect(message).toBe("The SSH command produced more output than this client accepts.")
  })

  test("a record with a serverID is refused when the server does not name itself, and its tunnel closes", async () => {
    const listener = server()
    const record = { version: 1, serverID: "srv_1", url: listener.url.origin, username: "forge", password: "secret" }
    const ssh = await fakeSsh(`FORGE_ATTACH readable ${JSON.stringify(record)}\n`)
    const { servers, target } = await lab(ssh.script)
    await expect(servers.resolve(target)).rejects.toThrow("not the server that published")
    const tunnel = (await ssh.calls()).find((call) => call.args.includes("-L"))!
    const socket = tunnel.args[tunnel.args.indexOf("-L") + 1]!.split(":127.0.0.1:")[0]!
    await Bun.sleep(500)
    expect(await stat(dirname(socket)).then(() => true, () => false)).toBe(false)
  })

  test("a host without TurenOS points to the desktop installer", async () => {
    const ssh = await fakeSsh("FORGE_ATTACH missing\nFORGE_REMOTE_MISSING\n")
    const { servers, target } = await lab(ssh.script)
    await expect(servers.resolve(target)).rejects.toThrow("not set up on lab")
  })

  test("the desktop's saved SSH servers are imported without duplicating saved ones", async () => {
    const home = await scratch()
    const listener = server("secret", {
      "/global/storage": {
        state: {
          value: JSON.stringify([
            { id: "ssh:dad@10.0.0.4", host: "10.0.0.4", user: "dad", port: null, displayName: "eaw" },
            { id: "ssh:dad@lab.example:2222", host: "lab.example", user: "dad", port: 2222, displayName: null },
            { id: "ssh:dad@lab.example:2200", host: "lab.example", user: "dad", port: 2200, displayName: "lab-alt" },
            { id: "ssh:bad", host: "-oProxyCommand=x", user: null },
          ]),
        },
      },
    })
    await desktop(home, listener.url.origin)
    const servers = local(home)
    await servers.add({ address: "dad@lab.example:2222", name: "lab" })
    await servers.importDesktop(await open(servers, (await servers.preferred())!))
    expect((await servers.scan()).map((entry) => [entry.group, entry.target.name, entry.detail])).toEqual([
      ["This computer", "TurenOS", `Desktop app · port ${listener.port}`],
      ["Saved", "lab", "ssh dad@lab.example:2222"],
      ["From TurenOS Desktop", "eaw", "ssh dad@10.0.0.4"],
      ["From TurenOS Desktop", "lab-alt", "ssh dad@lab.example:2200"],
    ])
  })
})

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

  async function persistent(url: string, serverID: string) {
    const home = await scratch()
    const record = join(home, "attach.json")
    await writeFile(record, JSON.stringify({ version: 1, serverID, url, username: "forge", password: "secret" }))
    return local(home, { platform: "linux", uid: undefined, persistentRecord: record })
  }

  test("a server whose serverID differs from the record's is refused", async () => {
    const servers = await persistent(server("secret", { "/global/server": { serverID: "srv_other" } }).url.origin, "srv_1")
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
  })

  test("a server whose descriptor carries no serverID is refused", async () => {
    const servers = await persistent(server("secret", { "/global/server": { mode: "persistent" } }).url.origin, "srv_1")
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
  })

  test("a server whose serverID matches the record's is accepted", async () => {
    const servers = await persistent(server("secret", { "/global/server": { serverID: "srv_1" } }).url.origin, "srv_1")
    expect((await servers.resolve((await servers.preferred())!)).version).toBe("1.0.32")
  })

  test("a server that answers 404 for its descriptor is refused when the record names a serverID", async () => {
    const servers = await persistent(server().url.origin, "srv_1")
    await expect(servers.resolve((await servers.preferred())!)).rejects.toThrow("not the server that published")
  })
})

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
