import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Effect } from "effect"
import path from "node:path"
import { resolveSecurityMcpCommand } from "@/mcp"
import { tmpdir } from "../fixture/fixture"

test("source-launched security MCP resolves scanner paths inside the selected workspace", async () => {
  await using workspace = await tmpdir({
    init: async (directory) => {
      await Bun.write(path.join(directory, ".github/workflows/unsafe.yml"), "name: workspace fixture\n")
      await Bun.write(path.join(directory, ".github/workflows/safe.yml"), "name: second workspace fixture\n")
    },
  })
  const command = await Effect.runPromise(resolveSecurityMcpCommand(workspace.path))
  expect(command).toBeDefined()
  const client = new Client({ name: "security-workspace-test", version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: command![0]!,
    args: command!.slice(1),
    cwd: workspace.path,
    // No scanner executable: successful path validation must return the install hint,
    // without running a scanner, fetching rules, or requiring a local installation.
    env: {
      PATH: "",
      FORGE_SECURITY_INTEGRATIONS: "opengrep",
      XDG_DATA_HOME: path.join(workspace.path, "data"),
      XDG_CONFIG_HOME: path.join(workspace.path, "config"),
      XDG_CACHE_HOME: path.join(workspace.path, "cache"),
      XDG_STATE_HOME: path.join(workspace.path, "state"),
    },
    stderr: "pipe",
  })
  try {
    await client.connect(transport)
    for (const target of [
      ".github/workflows/unsafe.yml",
      ".github/workflows/safe.yml",
      path.join(workspace.path, ".github/workflows/safe.yml"),
    ]) {
      const result = await client.callTool({ name: "opengrep_scan", arguments: { path: target } })
      expect(result).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining('"installed":false') }],
      })
      expect(result.isError).not.toBe(true)
    }
    for (const target of [process.cwd(), ".."]) {
      const outside = await client.callTool({ name: "opengrep_scan", arguments: { path: target } })
      expect(outside.isError).toBe(true)
      expect(outside.content).toMatchObject([{ type: "text", text: expect.stringContaining("inside the workspace") }])
    }
    const missing = await client.callTool({ name: "opengrep_scan", arguments: { path: "missing.yml" } })
    expect(missing.isError).toBe(true)
    expect(missing.content).toMatchObject([{ type: "text", text: expect.stringContaining("does not exist") }])
  } finally {
    await client.close()
  }
}, 30_000)
