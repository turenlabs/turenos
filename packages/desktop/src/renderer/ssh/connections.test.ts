import { describe, expect, test } from "bun:test"
import type { SshServersState, SshServerItem } from "@turenlabs/app/ssh/types"
import { availableStartupServer } from "../wsl/connections"
import { readySshConnections } from "./connections"

const item = (id: string, runtime: SshServerItem["runtime"], displayName: string | null = null): SshServerItem => ({
  config: {
    id,
    host: "alias",
    user: "me",
    hostname: "example.com",
    port: null,
    identityFile: null,
    displayName,
  },
  runtime,
})

const state = (servers: SshServerItem[]): SshServersState => ({
  runtime: null,
  servers,
  probes: {},
  forgeChecks: {},
  prompt: null,
  job: null,
})

describe("readySshConnections", () => {
  test("publishes only ready servers, keyed identically to the managed id", () => {
    const connections = readySshConnections(
      state([
        item("ssh:me@example.com", { kind: "ready", url: "http://127.0.0.1:4200", username: "forge", password: "pw" }),
        item("ssh:me@other", { kind: "starting" }),
        item("ssh:me@down", { kind: "failed", message: "x" }),
        item("ssh:me@named", { kind: "ready", url: "http://127.0.0.1:4201", username: "forge", password: "pw" }, "Prod"),
      ]),
    )
    expect(connections).toHaveLength(2)
    const conn = connections[0]
    expect(conn.type).toBe("ssh")
    expect(conn.http).toEqual({ url: "http://127.0.0.1:4200", username: "forge", password: "pw" })
    // `ServerConnection.key(conn)` produces `ssh:${conn.host}` — must equal the
    // managed server id or removal/health lookups silently miss.
    expect(`ssh:${conn.host}`).toBe("ssh:me@example.com")
    expect(connections[1].displayName).toBe("Prod")
  })

  test("returns empty without state or ready servers", () => {
    expect(readySshConnections(undefined)).toEqual([])
    expect(readySshConnections(state([]))).toEqual([])
  })
})

describe("availableStartupServer", () => {
  test("keeps an ssh default only while its connection is ready", () => {
    const ssh = state([
      item("ssh:me@example.com", { kind: "ready", url: "http://127.0.0.1:1", username: null, password: null }),
    ])
    expect(availableStartupServer("ssh:me@example.com", undefined, ssh)).toBe("ssh:me@example.com")
  })

  test("falls back to the sidecar for a missing or unready ssh default", () => {
    const ssh = state([item("ssh:me@example.com", { kind: "failed", message: "x" })])
    expect(availableStartupServer("ssh:me@example.com", undefined, ssh)).toBe("sidecar")
    expect(availableStartupServer("ssh:me@never-configured", undefined, ssh)).toBe("sidecar")
    expect(availableStartupServer("ssh:me@example.com", undefined, undefined)).toBe("sidecar")
  })

  test("keeps non-managed keys and defaults to sidecar untouched", () => {
    expect(availableStartupServer(null, undefined, undefined)).toBe("sidecar")
    expect(availableStartupServer("sidecar", undefined, undefined)).toBe("sidecar")
    expect(availableStartupServer("local\nhttp://localhost:4096", undefined, undefined)).toBe(
      "local\nhttp://localhost:4096",
    )
  })
})
