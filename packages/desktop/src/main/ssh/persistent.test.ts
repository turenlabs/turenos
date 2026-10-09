import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { SshServerConfig } from "../../preload/types"
import { createSshServersController } from "./servers"
import {
  ATTACH_RECORD_PATH,
  PERSISTENT_SOCKET_PATH,
  classifyAttach,
  parseAttachProbe,
  REMOTE_ATTACH_PROBE_SCRIPT,
  verifyDescriptor,
} from "./persistent"

const config: SshServerConfig = {
  id: "ssh:me@host",
  host: "host",
  user: "me",
  hostname: "host",
  port: null,
  identityFile: null,
  displayName: null,
}
const record = {
  version: 2 as const,
  serverID: "srv_1",
  socketPath: PERSISTENT_SOCKET_PATH,
  username: "forge",
  password: "attach-password",
}
const line = (state: string, text = "") => `FORGE_ATTACH ${state}${text ? ` ${text}` : ""}`

describe("persistent attach classification", () => {
  test("parses readable, unreadable, and missing probe lines while ignoring banner noise", () => {
    expect(
      parseAttachProbe(["Welcome FORGE_ATTACH readable {}", line("readable", JSON.stringify(record))].join("\n")),
    ).toEqual({
      state: "readable",
      record,
    })
    expect(parseAttachProbe(line("missing"))).toEqual({ state: "missing" })
    expect(parseAttachProbe("Welcome FORGE_ATTACH readable {}")).toEqual({ state: "malformed" })
    expect(parseAttachProbe(line("unreadable"))).toEqual({ state: "unreadable" })
    expect(parseAttachProbe(line("readable", '{"version":1}'))).toEqual({ state: "malformed" })
  })

  test("rejects legacy TCP records and any socket outside the fixed managed path", () => {
    const legacy = {
      version: 1,
      serverID: record.serverID,
      username: record.username,
      password: record.password,
      url: "http://127.0.0.1:4096",
    }
    const probe = parseAttachProbe(line("readable", JSON.stringify(legacy)))
    expect(probe).toEqual({ state: "malformed" })
    expect(classifyAttach(config, probe).kind).toBe("conflict")
    for (const socketPath of [
      "/tmp/server.sock",
      "/run/turenos/../server.sock",
      "/run/turenos/server.sock:4096",
      "http://127.0.0.1:4096",
      "server.sock",
      "/run/turenos/server.sock/",
    ]) {
      const probe = parseAttachProbe(line("readable", JSON.stringify({ ...record, socketPath })))
      expect(probe).toEqual({ state: "malformed" })
      expect(classifyAttach(config, probe).kind).toBe("conflict")
    }
    expect(parseAttachProbe(line("readable", JSON.stringify({ ...record, url: "http://127.0.0.1:4096" })))).toEqual({
      state: "malformed",
    })
  })

  test("classifies attach, quick connect, and conflicts", () => {
    expect(classifyAttach(config, { state: "readable", record })).toEqual({ kind: "attach-existing", record })
    expect(classifyAttach(config, { state: "missing" })).toEqual({ kind: "start-quick-connect" })
    expect(classifyAttach(config, { state: "unreadable" }).kind).toBe("conflict")
    expect(classifyAttach(config, { state: "malformed" }).kind).toBe("conflict")
    expect(classifyAttach({ ...config, persistent: { serverID: "srv_1" } }, { state: "missing" }).kind).toBe("conflict")
    const replaced = { ...config, persistent: { serverID: "srv_0" } }
    expect(classifyAttach(replaced, { state: "readable", record }).kind).toBe("conflict")
  })

  test("verifies the tunnelled descriptor against the attach record", () => {
    expect(verifyDescriptor(record, { serverID: "srv_1", mode: "persistent" })).toEqual({ version: null })
    expect(verifyDescriptor(record, { serverID: "srv_1", mode: "persistent", version: "1.0.31" })).toEqual({
      version: "1.0.31",
    })
    expect(() => verifyDescriptor(record, { serverID: "srv_2", mode: "persistent" })).toThrow(
      "attach record names srv_1",
    )
    expect(() => verifyDescriptor(record, { serverID: "srv_1", mode: "quick-connect" })).toThrow("not persistent")
  })

  test("the probe script reads a multi-line attach record in a POSIX shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-attach-probe-"))
    try {
      const file = join(dir, "attach.json")
      await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 })
      const run = Bun.spawnSync(["sh", "-s"], {
        stdin: Buffer.from(REMOTE_ATTACH_PROBE_SCRIPT.replace(ATTACH_RECORD_PATH, file)),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      })
      expect(parseAttachProbe(run.stdout.toString())).toEqual({ state: "readable", record })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.getuid?.() === 0)(
    "the probe script reports an attach directory it cannot search as unreadable, not missing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-attach-probe-"))
      try {
        const file = join(dir, "attach.json")
        await writeFile(file, JSON.stringify(record), { mode: 0o600 })
        await chmod(dir, 0o600)
        const run = Bun.spawnSync(["sh", "-s"], {
          stdin: Buffer.from(REMOTE_ATTACH_PROBE_SCRIPT.replace(ATTACH_RECORD_PATH, file)),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        })
        expect(parseAttachProbe(run.stdout.toString())).toEqual({ state: "unreadable" })
      } finally {
        await chmod(dir, 0o700)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  test("the probe script carries no secrets", () => {
    expect(REMOTE_ATTACH_PROBE_SCRIPT).not.toContain("FORGE_SECRET_VAULT_KEY")
    expect(REMOTE_ATTACH_PROBE_SCRIPT).toContain("/etc/turenos/attach.json")
  })
})

