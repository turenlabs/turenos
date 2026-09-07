import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { LLM } from "@turenlabs/llm"
import { MuseCodeBridge } from "../src/session/runner/muse-code-bridge"
import { MuseCodeCLI } from "../src/provider/muse-code"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

// No live API or credentials: the real installed CLI talks only to this local
// scripted provider. Re-run this qualification before changing SUPPORTED_VERSION.
test.skipIf(process.env.FORGE_TEST_MUSE !== "1")(
  "real Muse denies forced native work tools while allowing only host MCP tools",
  async () => {
    const executable = MuseCodeCLI.resolveExecutable(undefined)
    expect(executable).toBeDefined()
    const directory = mkdtempSync(join(tmpdir(), "turen-muse-isolation-"))
    const canary = join(directory, "canary.txt")
    const mutation = join(directory, "unexpected.txt")
    const forbidden = [
      ["read_file", { path: canary }],
      ["search", { pattern: "CANARY", paths: [directory] }],
      ["write_file", { path: mutation, content: "unexpected" }],
      ["edit_file", { path: canary, find: "CANARY", replace: "CHANGED" }],
      ["bash", { command: "printf unexpected", description: "Test native rejection" }],
      ["read_memory", { path: "probe.md" }],
      ["add_memory", { path: "probe.md", content: "unexpected" }],
      ["workflow", { name: "probe", script: "return { status: 'unexpected' }" }],
      ["subagent_spawn", { prompt: "Do not perform work" }],
      ["web_fetch", { url: "https://example.invalid" }],
    ] as const
    const schemas: string[][] = []
    const mcpCalls: string[] = []
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/muse-code/models")
          return Response.json({
            object: "list",
            data: [
              {
                id: "fake-model",
                object: "model",
                metadata: {
                  "muse-code": {
                    release_date: "2026-01-01",
                    is_hidden: false,
                    limit: { context: 1_000_000, output: 1024 },
                  },
                },
              },
            ],
          })
        if (request.method !== "POST") return new Response(null, { status: 405 })
        const body = record(await request.json())
        if (pathname === "/mcp") {
          if (request.headers.get("authorization") !== "Bearer isolation-test")
            return new Response(null, { status: 401 })
          if (body.id === undefined) return new Response(null, { status: 202 })
          if (body.method === "tools/call") mcpCalls.push(String(record(body.params).name))
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "initialize"
                ? {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: { name: "forge", version: "1" },
                  }
                : body.method === "tools/list"
                  ? {
                      tools: [
                        {
                          name: "bridge_probe",
                          description: "Return verification marker",
                          inputSchema: { type: "object", properties: {} },
                        },
                      ],
                    }
                  : { content: [{ type: "text", text: "MCP_ISOLATION_OK" }] },
          })
        }
        if (pathname !== "/responses") return new Response(null, { status: 404 })
        schemas.push(
          (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) => {
            const value = record(tool)
            return Array.isArray(value.tools)
              ? value.tools.map((item) => String(record(item).name))
              : [String(value.name)]
          }),
        )
        const turn = requests++
        const response = {
          id: `resp_${turn}`,
          object: "response",
          model: "fake-model",
          status: "completed",
          output: [],
        }
        const calls = turn === 0 ? forbidden : turn === 1 ? [["mcp__forge__bridge_probe", {}] as const] : []
        const frames = [
          { type: "response.created", sequence_number: 1, response: { ...response, status: "in_progress" } },
          ...calls.map(([name, args], index) => ({
            type: "response.function_call_arguments.done",
            sequence_number: index + 2,
            output_index: index,
            item_id: `fc_${turn}_${index}`,
            name,
            call_id: `call_${turn}_${index}`,
            arguments: JSON.stringify(args),
          })),
          ...(calls.length
            ? []
            : [
                {
                  type: "response.output_text.delta",
                  sequence_number: 2,
                  output_index: 0,
                  item_id: "msg_done",
                  content_index: 0,
                  delta: "ISOLATION_COMPLETE",
                },
              ]),
          {
            type: "response.completed",
            sequence_number: calls.length + 3,
            response: { ...response, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          },
        ]
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    try {
      mkdirSync(join(directory, "muse"))
      mkdirSync(join(directory, "workspace"))
      writeFileSync(canary, "CANARY_NATIVE_READ_MUST_NOT_RETURN")
      const model = MuseCodeBridge.routeModel({
        providerID: "muse-code",
        modelID: "fake-model",
        executable: executable!,
        defaults: {},
      })
      const request = LLM.request({
        model,
        system: "Isolation test",
        messages: [{ role: "user", content: "Run the boundary probe" }],
      })
      writeFileSync(join(directory, "prompt.txt"), MuseCodeBridge.prompt(request))
      writeFileSync(
        join(directory, "muse", "settings.json"),
        JSON.stringify({
          ...MuseCodeBridge.settings(request, {
            url: new URL("mcp", server.url).toString(),
            authorization: "Bearer isolation-test",
          }),
          endpoint_transport: { base_url: server.url.toString().replace(/\/$/, ""), auth: "bearer" },
        }),
      )
      const env = { ...MuseCodeBridge.environment(directory), HOME: directory, META_API_KEY: "offline-test-dummy" }
      const version = await promisify(execFile)(executable!, ["--version"], { env, timeout: 10_000 })
      expect(version.stdout.trim()).toBe(MuseCodeBridge.SUPPORTED_VERSION)
      const result = await promisify(execFile)(executable!, MuseCodeBridge.args({ directory, modelID: "fake-model" }), {
        env,
        cwd: join(directory, "workspace"),
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => record(JSON.parse(line)))
      const results = events
        .filter((event) => event.payload_type === "tool.result")
        .map((event) => record(event.payload))
      for (const [name] of forbidden)
        expect(results.some((value) => String(value.text).includes(`unknown tool \`${name}\``))).toBe(true)
      expect(result.stdout).not.toContain("CANARY_NATIVE_READ_MUST_NOT_RETURN")
      expect(readFileSync(canary, "utf8")).toBe("CANARY_NATIVE_READ_MUST_NOT_RETURN")
      expect(existsSync(mutation)).toBe(false)
      expect(mcpCalls).toEqual(["bridge_probe"])
      expect(schemas.length).toBeGreaterThanOrEqual(3)
      for (const names of schemas)
        expect(names.filter((name) => !["bridge_probe", "write_todos", "tool_search"].includes(name))).toEqual([])
      expect(result.stdout).toContain("ISOLATION_COMPLETE")
    } finally {
      server.stop(true)
      rmSync(directory, { recursive: true, force: true })
    }
  },
  30_000,
)
