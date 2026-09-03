import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { McpPackageRuntime } from "../../src/mcp/package-runtime"
import { McpRuntime } from "../../src/mcp/runtime"

describe("managed MCP packages", () => {
  test("builds an isolated pinned Automox runtime", async () => {
    const executable = process.platform === "win32" ? "C:\\Turen\\uv-0.12.6.exe" : "/turen/bin/uv-0.12.6"
    const entry = await Effect.runPromise(
      McpPackageRuntime.configuration(
        "automox-local",
        { organizationId: "42" },
        { AUTOMOX_API_KEY: "secret-key", AUTOMOX_ACCOUNT_UUID: "account-uuid" },
        { ensureUv: async () => executable },
      ),
    )
    expect(entry).toMatchObject({
      type: "local",
      enabled: true,
      timeout: 120_000,
      command: [
        executable,
        "tool",
        "run",
        "--no-config",
        "--managed-python",
        "--exclude-newer",
        "2026-07-22T01:44:15Z",
        "--from",
        "automox-mcp==2.2.9",
        "automox-mcp",
      ],
    })
    if (!entry) throw new Error("Automox package runtime was unavailable")
    expect(entry).not.toHaveProperty("environment")
    expect(McpRuntime.serverFor(entry)).toMatchObject({
      backend: "package",
      executable,
      environment: {
        AUTOMOX_ORG_ID: "42",
        AUTOMOX_MCP_READ_ONLY: "true",
        AUTOMOX_MCP_SANITIZE_RESPONSES: "true",
        PATH: expect.any(String),
      },
      secrets: [
        { name: "AUTOMOX_API_KEY", secret: "AUTOMOX_API_KEY" },
        { name: "AUTOMOX_ACCOUNT_UUID", secret: "AUTOMOX_ACCOUNT_UUID" },
      ],
    })
    expect(McpRuntime.secretsFor(entry)).toEqual({
      AUTOMOX_API_KEY: "secret-key",
      AUTOMOX_ACCOUNT_UUID: "account-uuid",
    })
  })

  test("pins Falcon and forces the vendor read-only argument", async () => {
    const executable = process.platform === "win32" ? "C:\\Turen\\uv-0.12.6.exe" : "/turen/bin/uv-0.12.6"
    const entry = await Effect.runPromise(
      McpPackageRuntime.configuration(
        "crowdstrike-falcon",
        {},
        { FALCON_CLIENT_ID: "client", FALCON_CLIENT_SECRET: "secret" },
        { ensureUv: async () => executable },
      ),
    )
    expect(entry).toMatchObject({
      type: "local",
      command: [
        executable,
        "tool",
        "run",
        "--no-config",
        "--managed-python",
        "--exclude-newer",
        "2026-08-26T00:00:00Z",
        "--from",
        "falcon-mcp==0.16.1",
        "falcon-mcp",
        "--read-only",
      ],
    })
    if (!entry) throw new Error("Falcon package runtime was unavailable")
    expect(McpRuntime.serverFor(entry)).toMatchObject({
      backend: "package",
      environment: { FALCON_BASE_URL: "https://api.crowdstrike.com" },
      secrets: [
        { name: "FALCON_CLIENT_ID", secret: "FALCON_CLIENT_ID" },
        { name: "FALCON_CLIENT_SECRET", secret: "FALCON_CLIENT_SECRET" },
      ],
    })
    expect(
      await Effect.runPromise(
        McpPackageRuntime.configuration(
          "crowdstrike-falcon",
          { baseUrl: "https://credential-capture.example" },
          { FALCON_CLIENT_ID: "client", FALCON_CLIENT_SECRET: "secret" },
          { ensureUv: async () => executable },
        ),
      ),
    ).toBeUndefined()
  })
})
