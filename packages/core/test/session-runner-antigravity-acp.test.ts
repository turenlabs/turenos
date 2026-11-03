import { describe, expect } from "bun:test"
import { LLM } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ModelV2 } from "@turenlabs/core/model"
import { AntigravityAcpCLI } from "@turenlabs/core/provider/antigravity-acp"
import { AntigravityAcpBridge } from "@turenlabs/core/session/runner/antigravity-acp-bridge"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { ClaudeCodeMcp } from "@turenlabs/core/session/runner/claude-code-mcp-namespace"
import { it } from "./lib/effect"

const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))

const catalogModel = (executable: string, effort?: AntigravityAcpCLI.EffortLevel) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("gemini-3.8-flash"),
    providerID: AntigravityAcpCLI.ID,
    name: "Gemini 3.8 Flash",
    api: { type: "native", id: ModelV2.ID.make("gemini-3.8-flash"), url: AntigravityAcpCLI.API_URL, settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: {},
      body: {
        [AntigravityAcpCLI.EXECUTABLE_KEY]: executable,
        ...(effort ? { [AntigravityAcpCLI.EFFORT_KEY]: effort } : {}),
      },
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 65_536 },
  })

/** A real subprocess speaking JSON-RPC 2.0 over stdio, never a live Google server. */
const fakeAcpServer = (scriptBody: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(tmpdir(), "forge-antigravity-acp-test-"))
      const executable = path.join(directory, "agy_acp_server.par")
      const capture = path.join(directory, "capture.json")
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          `import { appendFileSync, writeFileSync } from "node:fs"`,
          `import { createInterface } from "node:readline"`,
          `const capturePath = ${JSON.stringify(capture)}`,
          `const received = []`,
          `const save = () => writeFileSync(capturePath, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, received }))`,
          `save()`,
          `const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")`,
          `const rl = createInterface({ input: process.stdin })`,
          scriptBody,
          "",
        ].join("\n"),
      )
      chmodSync(executable, 0o755)
      return { executable, capture }
    }),
    (cli) => Effect.sync(() => rmSync(path.dirname(cli.executable), { recursive: true, force: true })),
  )

const standardServerBody = (options?: {
  readonly useLegacySetModel?: boolean
  readonly emitBrowserNoise?: boolean
  readonly askPermission?: { readonly title: string; readonly kind: string; readonly name?: string }
  readonly stopReason?: string
  readonly waitOnPrompt?: boolean
  readonly requireAuthentication?: boolean
}) => `
let permissionResolved = false
let authenticated = false
rl.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  received.push(msg)
  save()
  if (msg.method === "initialize") {
    if (${Boolean(options?.emitBrowserNoise)}) {
      process.stdout.write("Opening in existing browser session.\\n")
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        authMethods: ${options?.requireAuthentication ? '[{id:"oauth-personal",name:"Google"}]' : "[]"},
        agentCapabilities: { mcpCapabilities: { http: true } },
        agentInfo: { name: "antigravity-acp", version: "0.2.0" }
      }
    })
    return
  }
  if (msg.method === "session/new") {
    if (${Boolean(options?.requireAuthentication)} && !authenticated) {
      send({jsonrpc:"2.0",id:msg.id,error:{code:-32000,message:"Authentication required"}})
      return
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-test-1",
        configOptions: ${
          options?.useLegacySetModel
            ? "[]"
            : JSON.stringify([
                { id: "model", category: "model", type: "select", currentValue: "gemini-3-flash" },
                { id: "thought_level", category: "thought_level", type: "select", currentValue: "medium" },
              ])
        }
      }
    })
    return
  }
  if (msg.method === "authenticate") {
    authenticated = true
    send({jsonrpc:"2.0",id:msg.id,result:{}})
    return
  }
  if (msg.method === "session/set_config_option" || msg.method === "session/set_model") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { configOptions: [] }
    })
    return
  }
  if (msg.method === "session/prompt") {
    if (${Boolean(options?.waitOnPrompt)}) {
      send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"sess-test-1",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"waiting"}}}})
      return
    }
    const permissionSpec = ${JSON.stringify(options?.askPermission ?? null)}
    if (permissionSpec && !permissionResolved) {
      send({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: {
          sessionId: "sess-test-1",
          toolCall: { toolCallId: "tc-1", title: permissionSpec.title, kind: permissionSpec.kind, name: permissionSpec.name },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject_once", kind: "reject_once", name: "Reject once" }
          ]
        }
      })
      return
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-test-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking first" }
        }
      }
    })
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-test-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello " }
        }
      }
    })
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-test-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world" }
        }
      }
    })
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: ${JSON.stringify(options?.stopReason ?? "end_turn")} }
    })
    return
  }
  if (msg.id === 99 && msg.result) {
    permissionResolved = true
    const promptReq = received.find((item) => item.method === "session/prompt")
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-test-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "permission:" + JSON.stringify(msg.result.outcome) }
        }
      }
    })
    send({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" }
    })
  }
})
`