describe("connectSshRemote with a persistent server", () => {
  const cleanup: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })

  const attachThrough = async (fetch: (request: Request) => Response, onReservedPort?: (port: number) => void) => {
    const dir = await mkdtemp(join(tmpdir(), "forge-persistent-attach-"))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const remoteSocket = join(dir, "r")
    const server = Bun.serve({ unix: remoteSocket, fetch })
    cleanup.push(() => server.stop(true))
    const attach = record

    const log = join(dir, "ssh.log")
    const fake = join(dir, "ssh")
    await writeFile(
      fake,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
import { connect, createServer } from "node:net"
const args = process.argv.slice(2)
if (args.includes("-O")) process.exit(0)
const forward = args.indexOf("-L")
const stdin = forward === -1 ? await Bun.stdin.text() : ""
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + "\\n")
if (forward !== -1) {
  const spec = args[forward + 1]
  const separator = spec.indexOf(":")
  const local = spec.slice(0, separator)
  const remote = spec.slice(separator + 1)
  if (remote !== ${JSON.stringify(PERSISTENT_SOCKET_PATH)}) process.exit(1)
  createServer((socket) => {
    const upstream = connect(${JSON.stringify(remoteSocket)})
    socket.pipe(upstream).pipe(socket)
  }).listen(local)
} else if (stdin.includes("FORGE_ATTACH")) {
  console.log("FORGE_ATTACH readable " + ${JSON.stringify(JSON.stringify(attach))})
}
`,
    )
    await chmod(fake, 0o755)

    const key = new Uint8Array(32).fill(5)
    const { connectSshRemote } = await import("./connection")
    const connection = connectSshRemote(config, {
      binary: fake,
      controlDir: join(dir, "control"),
      credentialVault: { keyID: "desktop-key", key },
      appVersion: "1.0.0",
      corsOrigins: () => [],
      onPrompt: async () => null,
      onReservedPort,
    })
    return { connection, log, key, attach }
  }

  test("attaches through the attach record without writing the shim, running ensure, or sending the key", async () => {
    const setup = await attachThrough((request) => {
      if (request.headers.get("authorization") !== `Basic ${btoa("forge:attach-password")}`)
        return new Response(null, { status: 401 })
      return Response.json({ serverID: "srv_1", mode: "persistent", keyID: "host-key" })
    })
    const connection = await setup.connection
    // The tunnel's exit handler spawns `ssh -O cancel`; let it run before the fake binary is removed.
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          connection.listener.onExit(() => setTimeout(resolve, 100))
          connection.listener.stop()
        }),
    )

    expect(connection).toMatchObject({
      username: "forge",
      password: "attach-password",
      persistent: { serverID: "srv_1" },
    })
    const calls = (await readFile(setup.log, "utf8")).trim().split("\n").join("\n")
    expect(calls).not.toContain(Buffer.from(setup.key).toString("base64"))
    expect(calls).not.toContain("desktop-key")
    expect(calls).not.toContain(".tmp")
    expect(calls).not.toContain("ensure")
    expect(calls).toContain(`:${PERSISTENT_SOCKET_PATH}`)
    expect(calls).not.toContain(":127.0.0.1:")
    expect(calls).not.toContain("attach-password")
  }, 30_000)

  test("reports a rejected descriptor request at once instead of waiting for the health timeout", async () => {
    const started = Date.now()
    const setup = await attachThrough(() => new Response(null, { status: 401 }))
    await expect(setup.connection).rejects.toThrow("401")
    expect(Date.now() - started).toBeLessThan(10_000)
    // The stopped tunnel spawns `ssh -O cancel`; let it run before the fake binary is removed.
    await Bun.sleep(200)
  }, 30_000)

  test("keeps the authenticated loopback port reserved while ssh starts", async () => {
    const competitor = createServer((request) => request.destroy())
    let intercepted = 0
    competitor.on("connection", () => intercepted++)
    let attempted: Promise<string> | undefined
    const setup = await attachThrough(
      () => Response.json({ serverID: "srv_1", mode: "persistent" }),
      (port) => {
        attempted = new Promise((resolve) => {
          competitor.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"))
          competitor.listen(port, "127.0.0.1", () => resolve("competing listener bound"))
        })
      },
    )
    try {
      const connection = await setup.connection
      expect(await attempted).toBe("EADDRINUSE")
      expect(intercepted).toBe(0)
      const exited = new Promise<void>((resolve) => connection.listener.onExit(() => resolve()))
      connection.listener.stop()
      await exited
      await Bun.sleep(100)
    } finally {
      if (competitor.listening) competitor.close()
    }
  }, 30_000)

  test("a subscriber added after tunnel exit still observes the exit", async () => {
    const setup = await attachThrough(() => Response.json({ serverID: "srv_1", mode: "persistent" }))
    const connection = await setup.connection
    const first = new Promise<void>((resolve) => connection.listener.onExit(() => resolve()))
    connection.listener.stop()
    await first

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("late tunnel exit was missed")), 1000)
      connection.listener.onExit(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
    // The exit handler issues `ssh -O cancel` in a separate child.
    await Bun.sleep(100)
  }, 30_000)
})

describe("persistent server lifecycle", () => {
  test("remove and stop only disconnect; they never stop the persistent server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-persistent-remove-"))
    try {
      const log = join(dir, "ssh.log")
      const fake = join(dir, "ssh")
      await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncat >/dev/null\nexit 0\n`)
      await chmod(fake, 0o755)
      let servers: SshServerConfig[] = [config]
      const controller = createSshServersController(
        {
          binary: fake,
          controlDir: join(dir, "control"),
          credentialVault: { keyID: "desktop-key", key: new Uint8Array(32) },
          appVersion: "1.0.0",
          corsOrigins: () => [],
          onPrompt: async () => null,
        },
        {
          readServers: () => servers,
          writeServers: (next) => {
            servers = next
          },
          connect: async () => ({
            listener: { stop: () => undefined, onExit: () => undefined },
            url: "http://127.0.0.1:1",
            username: "forge",
            password: "attach-password",
            persistent: { serverID: "srv_1" },
          }),
        },
      )
      await controller.initialize()
      const deadline = Date.now() + 2_000
      while (!servers[0]?.persistent && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(servers[0]?.persistent).toEqual({ serverID: "srv_1" })
      expect(JSON.stringify(servers)).not.toContain("attach-password")

      await controller.stopRemote(config.id)
      await controller.removeServer(config.id)
      const calls = await readFile(log, "utf8").catch(() => "")
      // Nothing is sent to the host, and the possibly shared ssh master is left alone.
      expect(calls).toBe("")
      expect(servers).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
