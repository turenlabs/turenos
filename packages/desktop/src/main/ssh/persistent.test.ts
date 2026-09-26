import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SshServerConfig } from "../../preload/types"
import { createSshServersController } from "./servers"
import {
  ATTACH_RECORD_PATH,
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
  version: 1 as const,
  serverID: "srv_1",
  url: "http://127.0.0.1:4096",
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
    expect(parseAttachProbe("Welcome FORGE_ATTACH readable {}")).toEqual({ state: "missing" })
    expect(parseAttachProbe(line("unreadable"))).toEqual({ state: "unreadable" })
    expect(parseAttachProbe(line("readable", '{"version":1}'))).toEqual({ state: "malformed" })
  })

  test("rejects attach records that point off the host loopback", () => {
    const remote = JSON.stringify({ ...record, url: "http://203.0.113.9:4096" })
    expect(parseAttachProbe(line("readable", remote))).toEqual({ state: "malformed" })
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
    expect(() => verifyDescriptor(record, { serverID: "srv_1", mode: "persistent" })).not.toThrow()
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

  const attachThrough = async (fetch: (request: Request) => Response) => {
    const dir = await mkdtemp(join(tmpdir(), "forge-persistent-attach-"))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })
    cleanup.push(() => server.stop(true))
    const attach = { ...record, url: `http://127.0.0.1:${server.port}` }

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
  const [, local, , remote] = args[forward + 1].split(":")
  createServer((socket) => {
    const upstream = connect(Number(remote), "127.0.0.1")
    socket.pipe(upstream).pipe(socket)
  }).listen(Number(local), "127.0.0.1")
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
  }, 30_000)

  test("reports a rejected descriptor request at once instead of waiting for the health timeout", async () => {
    const started = Date.now()
    const setup = await attachThrough(() => new Response(null, { status: 401 }))
    await expect(setup.connection).rejects.toThrow("401")
    expect(Date.now() - started).toBeLessThan(10_000)
    // The stopped tunnel spawns `ssh -O cancel`; let it run before the fake binary is removed.
    await Bun.sleep(200)
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
