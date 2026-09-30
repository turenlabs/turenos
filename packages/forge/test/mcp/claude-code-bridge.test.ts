import { expect } from "bun:test"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { ToolDefinition } from "@turenlabs/llm"
import { ClaudeCodeMcp } from "@turenlabs/core/session/runner/claude-code-mcp-namespace"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Effect } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

/**
 * The Claude Code MCP bridge is the one StreamableHTTP MCP server this repo
 * ships for real — it fronts TurenOS tools for `claude` CLI children. Pointing
 * the TurenOS MCP client back at it exercises the hosted-server code path
 * (connectRemote, bearer headers, tools/call) end to end without credentials
 * or a mock transport.
 */
const it = testEffect(LayerNode.compile(LayerNode.group([MCP.testNode, EventV2.node])))

const tool = (name: string) =>
  new ToolDefinition({
    name,
    description: `${name} bridge tool`,
    inputSchema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
    },
  })

const bridge = (
  execute: (call: { readonly id: string; readonly name: string; readonly input: unknown }) => Effect.Effect<
    { type: "content"; value: Array<{ type: "text"; text: string }> },
    unknown
  >,
) =>
  Effect.gen(function* () {
    const token = yield* ClaudeCodeMcp.register({ definitions: [tool("spawn_agent"), tool("read")], execute })
    return yield* ClaudeCodeMcp.serve(token)
  })

function statusFor(status: Record<string, MCPNS.Status> | MCPNS.Status | undefined, server: string) {
  if (!status) return undefined
  if ("status" in status) return status
  return status[server]
}

it.instance("connects to the Claude Code MCP bridge over HTTP and calls its tools", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly id: string; readonly name: string; readonly input: unknown }> = []
    const server = yield* bridge((call) =>
      Effect.sync(() => calls.push(call)).pipe(
        Effect.as({ type: "content" as const, value: [{ type: "text" as const, text: `Executed ${call.name}` }] }),
      ),
    )
    const mcp = yield* MCP.Service
    const added = yield* mcp.add("claude-bridge", {
      type: "remote",
      url: server.url,
      headers: { authorization: server.authorization },
      oauth: false,
    })

    expect(statusFor(added.status, "claude-bridge")?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools()).sort()).toEqual(["claude-bridge_read", "claude-bridge_spawn_agent"])

    const client = (yield* mcp.clients())["claude-bridge"]
    expect(client).toBeDefined()
    const result = yield* Effect.promise(() =>
      client!.callTool({ name: "spawn_agent", arguments: { marker: "bridge-e2e" } }, CallToolResultSchema),
    )
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: "text", text: "Executed spawn_agent" }])
    expect(calls).toEqual([
      { id: expect.stringMatching(/^mcp_[0-9a-f]{64}$/), name: "spawn_agent", input: { marker: "bridge-e2e" } },
    ])
  }),
)

it.instance("reports a failure, not a silent hang, when the bridge rejects the bearer token", () =>
  Effect.gen(function* () {
    const server = yield* bridge(() => Effect.succeed({ type: "content" as const, value: [] }))
    const mcp = yield* MCP.Service
    const added = yield* mcp.add("claude-bridge-bad-auth", {
      type: "remote",
      url: server.url,
      headers: { authorization: "Bearer wrong" },
      oauth: false,
    })

    const status = statusFor(added.status, "claude-bridge-bad-auth")
    expect(status?.status).toBe("failed")
    if (status?.status !== "failed") return
    // The SDK's raw transport noise ("SSE error: Non-200 status code (404)")
    // must reach the user as an actionable statement instead.
    expect(status.error).toContain("HTTP 404")
    expect(status.error).not.toContain("SSE error")
    expect((yield* mcp.status())["claude-bridge-bad-auth"]).toMatchObject({ status: "failed" })
  }),
)
