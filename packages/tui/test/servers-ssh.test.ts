import { describe, expect, test } from "bun:test"
import { chmod, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { sshEnvironment } from "../src/servers/ssh"
import { parseSshTarget } from "../src/servers"
import { scratch, server, desktop, local, open, healthy, cleanup } from "./servers-fixture"

test("SSH destinations cannot smuggle options", () => {
  expect(parseSshTarget("dad@10.0.0.4:2222")).toEqual({ user: "dad", host: "10.0.0.4", port: 2222 })
  expect(parseSshTarget("eaw")).toEqual({ user: undefined, host: "eaw", port: undefined })
  for (const value of ["-oProxyCommand=x", "dad@-oX", "a\nb", "host:99999", "fe80::1", "host%h", "host;x", "host`x`"])
    expect(parseSshTarget(value)).toBeUndefined()
})

describe("SSH servers", () => {
  /** A fake `ssh`; a forward to a host socket path in `sockets` goes to the local socket it maps to. */
  async function fakeSsh(stdout: string | ((stdin: string) => string), sockets: Record<string, string> = {}) {
    const directory = await scratch()
    const log = join(directory, "ssh.log")
    const replies = join(directory, "replies.json")
    const script = join(directory, "ssh")
    await writeFile(replies, JSON.stringify({ ...(typeof stdout === "string" ? { default: stdout } : {}), sockets }))
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
  const at = spec.indexOf(":")
  const remote = spec.slice(at + 1)
  const sockets = JSON.parse(readFileSync(${JSON.stringify(replies)}, "utf8")).sockets
  createServer((socket) => {
    const upstream = remote.startsWith("/")
      ? connect(sockets[remote] ?? remote)
      : connect(Number(remote.slice("127.0.0.1:".length)), "127.0.0.1")
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

  test("a 1.0.44 persistent server on the host is reached by forwarding to its socket", async () => {
    const directory = await scratch()
    const socketPath = join(directory, "server.sock")
    const listener = Bun.serve({
      unix: socketPath,
      fetch(request) {
        if (request.headers.get("authorization") !== `Basic ${btoa("forge:secret")}`) return new Response(null, { status: 401 })
        const path = new URL(request.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "1.0.44" })
        return path === "/global/server" ? Response.json({ serverID: "srv_1" }) : new Response(null, { status: 404 })
      },
    })
    cleanup.push(() => listener.stop(true))
    const record = { version: 2, serverID: "srv_1", socketPath: "/run/turenos/server.sock", username: "forge", password: "secret" }
    const ssh = await fakeSsh(`FORGE_ATTACH readable ${JSON.stringify(record)}\n`, { "/run/turenos/server.sock": socketPath })
    const { servers, target } = await lab(ssh.script)
    const endpoint = await open(servers, target)
    // The tunnel's loopback end is the endpoint; the host's socket path means nothing on this computer.
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(endpoint.socketPath).toBeUndefined()
    expect(endpoint.version).toBe("1.0.44")
    expect(await healthy(endpoint)).toBe(200)
    const tunnel = (await ssh.calls()).find((call) => call.args.includes("-L"))!
    expect(tunnel.args[tunnel.args.indexOf("-L") + 1]).toEndWith(":/run/turenos/server.sock")
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
