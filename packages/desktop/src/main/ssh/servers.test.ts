import { expect, test } from "bun:test"
import type { SshServerConfig } from "../../preload/types"
import type { SshConnection } from "./connection"
import { createSshServersController } from "./servers"
import { expectSshForgeVersion, pollSshHealth, sshReconnectDelays, sshServerIdsToStartOnInitialize } from "./startup"
import { clearSshHostState, requireSshIpcTarget, sshServerConfig } from "./policy"

const config = (id: string): SshServerConfig => ({
  id,
  host: id.slice(4),
  user: "me",
  hostname: id.split("@")[1]?.split(":")[0] ?? "host",
  port: null,
  identityFile: null,
  displayName: null,
})

const ready = (): SshConnection => ({
  listener: { stop: () => undefined, onExit: () => undefined },
  url: "http://127.0.0.1:4096",
  username: "forge",
  password: "secret",
})

const deps = {
  controlDir: "/tmp/forge-ssh-test",
  credentialVault: { keyID: "v1", key: new Uint8Array(32) },
  appVersion: "1.16.2",
  corsOrigins: () => ["http://localhost:5173"],
  onPrompt: async () => null,
}

async function waitFor(fn: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("timed out waiting for condition")
}

test("health polling stops when the tunnel startup settles", async () => {
  const abort = new AbortController()
  let checks = 0
  const polling = pollSshHealth(
    async () => {
      checks++
      return false
    },
    abort.signal,
    1,
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort()
  await polling
  const settled = checks
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(checks).toBe(settled)
})

test("reconnect backoff stretches past a laptop sleep", () => {
  const delays = sshReconnectDelays()
  expect(delays.length).toBeGreaterThanOrEqual(4)
  expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(60_000)
  expect(delays[0]).toBeLessThanOrEqual(1_000)
})

test("starts every configured SSH server on initialization", () => {
  expect(sshServerIdsToStartOnInitialize([{ id: "ssh:a@x" }, { id: "ssh:b@y:2222" }])).toEqual([
    "ssh:a@x",
    "ssh:b@y:2222",
  ])
})

test("rejects a forge version that did not update on the remote", () => {
  expect(() => expectSshForgeVersion("1.16.2", "1.16.2", "prod")).not.toThrow()
  expect(() => expectSshForgeVersion("1.14.0", "1.16.2", "prod")).toThrow(
    "TurenOS update finished but prod still reports 1.14.0; expected 1.16.2",
  )
})

test("clears cached host probes when removing an SSH server", () => {
  expect(
    clearSshHostState(
      { "ssh:a@x": { host: "ssh:a@x", sshAvailable: true, batchAuth: true, platform: null, hasBash: false, forgePath: null, forgeVersion: null, error: null } },
      { "ssh:a@x": { host: "ssh:a@x", resolvedPath: "/u/.forge/bin/forge", version: "1", expectedVersion: "1", matchesDesktop: true, error: null } },
      "ssh:a@x",
    ),
  ).toEqual({ probes: {}, forgeChecks: {} })
})

test("validates SSH IPC targets at the module boundary", () => {
  expect(requireSshIpcTarget({ host: "user@host", port: 2222 })).toEqual({
    host: "user@host",
    port: 2222,
    identityFile: null,
    displayName: null,
  })
  expect(() => requireSshIpcTarget({ host: "" })).toThrow("Invalid host")
  expect(() => requireSshIpcTarget({ host: "h", port: 0 })).toThrow("Invalid port")
  expect(() => requireSshIpcTarget(null)).toThrow("Invalid ssh target")
})

test("canonical ids dedupe aliases and literal targets for the same remote", () => {
  const resolved = { hostname: "203.0.113.9", user: "me", port: 22, identityFile: null }
  const a = sshServerConfig({ host: "myalias", user: null, port: null, identityFile: null }, resolved, null)
  const b = sshServerConfig({ host: "203.0.113.9", user: "me", port: null, identityFile: null }, resolved, null)
  expect(a.id).toBe("ssh:me@203.0.113.9")
  expect(a.id).toBe(b.id)
})

test("initialize starts all persisted servers and marks them ready", async () => {
  const persisted = [config("ssh:me@a"), config("ssh:me@b")]
  const started: string[] = []
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    connect: async (cfg) => {
      started.push(cfg.id)
      return ready()
    },
  })
  await controller.initialize()
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["ssh:me@a", "ssh:me@b"])
  await waitFor(() => controller.getState().servers.every((s) => s.runtime.kind === "ready"))
  expect(controller.getState().servers.map((s) => s.runtime)).toEqual([
    { kind: "ready", url: "http://127.0.0.1:4096", username: "forge", password: "secret" },
    { kind: "ready", url: "http://127.0.0.1:4096", username: "forge", password: "secret" },
  ])
})

