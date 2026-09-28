import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Global } from "@turenlabs/core/global"
import { McpPackageRuntime } from "../../src/mcp/package-runtime"
import { McpRuntime } from "../../src/mcp/runtime"

function mcpItem(id: string) {
  for (const manifest of ExtensionCatalog.manifests) {
    const item = manifest.contributions.find((contribution) => contribution.type === "mcp" && contribution.id === id)
    if (item?.type === "mcp") return item
  }
  throw new Error(`missing catalog contribution: ${id}`)
}

describe("managed MCP packages", () => {
  test("builds the pinned credential-free AWS Documentation runtime", async () => {
    const executable = process.platform === "win32" ? "C:\\Turen\\uv-0.12.6.exe" : "/turen/bin/uv-0.12.6"
    const entry = await Effect.runPromise(
      McpPackageRuntime.configuration(mcpItem("aws-documentation"), {}, {}, { ensureUv: async () => executable }),
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
        "2026-09-08T15:03:45.578535Z",
        "--from",
        "awslabs.aws-documentation-mcp-server==1.2.1",
        "awslabs.aws-documentation-mcp-server",
      ],
    })
    if (!entry) throw new Error("AWS Documentation package runtime was unavailable")
    expect(McpRuntime.serverFor(entry)).toMatchObject({
      backend: "package",
      secrets: [],
      environment: { AWS_DOCUMENTATION_PARTITION: "aws", FASTMCP_LOG_LEVEL: "ERROR" },
    })
  })

  test("builds an isolated pinned Automox runtime", async () => {
    const executable = process.platform === "win32" ? "C:\\Turen\\uv-0.12.6.exe" : "/turen/bin/uv-0.12.6"
    const entry = await Effect.runPromise(
      McpPackageRuntime.configuration(
        mcpItem("automox-local"),
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
        mcpItem("crowdstrike-falcon"),
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
        "2026-09-01T17:26:00Z",
        "--from",
        "falcon-mcp==0.19.0",
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
          mcpItem("crowdstrike-falcon"),
          { baseUrl: "https://credential-capture.example" },
          { FALCON_CLIENT_ID: "client", FALCON_CLIENT_SECRET: "secret" },
          { ensureUv: async () => executable },
        ),
      ),
    ).toBeUndefined()
  })

  test("a user's own falcon-mcp install does not own the managed alias", async () => {
    const item = mcpItem("crowdstrike-falcon")
    // Someone who already ran falcon-mcp themselves (uvx, pip, Claude Desktop
    // config) cannot collide with the managed slot: ownership requires the
    // exact pinned recipe, so their entry triggers "Conflicting MCP runtime
    // configuration" instead of being silently adopted or overwritten.
    const handInstalled = { type: "local" as const, command: ["falcon-mcp", "--read-only"], enabled: true }
    const uvxInstalled = {
      type: "local" as const,
      command: ["uvx", "falcon-mcp@0.19.0", "--read-only"],
      enabled: true,
      timeout: 120_000,
    }
    expect(McpPackageRuntime.owns(item, handInstalled)).toBe(false)
    expect(McpPackageRuntime.owns(item, uvxInstalled)).toBe(false)
    expect(McpPackageRuntime.owns(item, undefined)).toBe(true)

    // Ownership is stricter than config shape: the command must name the
    // managed uv binary itself, not just any recipe-shaped entry.
    const executable = path.join(Global.Path.bin, `uv-0.12.6${process.platform === "win32" ? ".exe" : ""}`)
    const managed = await Effect.runPromise(
      McpPackageRuntime.configuration(
        item,
        {},
        { FALCON_CLIENT_ID: "client", FALCON_CLIENT_SECRET: "secret" },
        { ensureUv: async () => executable },
      ),
    )
    if (!managed) throw new Error("Falcon package runtime was unavailable")
    expect(McpPackageRuntime.matches(item, managed)).toBe(true)
    expect(
      McpPackageRuntime.owns(item, { ...managed, environment: { FALCON_DEBUG: "1" } }),
    ).toBe(false)
    expect(McpPackageRuntime.owns(item, { ...managed, timeout: 30_000 })).toBe(false)
  })
})
