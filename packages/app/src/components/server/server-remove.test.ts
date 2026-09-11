import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { removeServerConnection } from "./server-remove"

const wslKey = "wsl:Ubuntu" as ServerConnection.Key
const sshKey = "ssh:user@example.com" as ServerConnection.Key
const httpKey = "local\nhttp://localhost:4096" as ServerConnection.Key

describe("server removal sequencing", () => {
  test("runs tab teardown before stopping a WSL server and awaits the batch", async () => {
    const order: string[] = []
    let releaseTeardown!: () => void
    const teardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })

    const done = removeServerConnection({
      key: wslKey,
      removeTabs: (key) => {
        order.push(`removeTabs:${key}`)
        return teardown
      },
      removeConnection: (key) => order.push(`removeConnection:${key}`),
      stopManagedServer: async (key) => {
        order.push(`stop:${key}`)
      },
    })

    // The stop must wait for the teardown batch: the WSL forge server has to
    // stay alive while PTYs are disposed and the CLI session is archived.
    await Promise.resolve()
    expect(order).toEqual([`removeTabs:${wslKey}`])

    releaseTeardown()
    await done

    expect(order).toEqual([`removeTabs:${wslKey}`, `stop:${wslKey}`, `removeConnection:${wslKey}`])
  })

  test("runs tab teardown before tearing down an SSH tunnel and awaits the batch", async () => {
    const order: string[] = []
    let releaseTeardown!: () => void
    const teardown = new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })

    const done = removeServerConnection({
      key: sshKey,
      removeTabs: (key) => {
        order.push(`removeTabs:${key}`)
        return teardown
      },
      removeConnection: (key) => order.push(`removeConnection:${key}`),
      stopManagedServer: async (key) => {
        order.push(`stop:${key}`)
      },
    })

    // Same ordering as WSL: the tunnel is the transport terminal teardown
    // still needs to dispose PTYs and archive the CLI session.
    await Promise.resolve()
    expect(order).toEqual([`removeTabs:${sshKey}`])

    releaseTeardown()
    await done

    expect(order).toEqual([`removeTabs:${sshKey}`, `stop:${sshKey}`, `removeConnection:${sshKey}`])
  })

  test("bounds the teardown wait so a hung teardown cannot block the removal", async () => {
    const order: string[] = []

    await removeServerConnection({
      key: wslKey,
      // Never settles: the timeout must let the stop proceed anyway.
      removeTabs: () => new Promise<void>(() => {}),
      removeConnection: () => order.push("removeConnection"),
      stopManagedServer: async () => {
        order.push("stop")
      },
      teardownTimeoutMs: 5,
    })

    expect(order).toEqual(["stop", "removeConnection"])
  })

  test("keeps non-managed removals fire-and-forget: no stop, no waiting on teardown", async () => {
    const order: string[] = []
    let stopped = 0

    await removeServerConnection({
      key: httpKey,
      // Never settles: nothing stops an HTTP server, so nothing may wait.
      removeTabs: (key) => {
        order.push(`removeTabs:${key}`)
        return new Promise<void>(() => {})
      },
      removeConnection: (key) => order.push(`removeConnection:${key}`),
      stopManagedServer: async () => {
        stopped++
      },
    })

    expect(order).toEqual([`removeTabs:${httpKey}`, `removeConnection:${httpKey}`])
    expect(stopped).toBe(0)
  })

  test("removes a managed connection even when the platform cannot stop servers", async () => {
    const order: string[] = []

    await removeServerConnection({
      key: sshKey,
      removeTabs: () => {
        order.push("removeTabs")
        return Promise.resolve()
      },
      removeConnection: () => order.push("removeConnection"),
      // No sshServers platform: behave like a plain connection removal.
      stopManagedServer: undefined,
    })

    expect(order).toEqual(["removeTabs", "removeConnection"])
  })
})