const collect = (
  executable: string,
  options?: {
    readonly effort?: AntigravityAcpCLI.EffortLevel
    readonly messages?: Parameters<typeof LLM.request>[0]["messages"]
    readonly token?: string
  },
) =>
  Effect.gen(function* () {
    const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(executable, options?.effort))
    return Array.from(
      yield* LLM.stream(
        LLM.request({
          model,
          system: "system context",
          metadata: options?.token ? ClaudeCodeMcp.requestMetadata(options.token) : undefined,
          messages: options?.messages ?? [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        }),
      ).pipe(Stream.runCollect),
    )
  }).pipe(Effect.provide(layer))

const failureText = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
}

describe("SessionRunner antigravity-acp transport", () => {
  it.effect("preserves the native Windows account profile for login and model subprocesses", () =>
    Effect.sync(() => {
      const profile = {
        USERPROFILE: "C:\\Users\\Example",
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\Example",
        APPDATA: "C:\\Users\\Example\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
        USERNAME: "Example",
      }
      expect(
        AntigravityAcpBridge.environment("/isolated", { ...profile, GOOGLE_API_KEY: "secret" }, "win32"),
      ).toMatchObject(profile)
      expect(AntigravityAcpBridge.environment("/isolated", { GOOGLE_API_KEY: "secret" }, "win32")).not.toHaveProperty(
        "GOOGLE_API_KEY",
      )
    }),
  )

  it.effect("resolves the supported Gemini catalog models onto the local ACP route", () =>
    Effect.gen(function* () {
      const info = catalogModel("agy_acp_server.par")
      expect(AntigravityAcpCLI.MODELS.map((model) => model.id)).toEqual([
        "gemini-3.8-flash",
        "gemini-4-argon",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.1-pro",
        "gemini-3-flash",
      ])
      expect(AntigravityAcpBridge.isAntigravityAcp(info)).toBe(true)
      expect(SessionRunnerModel.supported(info)).toBe(true)
      expect(SessionRunnerModel.selectable(info)).toBe(true)
      const model = yield* SessionRunnerModel.fromCatalogModel(info)
      expect(model.route.id).toBe("antigravity-acp-cli")
      expect(String(model.provider)).toBe("antigravity-acp")
    }),
  )

  it.effect("completes ACP handshake, configures model and thought_level, and streams thought and text deltas", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(standardServerBody({ emitBrowserNoise: true }))
      const events = yield* collect(cli.executable, { effort: "high" })
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(
        events
          .filter((event) => event.type === "reasoning-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("thinking first")
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("hello world")

      const captured = JSON.parse(readFileSync(cli.capture, "utf8"))
      expect(captured.received.map((item: { method?: string }) => item.method)).toEqual([
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/set_config_option",
        "session/prompt",
      ])
      expect(captured.received[0].params.clientCapabilities).toEqual({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      })
      expect(captured.received[2].params).toEqual({
        sessionId: "sess-test-1",
        configId: "model",
        value: "gemini-3.8-flash",
      })
      expect(captured.received[3].params).toEqual({
        sessionId: "sess-test-1",
        configId: "thought_level",
        value: "high",
      })
    }),
  )

  it.effect("falls back to session/set_model when configOptions omits the model selector", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(standardServerBody({ useLegacySetModel: true }))
      const events = yield* collect(cli.executable, { effort: "low" })
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      const captured = JSON.parse(readFileSync(cli.capture, "utf8"))
      expect(captured.received.map((item: { method?: string }) => item.method)).toEqual([
        "initialize",
        "session/new",
        "session/set_model",
        "session/prompt",
      ])
      expect(captured.received[2].params).toEqual({
        sessionId: "sess-test-1",
        modelId: "gemini-3.8-flash-low",
      })
    }),
  )

  it.effect("reuses native sign-in through authenticate when a fresh model process requires method selection", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(standardServerBody({ requireAuthentication: true }))
      const events = yield* collect(cli.executable)
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      const captured = JSON.parse(readFileSync(cli.capture, "utf8"))
      expect(captured.received.map((item: { method?: string }) => item.method)).toEqual([
        "initialize",
        "session/new",
        "authenticate",
        "session/new",
        "session/set_config_option",
        "session/prompt",
      ])
      expect(captured.received[2].params).toEqual({ methodId: "oauth-personal" })
    }),
  )

  it.effect("does not loop on rejected native authentication or invoke terminal authentication methods", () =>
    Effect.sync(() => {
      for (const type of [undefined, "terminal"]) {
        const state = AntigravityAcpBridge.adapterState({
          modelID: "gemini-3.8-flash",
          cwd: "/unused",
          promptText: "hello",
        })
        AntigravityAcpBridge.startHandshake(state)
        AntigravityAcpBridge.stepLine(
          state,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal", type }] },
          }),
        )
        const rejected = { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Authentication required" } }
        const first = AntigravityAcpBridge.stepLine(state, JSON.stringify(rejected))
        if (type === "terminal") {
          expect(first.ok).toBe(false)
          continue
        }
        expect(first.ok).toBe(true)
        AntigravityAcpBridge.stepLine(state, JSON.stringify({ jsonrpc: "2.0", id: 3, result: {} }))
        expect(AntigravityAcpBridge.stepLine(state, JSON.stringify({ ...rejected, id: 4 })).ok).toBe(false)
      }
    }),
  )

  it.effect("approves Forge MCP permission requests and rejects native non-Forge tool permission requests", () =>
    Effect.gen(function* () {
      const token = yield* ClaudeCodeMcp.register({
        definitions: [],
        execute: () => Effect.die("No HTTP tool execution expected in the ACP permission test"),
      })
      const forgeCli = yield* fakeAcpServer(
        standardServerBody({ askPermission: { title: "Read a file", name: "mcp__forge__read", kind: "read" } }),
      )
      const forgeEvents = yield* collect(forgeCli.executable, { token })
      expect(
        forgeEvents
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toContain('"optionId":"allow_once"')

      const nativeCli = yield* fakeAcpServer(
        standardServerBody({ askPermission: { title: "write_file /etc/passwd", kind: "edit" } }),
      )
      const nativeEvents = yield* collect(nativeCli.executable)
      expect(
        nativeEvents
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toContain('"optionId":"reject_once"')
    }),
  )

  it.effect("does not authorize native tools through Forge titles, IDs, or ambiguous permission options", () =>
    Effect.sync(() => {
      const state = AntigravityAcpBridge.adapterState({
        modelID: "gemini-3.8-flash",
        cwd: "/unused",
        promptText: "hello",
        mcp: { url: "http://127.0.0.1/unused", authorization: "Bearer test" },
      })
      state.phase = "prompt"
      state.sessionId = "active-session"
      const options = [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ]
      const params = {
        sessionId: "active-session",
        options,
        toolCall: { toolCallId: "call-1", name: "mcp__forge__read", title: "Read" },
      }
      expect(AntigravityAcpBridge.permissionOutcome(state, params)).toEqual({ outcome: "selected", optionId: "allow" })
      const metadata = { is_mcp_tool_call: true, mcp: { server: "forge", tool: "read" } }
      expect(
        AntigravityAcpBridge.permissionOutcome(state, {
          ...params,
          toolCall: { toolCallId: "call-1", title: "forge_read", _meta: metadata },
        }),
      ).toEqual({ outcome: "selected", optionId: "allow" })
      for (const toolCall of [
        { _meta: { ...metadata, is_mcp_tool_call: false } },
        { _meta: { ...metadata, mcp: { server: "other", tool: "read" } } },
        { _meta: { ...metadata, mcp: { server: "forge", tool: "read /etc/passwd" } } },
        { _meta: metadata, name: "write_file" },
        { name: "mcp__forge__read", _meta: { ...metadata, mcp: { server: "other", tool: "read" } } },
        { toolCallId: "mcp__forge__read", title: "mcp__forge__read" },
        { toolCallId: "forge", name: "write_file", title: "write_file /tmp/forge/config.json" },
        { toolCallId: "call-1", name: "run_shell_command", title: "Run shell command: forge --version" },
        { toolCallId: "call-1", name: "mcp__forge-evil__read", title: "Read" },
        { toolCallId: "call-1", name: "mcp__forge__read /etc/passwd", title: "Read" },
        { toolCallId: "call-1", name: "mcp__forge__read\n", title: "Read" },
      ]) {
        expect(AntigravityAcpBridge.permissionOutcome(state, { ...params, toolCall })).toEqual({
          outcome: "selected",
          optionId: "reject",
        })
      }
      expect(AntigravityAcpBridge.permissionOutcome(state, { ...params, sessionId: "other-session" })).toEqual({
        outcome: "selected",
        optionId: "reject",
      })
      for (const options of [
        [],
        [{ optionId: "remember", kind: "allow_always" }],
        [{ optionId: "allow_once", kind: "reject_once" }],
      ]) {
        expect(AntigravityAcpBridge.permissionOutcome(state, { ...params, options })).toEqual({ outcome: "cancelled" })
      }
      expect(AntigravityAcpBridge.permissionOutcome({ ...state, mcp: [] }, params)).toEqual({
        outcome: "selected",
        optionId: "reject",
      })
      expect(AntigravityAcpBridge.permissionOutcome({ ...state, phase: "done" }, params)).toEqual({
        outcome: "selected",
        optionId: "reject",
      })
    }),
  )

  it.effect("rejects text outside the active session while tolerating setup configuration notifications", () =>
    Effect.sync(() => {
      const state = AntigravityAcpBridge.adapterState({
        modelID: "gemini-3.8-flash",
        cwd: "/unused",
        promptText: "hello",
      })
      const text = (sessionId?: string) =>
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unexpected" } },
          },
        })
      expect(AntigravityAcpBridge.stepLine(state, text()).ok).toBe(false)
      state.phase = "configure"
      state.sessionId = "active-session"
      expect(
        AntigravityAcpBridge.stepLine(
          state,
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "active-session",
              update: { sessionUpdate: "config_option_update", configOptions: [] },
            },
          }),
        ).ok,
      ).toBe(true)
      expect(AntigravityAcpBridge.stepLine(state, text("active-session")).ok).toBe(false)
      state.phase = "prompt"
      expect(AntigravityAcpBridge.stepLine(state, text()).ok).toBe(false)
      expect(AntigravityAcpBridge.stepLine(state, text("other-session")).ok).toBe(false)
      expect(AntigravityAcpBridge.stepLine(state, text("active-session")).ok).toBe(true)
    }),
  )

  it.effect("rejects native requests containing Forge paths over the real stdio transport", () =>
    Effect.gen(function* () {
      const token = yield* ClaudeCodeMcp.register({
        definitions: [],
        execute: () => Effect.die("Native permission must not invoke the host executor"),
      })
      const cli = yield* fakeAcpServer(
        standardServerBody({
          askPermission: { name: "write_file", title: "write_file /tmp/forge/config.json", kind: "edit" },
        }),
      )
      const events = yield* collect(cli.executable, { token })
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toContain('"optionId":"reject_once"')
    }),
  )

  it.effect("ignores Google account links in successful runtime diagnostics", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(`
process.stderr.write('loadCodeAssist response: {"upgradeSubscriptionUri":"https://accounts.google.com/upgrade"}\\n')
${standardServerBody()}
`)
      const events = yield* collect(cli.executable)
      expect(events.some((event) => event.type === "provider-error")).toBe(false)
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("hello world")
    }),
  )

  it.effect("surfaces split OAuth browser instructions promptly and cleans up without exposing the URL", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(`
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") return send({jsonrpc:"2.0",id:msg.id,result:{protocolVersion:1}})
  if (msg.method === "session/new") {
    process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.goo")
    process.stderr.write("gle.com/o/oauth2/v2/auth?state=private-oauth-state&code_challenge=private-challenge\\n")
  }
})
`)
      const events = yield* collect(cli.executable)
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({
        message: expect.stringContaining("Sign in with Google"),
        retryable: false,
      })
      expect(JSON.stringify(events)).not.toContain("private-oauth-state")
      expect(JSON.stringify(events)).not.toContain("accounts.google.com")
      const captured = JSON.parse(readFileSync(cli.capture, "utf8"))
      expect(() => process.kill(captured.pid, 0)).toThrow()
      expect(existsSync(path.dirname(captured.cwd))).toBe(false)
    }),
  )

  it.effect("bounds a silent handshake without imposing a model-generation deadline", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(`setInterval(() => {}, 1000)`)
      const started = yield* Deferred.make<void>()
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(cli.executable))
      const fiber = yield* LLM.stream(LLM.request({ model, prompt: "hello" })).pipe(
        Stream.tap((event) => (event.type === "step-start" ? Deferred.succeed(started, undefined) : Effect.void)),
        Stream.runCollect,
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      yield* TestClock.adjust("60 seconds")
      const events = Array.from(yield* Fiber.join(fiber))
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({ message: expect.stringContaining("setup timed out"), retryable: false })

      const ready = yield* Deferred.make<void>()
      const promptCli = yield* fakeAcpServer(standardServerBody({ waitOnPrompt: true }))
      const promptModel = yield* SessionRunnerModel.fromCatalogModel(catalogModel(promptCli.executable))
      const promptFiber = yield* LLM.stream(LLM.request({ model: promptModel, prompt: "hello" })).pipe(
        Stream.tap((event) => (event.type === "text-delta" ? Deferred.succeed(ready, undefined) : Effect.void)),
        Stream.runCollect,
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* Deferred.await(ready)
      yield* TestClock.adjust("2 minutes")
      expect(promptFiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(promptFiber)
      const captured = JSON.parse(readFileSync(promptCli.capture, "utf8"))
      expect(() => process.kill(captured.pid, 0)).toThrow()
      expect(existsSync(path.dirname(captured.cwd))).toBe(false)
    }),
  )

  it.effect("maps ACP -32000 authentication failure to Turen sign-in guidance", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(`
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } })
    return
  }
  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32000, message: "Authentication required", data: { details: "missing oauth-personal token" } }
    })
  }
})
`)
      const events = yield* collect(cli.executable)
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({
        type: "provider-error",
        message: expect.stringContaining("Settings > Local Providers > Antigravity ACP"),
        retryable: false,
      })
    }),
  )

  for (const [name, script] of [
    ["malformed JSON", `rl.on("line", () => { process.stdout.write("{broken\\n") })`],
    [
      "unsupported protocolVersion",
      `rl.on("line", (line) => { const msg = JSON.parse(line); send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 99 } }) })`,
    ],
    [
      "missing sessionId",
      `rl.on("line", (line) => { const msg = JSON.parse(line); if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }); else send({ jsonrpc: "2.0", id: msg.id, result: {} }) })`,
    ],
  ]) {
    it.effect(`fails closed on ${name}`, () =>
      Effect.gen(function* () {
        const cli = yield* fakeAcpServer(script!)
        const events = yield* collect(cli.executable)
        expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
        expect(events.at(-1)).toMatchObject({
          type: "provider-error",
          message: expect.stringContaining("malformed JSONL"),
        })
      }),
    )
  }

  it.effect("spawns in an isolated scratch workspace and strips ambient API keys", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(standardServerBody())
      yield* collect(cli.executable)
      const captured = JSON.parse(readFileSync(cli.capture, "utf8"))
      if (process.platform === "linux") {
        expect(captured.argv).toEqual(["--uid="])
      }
      expect(captured.cwd).toBe(
        path.join(realpathSync(tmpdir()), path.basename(path.dirname(captured.env.XDG_CONFIG_HOME)), "workspace"),
      )
      expect(existsSync(path.dirname(captured.env.XDG_CONFIG_HOME))).toBe(false)

      const macHome = mkdtempSync(path.join(tmpdir(), "turen-agy-mac-home-"))
      try {
        mkdirSync(path.join(macHome, ".gemini", "antigravity-acp"), { recursive: true })
        writeFileSync(path.join(macHome, ".gemini", "antigravity-acp", "acp_token.json"), "{}")
        const env = AntigravityAcpBridge.environment(
          "/isolated",
          {
            HOME: macHome,
            PATH: "/usr/bin",
            GEMINI_API_KEY: "secret",
            GOOGLE_API_KEY: "secret",
            OPENAI_API_KEY: "secret",
            ANTHROPIC_API_KEY: "secret",
            NODE_OPTIONS: "--require=/unsafe",
            LD_PRELOAD: "/unsafe",
            BASH_ENV: "/unsafe",
          },
          "darwin",
        )
        expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1")
        expect(env.XDG_CONFIG_HOME).toBe("/isolated/config")
        expect(env.XDG_DATA_HOME).toBe("/isolated/data")
        for (const forbidden of [
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "NODE_OPTIONS",
          "LD_PRELOAD",
          "BASH_ENV",
        ]) {
          expect(env).not.toHaveProperty(forbidden)
        }
      } finally {
        rmSync(macHome, { recursive: true, force: true })
      }
    }),
  )

  it.effect("rejects media and oversized prompts before the ACP server starts", () =>
    Effect.gen(function* () {
      const cli = yield* fakeAcpServer(standardServerBody())
      const mediaExit = yield* collect(cli.executable, {
        messages: [
          {
            role: "user",
            content: [{ type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "image.png" }],
          },
        ],
      }).pipe(Effect.exit)
      expect(failureText(mediaExit)).toContain("supports text only")
      expect(existsSync(cli.capture)).toBe(false)

      const oversizedExit = yield* collect(cli.executable, {
        messages: [{ role: "user", content: [{ type: "text", text: "é".repeat(2 * 1024 * 1024) }] }],
      }).pipe(Effect.exit)
      expect(failureText(oversizedExit)).toContain("4 MiB limit")
      expect(existsSync(cli.capture)).toBe(false)
    }),
  )

  it.live(
    "sends session/cancel and tears down the subprocess on cancellation",
    () =>
      Effect.gen(function* () {
        const cli = yield* fakeAcpServer(`
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  received.push(msg)
  save()
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } })
    return
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-cancel-1", configOptions: [] } })
    return
  }
  if (msg.method === "session/set_model") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
    return
  }
  if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-cancel-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started" } }
      }
    })
    setTimeout(() => process.exit(0), 10_000)
  }
})
`)
        const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(cli.executable))
        const fiber = yield* LLM.stream(LLM.request({ model, prompt: "hello" })).pipe(
          Stream.take(3),
          Stream.runDrain,
          Effect.provide(layer),
          Effect.forkChild,
        )
        yield* Fiber.join(fiber)
        const captured = JSON.parse(readFileSync(cli.capture, "utf8")) as { pid: number }
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
        expect(() => process.kill(captured.pid, 0)).toThrow()
      }),
    15_000,
  )
})
