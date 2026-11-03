import { describe, expect } from "bun:test"
import { LLM, ToolDefinition } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { ModelV2 } from "@turenlabs/core/model"
import { AntigravityAcpCLI } from "@turenlabs/core/provider/antigravity-acp"
import { ClaudeCodeMcp } from "@turenlabs/core/session/runner/claude-code-mcp-namespace"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { Effect, Layer, Schema, Stream } from "effect"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { it } from "./lib/effect"

const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
const marker = "MCP_ROUNDTRIP_PROVED"
const definitions = [
  new ToolDefinition({
    name: "bridge_probe",
    description: "Return the supplied verification marker without accessing workspace data",
    inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
  }),
]
const captureSchema = Schema.Struct({
  pid: Schema.Number,
  cwd: Schema.String,
  unauthorizedStatus: Schema.optional(Schema.Number),
  permissionOption: Schema.optional(Schema.String),
  mcpURL: Schema.optional(Schema.String),
  lineBytes: Schema.optional(Schema.Number),
  attemptedOutputBytes: Schema.optional(Schema.Number),
})

const fakeAcpServer = (body: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(tmpdir(), "turen-acp-mcp-test-"))
      const executable = path.join(directory, "agy_acp_server.par")
      const capture = path.join(directory, "capture.json")
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          `import { createInterface } from "node:readline"`,
          `import { writeFileSync } from "node:fs"`,
          `import { once } from "node:events"`,
          `const capture = ${JSON.stringify(capture)}`,
          `const state = { pid: process.pid, cwd: process.cwd() }`,
          `const save = () => writeFileSync(capture, JSON.stringify(state))`,
          `save()`,
          `const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")`,
          `const rl = createInterface({ input: process.stdin })`,
          `process.stdout.on("error", () => {})`,
          body,
          "",
        ].join("\n"),
      )
      chmodSync(executable, 0o755)
      return { executable, capture }
    }),
    (child) => Effect.sync(() => rmSync(path.dirname(child.executable), { recursive: true, force: true })),
  )

const model = (executable: string) =>
  SessionRunnerModel.fromCatalogModel(
    ModelV2.Info.make({
      id: ModelV2.ID.make("gemini-3.8-flash"),
      providerID: AntigravityAcpCLI.ID,
      name: "Gemini 3.8 Flash",
      api: { type: "native", id: ModelV2.ID.make("gemini-3.8-flash"), url: AntigravityAcpCLI.API_URL, settings: {} },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      request: { headers: {}, body: { executable } },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 1_000_000, output: 65_536 },
    }),
  )

const requireCleanup = (capture: string) => {
  const captured = Schema.decodeUnknownSync(captureSchema)(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(readFileSync(capture, "utf8")),
  )
  expect(() => process.kill(captured.pid, 0)).toThrow()
  expect(existsSync(path.dirname(captured.cwd))).toBe(false)
  return captured
}

const mcpRoundtrip = `
let servers = []
let promptID
rl.on("line", async (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
  if (message.method === "session/new") {
    servers = message.params.mcpServers
    return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "mcp-test", configOptions: [{ id: "model", category: "model", type: "select" }] } })
  }
  if (message.method === "session/set_config_option") return send({ jsonrpc: "2.0", id: message.id, result: {} })
  if (message.method === "session/prompt") {
    promptID = message.id
    return send({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {
      sessionId: "mcp-test",
      toolCall: { toolCallId: "host-tool-1", title: "forge_bridge_probe", kind: "other", _meta: { is_mcp_tool_call: true, mcp: { server: "forge", tool: "bridge_probe" } } },
      options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "reject_once", kind: "reject_once", name: "Reject once" }]
    } })
  }
  if (message.id !== 99) return
  if (message.result?.outcome?.optionId !== "allow_once") throw new Error("Forge MCP permission was not approved")
  state.permissionOption = message.result.outcome.optionId
  const server = servers[0]
  if (!server || server.name !== "forge" || server.type !== "http") throw new Error("Missing Forge HTTP MCP server")
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map(item => [item.name, item.value])) }
  const post = async (id, method, params) => {
    const response = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) })
    if (response.headers.has("mcp-session-id")) headers["mcp-session-id"] = response.headers.get("mcp-session-id")
    if (!response.ok) throw new Error("MCP HTTP " + response.status)
    return response.status === 202 ? undefined : response.json()
  }
  const anonymous = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }) })
  state.unauthorizedStatus = anonymous.status
  await post(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "acp-test", version: "1" } })
  await post(undefined, "notifications/initialized", {})
  const listed = await post(2, "tools/list", {})
  if (!listed.result.tools.some(tool => tool.name === "bridge_probe")) throw new Error("Missing bridge_probe")
  const result = await post(3, "tools/call", { name: "bridge_probe", arguments: { marker: ${JSON.stringify(marker)} } })
  state.mcpURL = server.url
  save()
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "mcp-test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.result.content[0].text } } } })
  send({ jsonrpc: "2.0", id: promptID, result: { stopReason: "end_turn" } })
})
`