test("addServer rejects a duplicate canonical id and records connect failures", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    resolve: async (target) => ({
      hostname: target.host === "alias" ? "a" : target.host,
      user: "me",
      port: 22,
      identityFile: null,
    }),
    connect: async () => {
      throw new Error("ssh: connect to host a port 22: Connection refused")
    },
  })
  await controller.initialize()
  await waitFor(() => {
    const item = controller.getState().servers[0]
    return item?.runtime.kind === "failed"
  })
  const failed = controller.getState().servers[0]
  expect(failed.runtime).toMatchObject({ kind: "failed" })

  // "alias" resolves to the same canonical id → duplicate rejected.
  await expect(controller.addServer({ host: "alias" })).rejects.toThrow("already added")
})

test("removeServer unregisters, stops the tunnel, and clears cached state", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const written: SshServerConfig[][] = []
  let stopped = 0
  const controller = createSshServersController(
    { ...deps, onPrompt: async () => null },
    {
      readServers: () => persisted,
      writeServers: (servers) => {
        written.push(servers)
        persisted.length = 0
        persisted.push(...servers)
      },
      connect: async () => ({
        listener: {
          stop: () => stopped++,
          onExit: () => undefined,
        },
        url: "http://127.0.0.1:4096",
        username: "forge",
        password: "secret",
      }),
    },
  )
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")

  await controller.removeServer("ssh:me@a")

  expect(stopped).toBe(1)
  expect(written.at(-1)).toEqual([])
  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().forgeChecks).toEqual({})
})

test("a dropped tunnel marks the server failed and schedules a bounded reconnect", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let connects = 0
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    connect: async () => {
      connects++
      return {
        listener: {
          stop: () => undefined,
          onExit: (cb) => {
            exit = cb
          },
        },
        url: "http://127.0.0.1:4096",
        username: "forge",
        password: "secret",
      }
    },
  })
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")

  exit?.(255, null)
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "failed")

  // Auto-reconnect kicks in with backoff.
  await waitFor(() => connects >= 2, 3_000)
})

test("interactive prompts round-trip through state.prompt and respondPrompt", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    connect: async (cfg, ctx) => {
      const response = await ctx.onPrompt({ kind: "password", message: "me@a's password:" })
      if (response !== "hunter2") throw new Error("bad password")
      return ready()
    },
  })
  const init = controller.initialize()
  await waitFor(() => controller.getState().prompt?.kind === "password")
  expect(controller.getState().prompt?.message).toBe("me@a's password:")

  controller.respondPrompt(controller.getState().prompt!.requestId, "hunter2")
  await init
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  expect(controller.getState().prompt).toBeNull()
})

test("stopAll resolves a pending prompt with null so ssh exits instead of hanging", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    connect: async (cfg, ctx) => {
      const response = await ctx.onPrompt({ kind: "hostkey", message: "continue?" })
      if (response === null) throw new Error("cancelled")
      return ready()
    },
  })
  const init = controller.initialize()
  await waitFor(() => !!controller.getState().prompt)
  controller.stopAll()
  await init
  expect(controller.getState().prompt).toBeNull()
})

test("probeHost records a successful probe and a failure", async () => {
  const controller = createSshServersController(deps, {
    readServers: () => [],
    probe: async (target) => {
      if (target.host === "down") throw new Error("ssh: connect to host down port 22: Connection refused")
      return {
        host: "",
        sshAvailable: true,
        batchAuth: true,
        platform: "Linux-x86_64",
        hasBash: true,
        forgePath: "/u/.forge/bin/forge",
        forgeVersion: "1.16.2",
        error: null,
      }
    },
  })

  await controller.probeHost({ host: "me@up" })
  expect(controller.getState().probes["probe:me@up"]).toMatchObject({
    platform: "Linux-x86_64",
    forgeVersion: "1.16.2",
    error: null,
  })

  await expect(controller.probeHost({ host: "down" })).rejects.toThrow("Connection refused")
  expect(controller.getState().probes["probe:down"]).toMatchObject({
    forgePath: null,
    error: "ssh: connect to host down port 22: Connection refused",
  })
})

test("stopRemote disconnects the tunnel and marks the server stopped", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  let stopped = 0
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    connect: async () => ({
      listener: { stop: () => stopped++, onExit: () => undefined },
      url: "http://127.0.0.1:4096",
      username: "forge",
      password: "secret",
    }),
  })
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")

  await controller.stopRemote("ssh:me@a")
  expect(stopped).toBe(1)
  expect(controller.getState().servers[0]?.runtime).toEqual({ kind: "stopped" })
  // Server stays in the list - it can be reconnected.
  expect(controller.getState().servers).toHaveLength(1)
})

