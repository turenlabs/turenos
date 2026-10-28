import { describe, expect } from "bun:test"
import { LLM } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelV2 } from "../src/model"
import { DevinCLI } from "../src/provider/devin-cli"
import { SessionMessage } from "../src/session/message"
import { FileAttachment } from "../src/session/prompt"
import { DevinACP } from "../src/session/runner/devin-acp"
import { ClaudeCodeMcp } from "../src/session/runner/claude-code-mcp-namespace"
import { SessionRunnerModel } from "../src/session/runner/model"
import { toLLMMessages } from "../src/session/runner/to-llm-message"
import { it } from "./lib/effect"

const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
const catalogModel = (executable: string) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("default"),
    providerID: DevinCLI.ID,
    name: "Devin default",
    api: { type: "native", id: ModelV2.ID.make("default"), url: DevinCLI.API_URL, settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { executable } },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 32_768, output: 8_192 },
  })

const fakeCLI = (body: string, version = DevinACP.SUPPORTED_VERSION, delayedSession = false) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(join(tmpdir(), "devin-test-"))
      const executable = join(directory, "devin")
      const capture = join(directory, "capture.jsonl")
      const release = join(directory, "release-session")
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          `if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0) }`,
          `import { createInterface } from "node:readline"`,
          `import { appendFileSync, existsSync, readFileSync } from "node:fs"`,
          `const capture = ${JSON.stringify(capture)}`,
          delayedSession
            ? `process.on("SIGTERM", () => appendFileSync(capture, JSON.stringify({ event: "term" }) + "\\n"))`
            : "",
          `const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")`,
          `const reply = (request, result) => send({ jsonrpc: "2.0", id: request.id, result })`,
          `let promptRequest`,
          `appendFileSync(capture, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, settings: JSON.parse(readFileSync(process.argv[process.argv.indexOf("--config") + 1], "utf8")) }) + "\\n")`,
          `for await (const line of createInterface({ input: process.stdin })) {`,
          `const request = JSON.parse(line)`,
          `appendFileSync(capture, JSON.stringify(request) + "\\n")`,
          `if (request.method === "initialize") { reply(request, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }); continue }`,
          `if (request.method === "session/new") { ${delayedSession ? `const timer = setInterval(() => { if (!existsSync(${JSON.stringify(release)})) return; clearInterval(timer); reply(request, { sessionId: "test-session" }); appendFileSync(capture, JSON.stringify({ event: "session-ready" }) + "\\n") }, 5)` : `reply(request, { sessionId: "test-session" })`}; continue }`,
          body,
          `}`,
        ].join("\n"),
      )
      chmodSync(executable, 0o755)
      return { directory, executable, capture, release }
    }),
    (cli) => Effect.sync(() => rmSync(cli.directory, { recursive: true, force: true })),
  )
const textReply = `if (request.method === "session/prompt") {
send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } })
reply(request, { stopReason: "end_turn" })
}`
const collect = (
  executable: string,
  messages: Parameters<typeof LLM.request>[0]["messages"] = [{ role: "user", content: "hello" }],
) =>
  Effect.gen(function* () {
    const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(executable))
    return Array.from(
      yield* LLM.stream(LLM.request({ model, system: "Host system rules", messages })).pipe(Stream.runCollect),
    )
  }).pipe(Effect.provide(layer))
const captures = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