describe("Antigravity ACP host MCP transport", () => {
  it.live("executes a host tool over authenticated HTTP and cleans up the child, workspace, and listener", () =>
    Effect.gen(function* () {
      const child = yield* fakeAcpServer(mcpRoundtrip)
      const calls: { readonly name: string; readonly input: unknown }[] = []
      const token = yield* ClaudeCodeMcp.register({
        definitions,
        execute: (call) =>
          Effect.sync(() => {
            calls.push(call)
            const input = Schema.decodeUnknownSync(Schema.Struct({ marker: Schema.String }))(call.input)
            return { type: "text" as const, value: `host:${input.marker}` }
          }),
      })
      const resolved = yield* model(child.executable)
      const events = yield* LLM.stream(
        LLM.request({
          model: resolved,
          prompt: `Call bridge_probe with marker ${marker}`,
          tools: definitions,
          metadata: ClaudeCodeMcp.requestMetadata(token),
        }),
      ).pipe(Stream.runCollect, Effect.provide(layer), Effect.timeout("10 seconds"))
      expect(calls).toMatchObject([{ name: "bridge_probe", input: { marker } }])
      expect(calls).toHaveLength(1)
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe(`host:${marker}`)
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      const captured = requireCleanup(child.capture)
      expect(captured.unauthorizedStatus).toBe(404)
      expect(captured.permissionOption).toBe("allow_once")
      expect(captured.mcpURL).toBeDefined()
      expect(
        yield* Effect.promise(() =>
          fetch(captured.mcpURL!, { signal: AbortSignal.timeout(2_000) }).then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true)
    }),
  )

  for (const [name, body] of [
    ["per-line", `rl.on("line", () => process.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 97)))`],
    [
      "aggregate",
      `rl.on("line", async () => {
        const payload = JSON.stringify({ jsonrpc: "2.0", method: "test/noop", params: { padding: "a".repeat(1024 * 1024) } }) + "\\n"
        state.lineBytes = Buffer.byteLength(payload)
        for (let index = 0; index < 34; index++) {
          state.attemptedOutputBytes = (index + 1) * state.lineBytes
          save()
          if (!process.stdout.write(payload)) await once(process.stdout, "drain")
        }
      })`,
    ],
  ] as const) {
    it.live(`rejects stdout above the ${name} safety limit and removes its subprocess workspace`, () =>
      Effect.gen(function* () {
        const child = yield* fakeAcpServer(body)
        const resolved = yield* model(child.executable)
        const events = yield* LLM.stream(LLM.request({ model: resolved, prompt: "test output limit" })).pipe(
          Stream.runCollect,
          Effect.provide(layer),
          Effect.timeout("10 seconds"),
        )
        expect(events.at(-1)).toMatchObject({
          type: "provider-error",
          message: expect.stringContaining("bridge safety limit"),
        })
        const captured = requireCleanup(child.capture)
        if (name === "aggregate") {
          expect(captured.lineBytes).toBeLessThan(8 * 1024 * 1024)
          expect(captured.attemptedOutputBytes).toBeGreaterThan(32 * 1024 * 1024)
        }
      }),
    )
  }
})