test("installForge installs, checks the remote version, and restarts the server", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const order: string[] = []
  let connects = 0
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    installForge: async () => {
      order.push("install")
    },
    forgeCheck: async (cfg) => ({
      host: cfg.id,
      resolvedPath: "/u/.forge/bin/forge",
      version: "1.16.2",
      expectedVersion: "1.16.2",
      matchesDesktop: true,
      error: null,
    }),
    connect: async () => {
      connects++
      order.push(`connect:${connects}`)
      return ready()
    },
  })
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")

  await controller.installForge("ssh:me@a")

  // The restart is kicked off asynchronously after the version check passes.
  await waitFor(() => connects === 2)
  expect(order).toEqual(["connect:1", "install", "connect:2"])
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  expect(controller.getState().forgeChecks["ssh:me@a"]).toMatchObject({ matchesDesktop: true })
})

test("installForge fails loudly when the remote still reports the wrong version", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    installForge: async () => undefined,
    forgeCheck: async (cfg) => ({
      host: cfg.id,
      resolvedPath: "/u/.forge/bin/forge",
      version: "1.14.0",
      expectedVersion: "1.16.2",
      matchesDesktop: false,
      error: null,
    }),
    connect: async () => ready(),
  })
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")

  await expect(controller.installForge("ssh:me@a")).rejects.toThrow(
    "TurenOS update finished but me@a still reports 1.14.0; expected 1.16.2",
  )
})

test("a removal during an in-flight connect discards the late connection", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  let release!: () => void
  let discarded = 0
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    connect: async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return {
        listener: { stop: () => discarded++, onExit: () => undefined },
        url: "http://127.0.0.1:4096",
        username: "forge",
        password: "secret",
      }
    },
  })
  const init = controller.initialize()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await controller.removeServer("ssh:me@a")
  release()
  await init
  await new Promise((resolve) => setTimeout(resolve, 10))

  expect(discarded).toBe(1)
  expect(controller.getState().servers).toEqual([])
})

test("reconnect retries stop after the backoff schedule is exhausted", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = []
  let connects = 0
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    reconnectDelays: () => [1, 1],
    connect: async () => {
      connects++
      // The initial connect succeeds; every reconnect attempt fails so the
      // bounded schedule can exhaust.
      if (connects > 1) throw new Error("ssh: connect: Connection refused")
      return {
        listener: {
          stop: () => undefined,
          onExit: (cb) => exits.push(cb),
        },
        url: "http://127.0.0.1:4096",
        username: "forge",
        password: "secret",
      }
    },
  })
  await controller.initialize()
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")

  exits[0]?.(255, null)
  await waitFor(() => connects >= 3)
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "failed")

  // All retries spent: no further connect attempts.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(connects).toBe(3)
})

test("a prompt-cancelled connect does not auto-retry", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  let connects = 0
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    reconnectDelays: () => [1],
    connect: async (cfg, ctx) => {
      connects++
      const response = await ctx.onPrompt({ kind: "password", message: "pw:" })
      if (response === null) throw new DOMException("Aborted", "AbortError")
      return ready()
    },
  })
  const init = controller.initialize()
  await waitFor(() => !!controller.getState().prompt)
  controller.respondPrompt(controller.getState().prompt!.requestId, null)
  await init
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "failed")
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(connects).toBe(1)
})

test("start on an unknown server is a no-op and respondPrompt ignores stale ids", async () => {
  const controller = createSshServersController(deps, { readServers: () => [] })
  await controller.initialize()
  await controller.startServer("ssh:nobody@nowhere")
  controller.respondPrompt("no-such-request", "x")
  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().prompt).toBeNull()
})

test("sequential prompts each surface and resolve (ssh password retries)", async () => {
  const persisted: SshServerConfig[] = [config("ssh:me@a")]
  const responses: string[] = []
  const controller = createSshServersController(deps, {
    readServers: () => persisted,
    connect: async (cfg, ctx) => {
      // ssh asks up to three times on a wrong password - each prompt round-trips.
      responses.push((await ctx.onPrompt({ kind: "password", message: "me@a's password:" })) ?? "null")
      responses.push((await ctx.onPrompt({ kind: "password", message: "me@a's password:" })) ?? "null")
      return ready()
    },
  })
  const init = controller.initialize()
  await waitFor(() => controller.getState().prompt?.kind === "password")
  const firstId = controller.getState().prompt!.requestId
  controller.respondPrompt(firstId, "wrong")
  await waitFor(
    () => controller.getState().prompt !== null && controller.getState().prompt!.requestId !== firstId,
  )
  controller.respondPrompt(controller.getState().prompt!.requestId, "right")
  await waitFor(() => responses.length === 2)
  expect(responses).toEqual(["wrong", "right"])
  await init
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  expect(controller.getState().prompt).toBeNull()
})
