import { expect } from "bun:test"
import { ToolDefinition } from "@turenlabs/llm"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { ClaudeCodeBridge } from "@turenlabs/core/session/runner/claude-code-bridge"
import { ClaudeCodeMcp } from "@turenlabs/core/session/runner/claude-code-mcp-namespace"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { it } from "./lib/effect"

const tool = (name: string) =>
  new ToolDefinition({
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
    },
  })

const definitions = [tool("spawn_agent"), tool("wait_agents"), tool("read")]

it.live("serves policy-filtered tools and returns annotated results", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly name: string; readonly input: unknown }> = []
    const token = yield* ClaudeCodeMcp.register({
      definitions,
      execute: (call) =>
        Effect.sync(() => calls.push(call)).pipe(
          Effect.as({
            type: "content" as const,
            value: [
              { type: "text" as const, text: `Executed ${call.name}` },
              { type: "text" as const, text: "Quality ratchet: preserve the complete tool result." },
            ],
          }),
        ),
    })
    const server = yield* ClaudeCodeMcp.serve(token)
    const client = new Client({ name: "forge-test", version: "1" })
    yield* Effect.acquireRelease(
      Effect.promise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: { Authorization: server.authorization } },
          }),
        ),
      ),
      () => Effect.promise(() => client.close()),
    )

    expect((yield* Effect.promise(() => client.listTools())).tools.map((tool) => tool.name)).toEqual(
      definitions.map((tool) => tool.name),
    )
    const result = yield* Effect.promise(() =>
      client.callTool({ name: "spawn_agent", arguments: { marker: "durable" } }),
    )

    expect(result.content).toEqual([
      { type: "text", text: "Executed spawn_agent" },
      { type: "text", text: "Quality ratchet: preserve the complete tool result." },
    ])
    expect(calls).toMatchObject([{ name: "spawn_agent", input: { marker: "durable" } }])
    const unavailable = yield* Effect.promise(() =>
      client.callTool({ name: "update_goal", arguments: { status: "complete" } }),
    )
    expect(unavailable.isError).toBe(true)
    expect(calls).toHaveLength(1)
  }),
)

// `outputSchema` is never served, whatever its shape. Two reasons with different
// histories: the MCP SDK's ToolSchema hard-rejects non-object schemas (one such
// tool used to kill the whole bridge), and object schemas were pure overhead —
// no direct provider path ships output schemas, the CLI treats their absence as
// "unstructured result", and forwarding them roughly doubled the per-tool bytes
// on every internal CLI round trip.
it.live("serves tools without their outputSchema, whatever its shape", () =>
  Effect.gen(function* () {
    const stringOutput = new ToolDefinition({
      name: "string_output",
      description: "string_output test tool",
      inputSchema: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
      },
      outputSchema: { type: "string" },
    })
    const objectOutput = new ToolDefinition({
      name: "object_output",
      description: "object_output test tool",
      inputSchema: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
      },
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
    })
    const token = yield* ClaudeCodeMcp.register({
      definitions: [tool("spawn_agent"), stringOutput, objectOutput],
      execute: () => Effect.succeed({ type: "text", value: "unused" }),
    })
    const server = yield* ClaudeCodeMcp.serve(token)
    expect(server.tools).toEqual(["spawn_agent", "string_output", "object_output"])
    const client = new Client({ name: "forge-test", version: "1" })
    yield* Effect.acquireRelease(
      Effect.promise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: { Authorization: server.authorization } },
          }),
        ),
      ),
      () => Effect.promise(() => client.close()),
    )

    const listed = (yield* Effect.promise(() => client.listTools())).tools
    expect(listed.map((entry) => entry.name)).toEqual(["spawn_agent", "string_output", "object_output"])
    for (const served of listed) {
      expect(served.outputSchema).toBeUndefined()
      expect(Object.keys(served)).not.toContain("outputSchema")
    }
  }),
)

it.live("rejects requests without the turn capability", () =>
  Effect.gen(function* () {
    const token = yield* ClaudeCodeMcp.register({
      definitions,
      execute: () => Effect.succeed({ type: "text", value: "unused" }),
    })
    const server = yield* ClaudeCodeMcp.serve(token)
    const response = yield* Effect.promise(() => fetch(server.url, { method: "POST", body: "{}" }))
    expect(response.status).toBe(404)
  }),
)