describe.skipIf(process.platform === "win32")("Devin ACP transport", () => {
  it.effect("validates split UTF-8 frames and drops optional vendor notifications", () =>
    Effect.promise(async () => {
      const { zSessionNotification, zRequestPermissionRequest } = await import(
        "@agentclientprotocol/sdk/dist/schema/zod.gen.js"
      )
      const wire = `${JSON.stringify({ jsonrpc: "2.0", method: "_cognition.ai/mcp/serversChanged", params: { private: "not-forwarded" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 0, result: { value: "caf\u00e9" } })}\n`
      const bytes = new TextEncoder().encode(wire)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          bytes.forEach((byte) => controller.enqueue(Uint8Array.of(byte)))
          controller.close()
        },
      })
      const decoded = await new Response(
        DevinACP.frames(stream, { zSessionNotification, zRequestPermissionRequest }, new Set([0])),
      ).text()
      expect(decoded).not.toContain("not-forwarded")
      expect(JSON.parse(decoded)).toEqual({ jsonrpc: "2.0", id: 0, result: { value: "caf\u00e9" } })
    }),
  )

  it.effect("rejects malformed, incomplete, and unsupported ACP frames before SDK dispatch", () =>
    Effect.promise(async () => {
      const { zSessionNotification, zRequestPermissionRequest } = await import(
        "@agentclientprotocol/sdk/dist/schema/zod.gen.js"
      )
      for (const input of [
        "not-json\n",
        "{}\n",
        '{"jsonrpc":"2.0","id":1}',
        '{"jsonrpc":"2.0","id":"SECRET_CANARY","result":{}}\n',
        '{"jsonrpc":"2.0","id":99,"result":{}}\n',
        '{"jsonrpc":"2.0","id":0,"error":null}\n',
        '{"jsonrpc":"2.0","id":0,"error":{}}\n',
        '{"jsonrpc":"2.0","id":0,"error":{"code":"bad","message":"SECRET_CANARY"}}\n',
        '{"jsonrpc":"2.0","id":0,"result":{},"error":{"code":1,"message":"SECRET_CANARY"}}\n',
        JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { secret: "invalid" } }) + "\n",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "fs/write_text_file",
          params: { path: "/denied", content: "secret" },
        }) + "\n",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/update", params: {} }) + "\n",
      ]) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(input))
            controller.close()
          },
        })
        await expect(
          new Response(
            DevinACP.frames(stream, { zSessionNotification, zRequestPermissionRequest }, new Set([0])),
          ).text(),
        ).rejects.toThrow()
      }
    }),
  )

  it.effect("resolves the registered provider to an ACP transport", () =>
    Effect.gen(function* () {
      const info = catalogModel("devin")
      expect(SessionRunnerModel.supported(info)).toBe(true)
      expect(SessionRunnerModel.selectable(info)).toBe(true)
      expect((yield* SessionRunnerModel.fromCatalogModel(info)).route.id).toBe("devin-acp")
    }),
  )

  it.effect("streams one ACP response and does not invent usage", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply)
      const events = yield* collect(cli.executable)
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "hello" })
      expect(events.find((event) => event.type === "finish")?.usage).toBeUndefined()
      const requests = captures(cli.capture)
      expect(requests.find((item) => item.method === "initialize")).toMatchObject({
        params: { clientCapabilities: {} },
      })
      expect(requests.find((item) => item.method === "session/prompt")).toMatchObject({
        params: { prompt: [{ type: "text", text: "USER:\nhello" }] },
      })
    }),
  )

  it.effect("replays image history as an explicit text placeholder", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply)
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(cli.executable))
      const messages = toLLMMessages(
        [
          SessionMessage.User.make({
            id: SessionMessage.ID.make("msg_image_history"),
            type: "user",
            text: "Earlier image",
            files: [FileAttachment.make({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "old.png" })],
            time: { created: DateTime.makeUnsafe(0) },
          }),
          SessionMessage.User.make({
            id: SessionMessage.ID.make("msg_text_after_image"),
            type: "user",
            text: "Continue in text",
            time: { created: DateTime.makeUnsafe(1) },
          }),
        ],
        model,
      )
      const events = Array.from(
        yield* LLM.stream(LLM.request({ model, messages })).pipe(Stream.runCollect, Effect.provide(layer)),
      )
      expect(events.at(-1)?.type).toBe("finish")
      const request = JSON.stringify(captures(cli.capture).find((item) => item.method === "session/prompt"))
      expect(request).toContain("attachment omitted: this model accepts text input only")
      expect(request).toContain("Continue in text")
      expect(request).not.toContain("aGVsbG8=")
    }),
  )

  it.effect("replays large image tool results without embedding their bytes", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply)
      const events = yield* collect(cli.executable, [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "image-result",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Image result description" },
                  {
                    type: "file",
                    uri: `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`,
                    mime: "image/png",
                    name: "large.png",
                  },
                ],
              },
            },
          ],
        },
        { role: "user", content: "Continue in text" },
      ])
      expect(events.at(-1)?.type).toBe("finish")
      const request = JSON.stringify(captures(cli.capture).find((item) => item.method === "session/prompt"))
      expect(request).toContain("Image result description")
      expect(request).toContain("image/png attachment large.png omitted: text-only history")
      expect(request).not.toContain("data:image/png")
    }),
  )

  it.effect("isolates config, history, home, native tools, and cleanup", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply)
      yield* collect(cli.executable)
      const capture = captures(cli.capture)[0]!
      expect(capture.argv).not.toContain("--cloud")
      expect(capture.argv).not.toContain("--resume")
      expect(capture.argv).not.toContain("--model")
      expect(capture.settings).toMatchObject({
        auto_update: false,
        subagents_enabled: false,
        agent: { codex_tools: false },
        permissions: { allow: ["mcp__forge__*"] },
      })
      const settings = capture.settings as ReturnType<typeof DevinACP.settings>
      expect(settings.disabled_tools).toEqual(DevinACP.NATIVE_TOOLS)
      expect(Object.values(settings.read_config_from)).toEqual(Array(8).fill(false))
      expect(settings.hooks.PreToolUse[0]!.hooks[0]).toMatchObject({ fail_closed: true, timeout: 5 })
      const env = capture.env as NodeJS.ProcessEnv
      expect(capture.cwd).toContain("/workspace")
      expect(env.HOME).not.toBe(process.env.HOME)
      expect(env.DEVIN_SESSIONS_DIR).not.toContain(".local/share/devin")
      expect(existsSync(env.HOME!)).toBe(false)
    }),
  )

  it.effect("fails before ACP startup on an unqualified CLI build", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply, "devin unqualified")
      const result = yield* collect(cli.executable).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Unsupported Devin CLI build")
      expect(existsSync(cli.capture)).toBe(false)
    }),
  )

  it.effect("fails closed on an RPC failure or EOF without repeating a prompt", () =>
    Effect.gen(function* () {
      for (const body of [
        `if (request.method === "session/prompt") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required: secret-value" } }) }`,
        `if (request.method === "session/prompt") process.exit(1)`,
      ]) {
        const cli = yield* fakeCLI(body)
        const events = yield* collect(cli.executable)
        expect(events.at(-1)).toMatchObject({ type: "provider-error", retryable: false })
        expect(events.some((event) => event.type === "finish")).toBe(false)
        expect(JSON.stringify(events)).not.toContain("secret-value")
        expect(captures(cli.capture).filter((item) => item.method === "session/prompt")).toHaveLength(1)
      }
    }),
  )

  it.effect("rejects native permission requests rather than granting host authority", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(`if (request.method === "session/prompt") {
promptRequest = request
send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "test-session", toolCall: { toolCallId: "native", title: "Write a file" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } })
}
if (request.id === "permission") reply(promptRequest, { stopReason: "end_turn" })`)
      yield* collect(cli.executable)
      expect(captures(cli.capture).find((item) => item.id === "permission")).toMatchObject({
        result: { outcome: { outcome: "cancelled" } },
      })
    }),
  )

  it.effect("passes only a scoped authenticated host MCP server", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply)
      const token = yield* ClaudeCodeMcp.register({
        definitions: [],
        execute: () => Effect.die("No tool should execute"),
      })
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(cli.executable))
      yield* LLM.stream(LLM.request({ model, prompt: "hello", metadata: ClaudeCodeMcp.requestMetadata(token) })).pipe(
        Stream.runDrain,
        Effect.provide(layer),
      )
      const request = captures(cli.capture).find((item) => item.method === "session/new")!
      expect(request.params).toMatchObject({
        mcpServers: [
          {
            type: "http",
            name: "forge",
            url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
            headers: [{ name: "Authorization", value: `Bearer ${token}` }],
          },
        ],
      })
    }),
  )

  it.effect("rejects media and oversized prompts before starting the ACP process", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply)
      for (const content of [
        [{ type: "media" as const, mediaType: "image/png", data: "aGVsbG8=" }],
        [{ type: "text" as const, text: "x".repeat(4 * 1024 * 1024) }],
      ]) {
        expect(Exit.isFailure(yield* collect(cli.executable, [{ role: "user", content }]).pipe(Effect.exit))).toBe(true)
        expect(existsSync(cli.capture)).toBe(false)
      }
    }),
  )

  it.effect("strips credentials, shell startup overrides, and Devin overrides", () =>
    Effect.sync(() => {
      const env = DevinACP.environment("/isolated", {
        HOME: "/home/user",
        PATH: "/bin",
        WINDSURF_API_KEY: "secret",
        DEVIN_MODEL: "other",
        DEVIN_REFUSAL_FALLBACK: "other",
        BASH_ENV: "/bad",
        ENV: "/bad",
        NODE_OPTIONS: "--require=/bad",
        OPENAI_API_KEY: "secret",
      })
      expect(env.HOME).toBe("/isolated/home")
      for (const key of [
        "WINDSURF_API_KEY",
        "DEVIN_MODEL",
        "DEVIN_REFUSAL_FALLBACK",
        "BASH_ENV",
        "ENV",
        "NODE_OPTIONS",
        "OPENAI_API_KEY",
      ])
        expect(env).not.toHaveProperty(key)
    }),
  )

  it.effect("guards every native tool and permits only the private MCP namespace", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(textReply)
      const guard = join(cli.directory, "guard.cjs")
      writeFileSync(guard, DevinACP.GUARD)
      for (const tool_name of [...DevinACP.NATIVE_TOOLS, "new_native_tool", "mcp__other__read"]) {
        expect(() =>
          execFileSync(process.execPath, [guard], {
            input: JSON.stringify({ tool_name }),
            stdio: ["pipe", "ignore", "ignore"],
          }),
        ).toThrow()
      }
      expect(() =>
        execFileSync(process.execPath, [guard], {
          input: JSON.stringify({ tool_name: "mcp__forge__read" }),
          stdio: ["pipe", "ignore", "ignore"],
        }),
      ).not.toThrow()
      expect(() =>
        execFileSync(process.execPath, [guard], { input: "invalid", stdio: ["pipe", "ignore", "ignore"] }),
      ).toThrow()
    }),
  )

  it.live(
    "does not submit a late prompt and revokes MCP before process teardown",
    () =>
      Effect.gen(function* () {
        const cli = yield* fakeCLI(textReply, DevinACP.SUPPORTED_VERSION, true)
        const token = yield* ClaudeCodeMcp.register({
          definitions: [],
          execute: () => Effect.die("No tool should execute"),
        })
        const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(cli.executable))
        const fiber = yield* LLM.stream(
          LLM.request({ model, prompt: "hello", metadata: ClaudeCodeMcp.requestMetadata(token) }),
        ).pipe(Stream.runDrain, Effect.provide(layer), Effect.forkChild)
        for (
          let attempt = 0;
          attempt < 100 && (!existsSync(cli.capture) || !readFileSync(cli.capture, "utf8").includes("session/new"));
          attempt++
        )
          yield* Effect.sleep("20 millis")
        const request = captures(cli.capture).find((item) => item.method === "session/new")!
        expect(request).toBeDefined()
        const server = request.params as { mcpServers: { url: string }[] }
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        for (let attempt = 0; attempt < 100 && !captures(cli.capture).some((item) => item.event === "term"); attempt++)
          yield* Effect.sleep("5 millis")
        expect(captures(cli.capture).some((item) => item.event === "term")).toBe(true)
        expect(
          Exit.isFailure(
            yield* Effect.tryPromise(() => fetch(server.mcpServers[0]!.url, { signal: AbortSignal.timeout(250) })).pipe(
              Effect.exit,
            ),
          ),
        ).toBe(true)
        writeFileSync(cli.release, "release")
        for (
          let attempt = 0;
          attempt < 100 && !captures(cli.capture).some((item) => item.event === "session-ready");
          attempt++
        )
          yield* Effect.sleep("5 millis")
        expect(captures(cli.capture).some((item) => item.event === "session-ready")).toBe(true)
        yield* Fiber.join(interrupted)
        expect(captures(cli.capture).some((item) => item.method === "session/prompt")).toBe(false)
        expect(() => process.kill(Number(captures(cli.capture)[0]!.pid), 0)).toThrow()
      }),
    8_000,
  )

  it.live(
    "cancels and reaps its owned ACP process",
    () =>
      Effect.gen(function* () {
        const cli = yield* fakeCLI(`if (request.method === "session/prompt") await new Promise(() => {})`)
        const fiber = yield* collect(cli.executable).pipe(Effect.forkChild)
        for (
          let attempt = 0;
          attempt < 100 && (!existsSync(cli.capture) || !readFileSync(cli.capture, "utf8").includes("session/prompt"));
          attempt++
        )
          yield* Effect.sleep("20 millis")
        expect(existsSync(cli.capture)).toBe(true)
        const capture = captures(cli.capture)[0]!
        expect(() => process.kill(Number(capture.pid), 0)).not.toThrow()
        yield* Fiber.interrupt(fiber)
        expect(() => process.kill(Number(capture.pid), 0)).toThrow()
      }),
    8_000,
  )
})