it.live("injects adaptive workflow context after repeated serial exploration batches", () =>
  Effect.gen(function* () {
    const token = yield* ClaudeCodeMcp.register({
      definitions,
      execute: () => Effect.succeed({ type: "text", value: "unused" }),
    })
    const server = yield* ClaudeCodeMcp.serve(token)
    const post = (tool_name: string, tool_input: Record<string, unknown>) =>
      Effect.promise(() =>
        fetch(server.hookUrl, {
          method: "POST",
          headers: { Authorization: server.authorization, "Content-Type": "application/json" },
          body: JSON.stringify({
            hook_event_name: "PostToolBatch",
            tool_calls: [{ tool_name, tool_input, tool_use_id: `tool-${tool_name}` }],
          }),
        }).then((response) => response.json()),
      )

    expect(yield* post("mcp__forge__grep", { pattern: "first" })).toEqual({})
    expect(yield* post("mcp__forge__bash", { command: "ls packages" })).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: expect.stringContaining("exploring one tool call at a time"),
      },
    })
    expect(yield* post("mcp__forge__spawn_agent", { agent: "explore" })).toEqual({})
    expect(yield* post("mcp__forge__read", { path: "README.md" })).toEqual({})
    const denied = yield* Effect.promise(() => fetch(server.hookUrl, { method: "POST", body: "{}" }))
    expect(denied.status).toBe(404)
    const oversized = yield* Effect.promise(() =>
      fetch(server.hookUrl, {
        method: "POST",
        headers: { Authorization: server.authorization },
        body: "x".repeat(2 * 1024 * 1024 + 1),
      }),
    )
    expect(oversized.status).toBe(413)
  }),
)

const liveClaude = process.env.FORGE_LIVE_CLAUDE === "1" ? it.live : it.live.skip

liveClaude(
  "lets the real Claude print-mode CLI call a TurenOS MCP tool with built-ins disabled",
  () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const token = yield* ClaudeCodeMcp.register({
        definitions: [tool("spawn_agent")],
        execute: (call) =>
          Effect.sync(() => calls.push(call.name)).pipe(Effect.as({ type: "text", value: "accepted" })),
      })
      const server = yield* ClaudeCodeMcp.serve(token)
      const directory = mkdtempSync(path.join(tmpdir(), "forge-claude-mcp-live-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
      const systemFile = path.join(directory, "system.txt")
      const mcpFile = path.join(directory, "mcp.json")
      const settingsFile = path.join(directory, "settings.json")
      const hookMarker = path.join(directory, "hook-ran")
      mkdirSync(path.join(directory, ".claude"))
      writeFileSync(
        path.join(directory, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${hookMarker}` }] }],
          },
        }),
      )
      writeFileSync(systemFile, "Call the requested TurenOS MCP tool exactly once.", { mode: 0o600 })
      writeFileSync(
        mcpFile,
        JSON.stringify({
          mcpServers: {
            forge: { type: "http", url: server.url, headers: { Authorization: server.authorization } },
          },
        }),
        { mode: 0o600 },
      )
      writeFileSync(
        settingsFile,
        JSON.stringify({
          allowedHttpHookUrls: [server.hookUrl],
          hooks: {
            PostToolBatch: [
              {
                hooks: [
                  {
                    type: "http",
                    url: server.hookUrl,
                    headers: { Authorization: server.authorization },
                    timeout: 2,
                  },
                ],
              },
            ],
          },
        }),
        { mode: 0o600 },
      )
      const child = spawn("claude", ClaudeCodeBridge.args({ modelID: "haiku", systemFile, mcpFile, settingsFile }), {
        cwd: directory,
        env: ClaudeCodeCLI.subscriptionEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      })
      child.stdin.end('Call spawn_agent with {"marker":"live"}, then reply exactly LIVE_MCP_OK.')
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => child.kill("SIGKILL")))
      const code = yield* Effect.promise(() => Promise.race([exited, Bun.sleep(60_000).then(() => -1)]))
      if (code === -1) child.kill("SIGKILL")
      expect(code).toBe(0)
      expect(calls).toEqual(["spawn_agent"])
      expect(existsSync(hookMarker)).toBe(false)
    }),
  70_000,
)
