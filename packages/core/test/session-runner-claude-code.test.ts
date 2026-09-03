import { describe, expect } from "bun:test"
import { LLM, LLMError, type LLMEvent } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { EventV2 } from "@turenlabs/core/event"
import { createLLMEventPublisher } from "@turenlabs/core/session/runner/publish-llm-event"
import { SessionV2 } from "@turenlabs/core/session"
import { ProjectV2 } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { ModelV2 } from "@turenlabs/core/model"
import { ClaudeCodeGuidance } from "@turenlabs/core/claude-code-guidance"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { ClaudeCodeBridge } from "@turenlabs/core/session/runner/claude-code-bridge"
import { ClaudeCodeMcp } from "@turenlabs/core/session/runner/claude-code-mcp-namespace"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { it } from "./lib/effect"

const catalogModel = (executable: string) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("opus"),
    providerID: ProviderV2.ID.make("claude-code"),
    name: "Claude Opus",
    api: { type: "native", id: ModelV2.ID.make("opus"), url: ClaudeCodeCLI.API_URL, settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: {},
      body: { [ClaudeCodeCLI.EXECUTABLE_KEY]: executable, [ClaudeCodeCLI.DIRECTORY_KEY]: tmpdir() },
    },
    // The same effort variants the v2 catalog plugin publishes for this model.
    variants: ClaudeCodeCLI.EFFORT_LEVELS.map((effort) => ({
      id: ModelV2.VariantID.make(effort),
      headers: {},
      body: { [ClaudeCodeCLI.EFFORT_KEY]: effort },
    })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 64_000 },
  })

const sessionWithVariant = (variant?: string) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make("ses_claude_code_effort"),
    projectID: ProjectV2.ID.global,
    title: "test",
    model: {
      id: ModelV2.ID.make("opus"),
      providerID: ProviderV2.ID.make("claude-code"),
      ...(variant === undefined ? {} : { variant: ModelV2.VariantID.make(variant) }),
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make("/project") },
  })

const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))

/** Writes an executable stand-in for the `claude` CLI so no real turn is billed. */
const fakeCLI = (body: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "forge-claude-code-"))
  const file = path.join(dir, "claude")
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const envelope = (value: unknown) => JSON.stringify(JSON.stringify(value))

/**
 * Fake CLI that records the argv it was spawned with, one argument per line, so
 * a test can assert on the flags the transport actually built rather than on the
 * function that builds them.
 */
const recordingCLI = () => {
  const executable = fakeCLI("")
  const argv = path.join(path.dirname(executable), "argv.txt")
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argv)}; done`,
      `echo ${envelope({ type: "result", subtype: "success", uuid: "u1", is_error: false, result: "ok", usage: {} })}`,
    ].join("\n") + "\n",
  )
  chmodSync(executable, 0o755)
  return { executable, argv: () => readFileSync(argv, "utf8").split("\n").filter(Boolean) }
}

/** Resolves through the real variant-application path and drains one turn. */
const spawnArgv = (variant?: string) =>
  Effect.gen(function* () {
    const cli = recordingCLI()
    const model = yield* SessionRunnerModel.resolveWithRef(sessionWithVariant(variant), catalogModel(cli.executable))
    yield* LLM.stream(
      LLM.request({
        model: model.model,
        system: "system context",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).pipe(Stream.runCollect)
    return { argv: cli.argv(), ref: model.ref }
  }).pipe(Effect.provide(layer))

const collect = (executable: string) =>
  Effect.gen(function* () {
    const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(executable))
    const request = LLM.request({
      model,
      system: "system context",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })
    return yield* LLM.stream(request).pipe(Stream.runCollect)
  }).pipe(Effect.provide(layer))

/**
 * The exact envelope sequence a real `claude -p --include-partial-messages` turn
 * emits for one tool call, captured from the CLI. The ordering is the load-bearing
 * part: the completed `assistant` envelope lands *between* the last
 * `input_json_delta` and the block's `content_block_stop`.
 */
const toolCallEnvelopes = (input: {
  readonly id: string
  readonly name: string
  readonly toolInput?: Record<string, unknown>
  readonly toolResult?: string
}) => [
  { type: "stream_event", uuid: "s1", event: { type: "message_start" } },
  {
    type: "stream_event",
    uuid: "s2",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: input.id, name: input.name, input: {} },
    },
  },
  {
    type: "stream_event",
    uuid: "s3",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_' } },
  },
  {
    type: "stream_event",
    uuid: "s4",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'path":"a.ts"}' },
    },
  },
  {
    type: "assistant",
    uuid: "s5",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_use", id: input.id, name: input.name, input: input.toolInput ?? { file_path: "a.ts" } }],
    },
  },
  { type: "stream_event", uuid: "s6", parent_tool_use_id: null, event: { type: "content_block_stop", index: 1 } },
  {
    type: "user",
    uuid: "s7",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: input.id, content: input.toolResult ?? "file body" }] },
  },
  { type: "stream_event", uuid: "s8", event: { type: "message_stop" } },
]

const successResult = {
  type: "result",
  subtype: "success",
  uuid: "done",
  is_error: false,
  result: "read it",
  total_cost_usd: 0.5,
  usage: { input_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens: 5 },
}

const replay = (messages: ReadonlyArray<unknown>) => messages.map((item) => `echo ${envelope(item)}`).join("\n")

/** Drives events through the real runner publisher; defects surface as failures. */
const publishAll = (events: ReadonlyArray<LLMEvent>) =>
  Effect.gen(function* () {
    const published: Array<{ readonly type: string; readonly data: unknown }> = []
    const service = EventV2.Service.of({
      publish: (definition, data) =>
        Effect.sync(() => {
          published.push({ type: definition.type, data })
          return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        }),
      subscribe: () => Stream.empty,
      all: () => Stream.empty,
      durable: () => Stream.empty,
      durableSnapshot: () => Effect.succeed([]),
      listen: () => Effect.succeed(Effect.void),
      project: () => Effect.void,
      replay: () => Effect.void,
      replayAll: () => Effect.succeed(undefined),
      remove: () => Effect.void,
      claim: () => Effect.void,
    })
    const publisher = createLLMEventPublisher(service, {
      sessionID: SessionV2.ID.make("ses_claude_code_tool"),
      agent: "build",
      model: { id: ModelV2.ID.make("opus"), providerID: ProviderV2.ID.make("claude-code") },
    })
    for (const event of events) yield* publisher.publish(event)
    yield* publisher.flush()
    return published.map((item) => item.type)
  })

/** Descendants of this test process that are still running the fake CLI. */
const survivors = (marker: string) =>
  execFileSync("/bin/ps", ["-Ao", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(marker) && !line.includes("/bin/ps"))

describe("SessionRunner claude-code transport", () => {
  it.effect("resolves claude-code models onto the CLI route instead of an HTTP adapter", () =>
    Effect.gen(function* () {
      const info = catalogModel("claude")
      expect(ClaudeCodeBridge.isClaudeCode(info)).toBe(true)
      expect(SessionRunnerModel.supported(info)).toBe(true)
      expect(SessionRunnerModel.selectable(info)).toBe(true)
      const model = yield* SessionRunnerModel.fromCatalogModel(info)
      expect(model.route.id).toBe("claude-code-cli")
      expect(String(model.provider)).toBe("claude-code")
    }),
  )

  // `claude --effort <level>` is the CLI's own control and TurenOS's variant ids are
  // its exact vocabulary, so a selected variant has to arrive as that flag. These
  // assert on the argv of a real spawn rather than on the builder function.
  it.effect("passes --effort to the CLI for the selected variant", () =>
    Effect.gen(function* () {
      const { argv, ref } = yield* spawnArgv("high")
      expect(argv).toContain("--effort")
      expect(argv[argv.indexOf("--effort") + 1]).toBe("high")
      // The durable reference must report the variant that was actually applied.
      expect(ref.variant).toBe(ModelV2.VariantID.make("high"))
    }),
  )

  it.effect("omits --effort entirely when no variant is selected", () =>
    Effect.gen(function* () {
      const { argv, ref } = yield* spawnArgv()
      expect(argv).not.toContain("--effort")
      expect(argv).toContain("--model")
      expect(argv).toContain("--append-system-prompt-file")
      expect(argv).not.toContain("system context")
      expect(ref.variant).toBeUndefined()
    }),
  )

  // A variant id is sticky session state, so a stored one the model no longer
  // publishes must degrade to the CLI's own default instead of being forwarded
  // as a flag the CLI would warn about and ignore.
  it.effect("omits --effort for a stale variant the model does not publish", () =>
    Effect.gen(function* () {
      const { argv, ref } = yield* spawnArgv("ludicrous")
      expect(argv).not.toContain("--effort")
      expect(ref.variant).toBeUndefined()
    }),
  )

  it.effect("builds one --effort flag per published level and none otherwise", () =>
    Effect.sync(() => {
      expect(ClaudeCodeCLI.EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"])
      for (const effort of ClaudeCodeCLI.EFFORT_LEVELS) {
        const built = ClaudeCodeBridge.args({ modelID: "opus", systemFile: "/tmp/system", effort })
        expect(built.slice(built.indexOf("--effort"), built.indexOf("--effort") + 2)).toEqual(["--effort", effort])
      }
      expect(ClaudeCodeBridge.args({ modelID: "opus", systemFile: "/tmp/system" })).not.toContain("--effort")
    }),
  )

  it.effect("places TurenOS exploration guidance ahead of turn-specific system context", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel("claude"))
      const request = LLM.request({
        model,
        metadata: ClaudeCodeMcp.requestMetadata("workflow-test"),
        system: "turn-specific system context",
        prompt: "hello",
      })
      const system = ClaudeCodeBridge.systemPrompt(request)
      expect(system).toContain(ClaudeCodeGuidance.WORKFLOW)
      expect(system.indexOf(ClaudeCodeGuidance.WORKFLOW)).toBeLessThan(system.indexOf("turn-specific system context"))
      expect(system.match(/TurenOS tool workflow:/g)).toHaveLength(1)
    }),
  )

  it.effect("teaches broad parallel exploration and conditional early delegation", () =>
    Effect.sync(() => {
      expect(ClaudeCodeGuidance.WORKFLOW).toContain("one broad search")
      expect(ClaudeCodeGuidance.WORKFLOW).toContain("serial chain of Shell")
      expect(ClaudeCodeGuidance.WORKFLOW).toContain("same response so they can run in parallel")
      expect(ClaudeCodeGuidance.WORKFLOW).toContain("spawn disjoint, bounded work early")
      expect(ClaudeCodeGuidance.WORKFLOW).toContain("Do not delegate trivial lookups")
      expect(ClaudeCodeGuidance.WORKFLOW).toContain("dynamic subagent guidance as authoritative")
    }),
  )

  it.effect("omits repository workflow guidance when the turn has no TurenOS tools", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel("claude"))
      const request = LLM.request({ model, system: "tool-less system context", prompt: "hello" })
      expect(ClaudeCodeBridge.systemPrompt(request)).not.toContain(ClaudeCodeGuidance.WORKFLOW)
    }),
  )

  it.effect("preserves the previous V2 system-context budget on tool-enabled turns", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel("claude"))
      const sentinel = "AUTHORITATIVE_CONTEXT_TAIL"
      const context = `${"a".repeat(96 * 1024 - 200)}${sentinel}`
      const withoutTools = ClaudeCodeBridge.systemPrompt(LLM.request({ model, system: context, prompt: "hello" }))
      const withTools = ClaudeCodeBridge.systemPrompt(
        LLM.request({
          model,
          metadata: ClaudeCodeMcp.requestMetadata("workflow-budget-test"),
          system: context,
          prompt: "hello",
        }),
      )
      expect(withoutTools).toContain(sentinel)
      expect(withTools).toContain(sentinel)
      expect(new TextEncoder().encode(withoutTools).byteLength).toBeLessThanOrEqual(96 * 1024)
      expect(new TextEncoder().encode(withTools).byteLength).toBeLessThanOrEqual(
        96 * 1024 + new TextEncoder().encode(`${ClaudeCodeGuidance.WORKFLOW}\n\n`).byteLength,
      )
    }),
  )

  it.effect("routes mutations through the private TurenOS MCP server", () =>
    Effect.sync(() => {
      const built = ClaudeCodeBridge.args({
        modelID: "opus",
        systemFile: "/tmp/system",
        mcpFile: "/tmp/mcp.json",
        settingsFile: "/tmp/settings.json",
      })
      expect(built).toContain("--mcp-config")
      expect(built).toContain("/tmp/mcp.json")
      expect(built.slice(built.indexOf("--settings"), built.indexOf("--settings") + 2)).toEqual([
        "--settings",
        "/tmp/settings.json",
      ])
      expect(built).toContain("--permission-mode")
      expect(built).toContain("dontAsk")
      expect(built).toContain("mcp__forge__*")
      expect(built.slice(built.indexOf("--tools"), built.indexOf("--tools") + 2)).toEqual(["--tools", ""])
      expect(built.slice(built.indexOf("--setting-sources"), built.indexOf("--setting-sources") + 2)).toEqual([
        "--setting-sources",
        "",
      ])
    }),
  )

  it.effect("isolates subscription auth and keeps private MCP traffic off ambient proxies", () =>
    Effect.sync(() => {
      const env = ClaudeCodeCLI.subscriptionEnvironment({
        PATH: "/bin",
        ANTHROPIC_API_KEY: "api-key",
        ANTHROPIC_AUTH_TOKEN: "auth-token",
        ANTHROPIC_BASE_URL: "https://gateway.example",
        ANTHROPIC_VERTEX_PROJECT_ID: "project",
        CLAUDE_CODE_API_BASE_URL: "https://other.example",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        HTTPS_PROXY: "http://proxy.example",
        NO_PROXY: "internal.example,localhost",
        no_proxy: "legacy.example",
      })

      expect(env).toMatchObject({
        PATH: "/bin",
        HTTPS_PROXY: "http://proxy.example",
        CLAUDE_AGENT_SDK_CLIENT_APP: "forge",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "forge",
        MCP_TOOL_TIMEOUT: "610000",
      })
      expect(Object.keys(env).filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([])
      expect(Object.keys(env).filter((name) => name.startsWith("CLAUDE_CODE_USE_"))).toEqual([])
      expect(env.CLAUDE_CODE_API_BASE_URL).toBeUndefined()
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(env.NO_PROXY?.split(",")).toEqual(["internal.example", "localhost", "legacy.example", "127.0.0.1", "::1"])
      expect(env.no_proxy).toBe(env.NO_PROXY)
    }),
  )

  it.effect("disables every Claude tool when the runner disables tools", () =>
    Effect.sync(() => {
      const built = ClaudeCodeBridge.args({ modelID: "opus", systemFile: "/tmp/system" })
      expect(built.slice(built.indexOf("--tools"), built.indexOf("--tools") + 2)).toEqual(["--tools", ""])
    }),
  )

  it.effect("does not claim models from other providers", () =>
    Effect.sync(() => {
      const foreign = ModelV2.Info.make({
        ...catalogModel("claude"),
        providerID: ProviderV2.ID.make("anthropic"),
      })
      expect(ClaudeCodeBridge.isClaudeCode(foreign)).toBe(false)
    }),
  )

  it.effect("classifies a CLI-relayed context overflow so recovery can fire", () =>
    Effect.gen(function* () {
      // Bridge errors bypass every protocol mapper, so this is the only place overflow
      // classification can happen for Claude local. Unclassified, the runner settled the turn
      // terminally instead of attempting compaction recovery — the gpt-5.6-luna failure mode,
      // but on the one provider path where it could never self-heal.
      const overflowTexts = [
        "API Error: 400 prompt is too long: 215000 tokens > 200000 maximum",
        "API Error: Your input exceeds the context window of this model. Please adjust your input and try again.",
      ]
      for (const text of overflowTexts) {
        const executable = fakeCLI(
          `echo ${envelope({ type: "result", subtype: "error_during_execution", uuid: "u1", is_error: true, result: text, usage: {} })}`,
        )
        const events = Array.from(yield* collect(executable))
        const failure = events.find((event) => event.type === "provider-error")
        expect(failure).toMatchObject({ classification: "context-overflow", retryable: false })
      }

      // Non-overflow errors stay unclassified: recovery must not fire on auth failures.
      const executable = fakeCLI(
        `echo ${envelope({ type: "result", subtype: "error_during_execution", uuid: "u2", is_error: true, result: "API Error: 401 authentication failed", usage: {} })}`,
      )
      const events = Array.from(yield* collect(executable))
      const failure = events.find((event) => event.type === "provider-error")!
      expect(failure.type === "provider-error" && failure.classification).toBeUndefined()
    }),
  )

  it.effect("maps stream-json envelopes onto text, provider-executed tools and usage", () =>
    Effect.gen(function* () {
      const script = [
        `echo ${envelope({ type: "system", subtype: "init", session_id: "s" })}`,
        `echo ${envelope({
          type: "stream_event",
          uuid: "u1",
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        })}`,
        `echo ${envelope({
          type: "stream_event",
          uuid: "u1",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        })}`,
        `echo ${envelope({ type: "stream_event", uuid: "u1", event: { type: "content_block_stop", index: 0 } })}`,
        `echo ${envelope({
          type: "assistant",
          uuid: "u2",
          message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] },
        })}`,
        `echo ${envelope({
          type: "user",
          uuid: "u3",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
        })}`,
        `echo ${envelope({
          type: "result",
          subtype: "success",
          uuid: "u4",
          is_error: false,
          result: "hi",
          total_cost_usd: 0.5,
          usage: { input_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens: 5 },
        })}`,
      ].join("\n")
      const events = Array.from(yield* collect(fakeCLI(script)))
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "tool-call",
        "tool-result",
        "step-finish",
        "finish",
      ])
      const call = events.find((event) => event.type === "tool-call")!
      expect(call).toMatchObject({
        name: "read",
        providerExecuted: true,
        input: { file_path: "a.ts", filePath: "a.ts" },
      })
      const result = events.find((event) => event.type === "tool-result")!
      expect(result).toMatchObject({ name: "read", providerExecuted: true })
      const finish = events.find((event) => event.type === "finish")!
      expect(finish).toMatchObject({
        reason: "stop",
        usage: { inputTokens: 9, outputTokens: 5, cacheReadInputTokens: 3, cacheWriteInputTokens: 4, totalTokens: 14 },
      })
    }),
  )

  it.effect("decodes stream-json across a split UTF-8 stdout chunk", () =>
    Effect.gen(function* () {
      const executable = fakeCLI("")
      const output = [
        {
          type: "stream_event",
          uuid: "split-utf8",
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        },
        {
          type: "stream_event",
          uuid: "split-utf8",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "界" } },
        },
        { type: "stream_event", uuid: "split-utf8", event: { type: "content_block_stop", index: 0 } },
        { type: "result", subtype: "success", uuid: "split-result", is_error: false, result: "界", usage: {} },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n")
      const bytes = Buffer.from(`${output}\n`)
      const split = bytes.indexOf(Buffer.from("界")) + 1
      writeFileSync(
        executable,
        [
          "#!/usr/bin/env bun",
          `const bytes = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64")`,
          `process.stdout.write(bytes.subarray(0, ${split}))`,
          "await Bun.sleep(100)",
          `process.stdout.write(bytes.subarray(${split}))`,
        ].join("\n") + "\n",
      )
      chmodSync(executable, 0o755)

      const events = Array.from(yield* collect(executable))
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "界" })
      expect(JSON.stringify(events)).not.toContain("�")
    }),
  )

  it.effect("normalizes Claude built-in tools for TurenOS timeline presentation", () =>
    Effect.gen(function* () {
      const script = replay([
        ...toolCallEnvelopes({
          id: "toolu_edit",
          name: "Edit",
          toolInput: {
            file_path: "src/a.ts",
            old_string: "before",
            new_string: "after",
            replace_all: true,
          },
        }),
        successResult,
      ])
      const events = Array.from(yield* collect(fakeCLI(script)))
      const call = events.find((event) => event.type === "tool-call")!
      expect(call).toMatchObject({
        name: "edit",
        input: {
          filePath: "src/a.ts",
          oldString: "before",
          newString: "after",
          replaceAll: true,
        },
      })
      expect(events.find((event) => event.type === "tool-result")).toMatchObject({ name: "edit" })
    }),
  )

  it.effect("suppresses private MCP envelopes that the TurenOS registry already settled", () =>
    Effect.gen(function* () {
      const script = replay([
        ...toolCallEnvelopes({
          id: "toolu_mcp_edit",
          name: "mcp__forge__edit",
          toolInput: { path: "src/a.ts", oldString: "before", newString: "after" },
          toolResult: "Edited file successfully; Quality ratchet: simplify this change.",
        }),
        successResult,
      ])
      const events = Array.from(yield* collect(fakeCLI(script)))
      expect(events.some((event) => event.type === "tool-call" || event.type === "tool-result")).toBe(false)
      expect(events.at(-1)?.type).toBe("finish")
    }),
  )

  // Regression: the terminal `result` envelope reports the SUM of every request the
  // CLI made behind one TurenOS turn, so its cache-read total describes no context
  // window. Trusting it put "Usage: 822%" against a 200,000-token limit on a real
  // session (1,577,905 summed cache reads on one assistant message) and, being a
  // running total, it could never fall when the session was compacted.
  //
  // Envelopes below are transcribed verbatim from
  //   claude -p ... --output-format stream-json --verbose --include-partial-messages
  // (the flags `args()` builds) driving two requests: 24,060 then 24,366 cached
  // prompt tokens, which the result reports as 48,426.
  it.effect("reports the final request, not the run total, as the turn's token usage", () =>
    Effect.gen(function* () {
      const script = replay([
        {
          type: "assistant",
          uuid: "a1",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "a.txt" } }],
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 24060,
              output_tokens: 1,
            },
          },
        },
        {
          type: "user",
          uuid: "u1",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_r1", content: "alpha" }] },
        },
        {
          type: "assistant",
          uuid: "a2",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "text", text: "alpha" }],
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 24366,
              output_tokens: 1,
            },
          },
        },
        {
          type: "result",
          subtype: "success",
          uuid: "done",
          is_error: false,
          result: "alpha",
          total_cost_usd: 0.19,
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 48426,
            output_tokens: 244,
            iterations: [
              {
                input_tokens: 2,
                output_tokens: 7,
                cache_read_input_tokens: 24366,
                cache_creation_input_tokens: 0,
                type: "message",
              },
            ],
          },
        },
      ])
      const events = Array.from(yield* collect(fakeCLI(script)))
      const finish = events.find((event) => event.type === "finish")!
      expect(finish).toMatchObject({
        usage: {
          // The last request's prompt — what the window actually holds — not 48,426.
          nonCachedInputTokens: 2,
          cacheReadInputTokens: 24366,
          cacheWriteInputTokens: 0,
          inputTokens: 24368,
          outputTokens: 7,
          totalTokens: 24375,
          // The run total survives, labelled as such, for cost and budget accounting.
          turn: {
            nonCachedInputTokens: 4,
            cacheReadInputTokens: 48426,
            cacheWriteInputTokens: 0,
            outputTokens: 244,
            reasoningTokens: 0,
          },
        },
      })
    }),
  )

  // Same run shape without `iterations`, which older CLI builds omit: the last
  // top-level `assistant` envelope carries the same prompt sizes and stands in.
  // Its `output_tokens` is Anthropic's message-start placeholder, not the real
  // count — a small understatement, and the only honest number available.
  it.effect("falls back to the last assistant envelope when the result omits iterations", () =>
    Effect.gen(function* () {
      const script = replay([
        {
          type: "assistant",
          uuid: "a1",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "text", text: "one" }],
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 5916,
              cache_read_input_tokens: 18165,
              output_tokens: 2,
            },
          },
        },
        {
          type: "assistant",
          uuid: "a2",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "text", text: "two" }],
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 481,
              cache_read_input_tokens: 24081,
              output_tokens: 1,
            },
          },
        },
        {
          type: "result",
          subtype: "success",
          uuid: "done",
          is_error: false,
          result: "two",
          total_cost_usd: 0.19,
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 6397,
            cache_read_input_tokens: 42246,
            output_tokens: 384,
          },
        },
      ])
      const events = Array.from(yield* collect(fakeCLI(script)))
      const finish = events.find((event) => event.type === "finish")!
      expect(finish).toMatchObject({
        usage: {
          nonCachedInputTokens: 2,
          cacheReadInputTokens: 24081,
          cacheWriteInputTokens: 481,
          inputTokens: 24564,
          turn: { cacheReadInputTokens: 42246, cacheWriteInputTokens: 6397, outputTokens: 384 },
        },
      })
    }),
  )

  // A Claude Code `Task` sub-agent occupies its own context window, and its
  // envelopes carry `parent_tool_use_id`. Its 12,508 cache-write tokens must not
  // become this window's figure — nor do they appear in `result.usage`, which the
  // CLI also scopes to top-level requests.
  it.effect("ignores sub-agent requests when measuring the parent's context", () =>
    Effect.sync(() => {
      const state = ClaudeCodeBridge.adapterState()
      ClaudeCodeBridge.trackRequest(state, {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 5916,
            cache_read_input_tokens: 18165,
            output_tokens: 2,
          },
        },
      })
      ClaudeCodeBridge.trackRequest(state, {
        type: "assistant",
        parent_tool_use_id: "toolu_01Cs6oDCqx4RtjHKA189TJBQ",
        message: {
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 12508,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      })
      expect(state.request).toEqual({ nonCached: 2, cacheRead: 18165, cacheWrite: 5916, output: 2 })
    }),
  )

  // Regression: the assistant envelope arrives before content_block_stop, and the
  // runner ends a tool input implicitly on tool-call. Emitting an end for the stop
  // as well killed the drain with "Duplicate tool input end" and left the tool call
  // pending forever in the UI.
  it.effect("emits exactly one tool-input start/end pair for a partial-message tool call", () =>
    Effect.gen(function* () {
      const script = replay([...toolCallEnvelopes({ id: "toolu_01", name: "Read" }), successResult])
      const events = Array.from(yield* collect(fakeCLI(script)))
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "tool-input-start",
        "tool-input-delta",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "tool-result",
        // No text block streamed in this fixture, so the terminal `result` text
        // is surfaced through the fallback path.
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      // The end must precede the call, because the runner closes the input itself
      // when the call arrives.
      expect(events.filter((event) => event.type === "tool-input-start")).toHaveLength(1)
      expect(events.filter((event) => event.type === "tool-input-end")).toHaveLength(1)
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1)
    }),
  )

  it.effect("settles a tool-calling turn through the real runner publisher", () =>
    Effect.gen(function* () {
      const script = replay([...toolCallEnvelopes({ id: "toolu_01", name: "Read" }), successResult])
      const events = Array.from(yield* collect(fakeCLI(script)))
      // Would die with "Duplicate tool input end" before the fix.
      const types = yield* publishAll(events)
      expect(types).toContain("session.next.tool.input.started")
      expect(types).toContain("session.next.tool.input.ended")
      expect(types).toContain("session.next.tool.called")
      expect(types).toContain("session.next.tool.success")
      expect(types).not.toContain("session.next.step.failed")
    }),
  )

  it.effect("ignores sub-agent tool traffic that TurenOS never started", () =>
    Effect.gen(function* () {
      const nested = [
        {
          type: "assistant",
          uuid: "n1",
          parent_tool_use_id: "toolu_01",
          message: { content: [{ type: "tool_use", id: "toolu_nested", name: "Grep", input: {} }] },
        },
        {
          type: "user",
          uuid: "n2",
          parent_tool_use_id: "toolu_01",
          message: { content: [{ type: "tool_result", tool_use_id: "toolu_nested", content: "inner" }] },
        },
      ]
      const script = replay([...toolCallEnvelopes({ id: "toolu_01", name: "Agent" }), ...nested, successResult])
      const events = Array.from(yield* collect(fakeCLI(script)))
      const ids = events.flatMap((event) => ("id" in event ? [String(event.id)] : []))
      expect(ids).not.toContain("toolu_nested")
      expect(events.find((event) => event.type === "tool-call")).toMatchObject({
        name: "Agent",
        providerExecuted: true,
      })
      const types = yield* publishAll(events)
      expect(types).not.toContain("session.next.step.failed")
    }),
  )

  it.effect("collapses a tool call repeated across envelopes into one call and one result", () =>
    Effect.gen(function* () {
      const envelopes = toolCallEnvelopes({ id: "toolu_01", name: "Read" })
      const duplicated = [...envelopes, envelopes[4], envelopes[5], envelopes[6], successResult]
      const events = Array.from(yield* collect(fakeCLI(replay(duplicated))))
      expect(events.filter((event) => event.type === "tool-input-end")).toHaveLength(1)
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1)
      expect(events.filter((event) => event.type === "tool-result")).toHaveLength(1)
      const types = yield* publishAll(events)
      expect(types).not.toContain("session.next.step.failed")
    }),
  )

  it.effect("surfaces a non-zero exit as a visible provider error rather than stalling", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* collect(fakeCLI("echo 'boom: could not start' >&2\nexit 3")))
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      const failure = events[1]
      expect(failure?.type).toBe("provider-error")
      if (failure?.type === "provider-error") expect(failure.message).toContain("Claude Code")
    }),
  )

  it.effect("finishes a successful turn when Claude emits a result but does not exit", () =>
    Effect.gen(function* () {
      const started = Date.now()
      const events = Array.from(
        yield* collect(fakeCLI(`${replay([successResult])}\nsleep 120`)).pipe(Effect.timeout("5 seconds")),
      )
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(Date.now() - started).toBeLessThan(5_000)
    }),
  )

  it.effect("keeps the Claude process alive while waiting for the first provider byte", () =>
    Effect.gen(function* () {
      const events = Array.from(
        yield* collect(fakeCLI(`sleep 1\n${replay([successResult])}`)).pipe(Effect.timeout("5 seconds")),
      )
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
    }),
  )

  it.effect("forwards image attachments as stream-json content blocks", () =>
    Effect.gen(function* () {
      const executable = fakeCLI("")
      const captured = path.join(path.dirname(executable), "stdin.json")
      writeFileSync(
        executable,
        [
          "#!/bin/sh",
          `cat > ${JSON.stringify(captured)}`,
          `echo ${envelope({ type: "result", subtype: "success", uuid: "u1", is_error: false, result: "ok", usage: {} })}`,
        ].join("\n") + "\n",
      )
      chmodSync(executable, 0o755)
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(executable))
      const request = LLM.request({
        model,
        system: "system context",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image" },
              { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "shot.png" },
            ],
          },
        ],
      })
      yield* LLM.stream(request).pipe(Stream.runCollect)
      const parsed = JSON.parse(readFileSync(captured, "utf8").trim())
      expect(parsed.type).toBe("user")
      const content = parsed.message.content
      expect(content[0].type).toBe("text")
      expect(content[0].text).toContain("what is in this image")
      expect(content[0].text).toContain("[image shot.png is attached to this conversation]")
      expect(content[1]).toEqual({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("bounds a raw stream-json line before parsing it", () =>
    Effect.gen(function* () {
      const events = Array.from(
        yield* collect(fakeCLI(`awk 'BEGIN { for (i = 0; i < ${9 * 1024 * 1024}; i++) printf "x" }'`)),
      )
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({
        type: "provider-error",
        message: expect.stringContaining("more output"),
      })
    }),
  )

  it.effect("treats an is_error result as a failed response even when its subtype says success", () =>
    Effect.gen(function* () {
      const script = replay([
        {
          type: "result",
          subtype: "success",
          uuid: "failed",
          is_error: true,
          result: "Request failed",
          usage: {},
        },
      ])
      const events = Array.from(yield* collect(fakeCLI(script)))
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({ type: "provider-error", message: expect.stringContaining("Claude Code") })
    }),
  )

  it.effect("rejects a successful result when the Claude process exits non-zero", () =>
    Effect.gen(function* () {
      const script = [replay([successResult]), "exit 3"].join("\n")
      const events = Array.from(yield* collect(fakeCLI(script)))
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({
        type: "provider-error",
        message: expect.stringContaining("exited with code 3"),
      })
    }),
  )

  it.effect("reports malformed stream-json output instead of silently dropping the response", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* collect(fakeCLI("echo 'not-json'")))
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({
        type: "provider-error",
        message: "Claude Code returned an invalid response. Update the `claude` CLI and try again.",
      })
    }),
  )

  it.effect("reports malformed typed deltas instead of persisting a partial success", () =>
    Effect.gen(function* () {
      const script = replay([
        {
          type: "stream_event",
          uuid: "bad-delta",
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        },
        {
          type: "stream_event",
          uuid: "bad-delta",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 42 } },
        },
        successResult,
      ])
      const events = Array.from(yield* collect(fakeCLI(script)))
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({
        type: "provider-error",
        message: "Claude Code returned an invalid response. Update the `claude` CLI and try again.",
      })
    }),
  )

  it.effect("does not start an assistant message for retryable API error text", () =>
    Effect.gen(function* () {
      const script = replay([
        {
          type: "stream_event",
          uuid: "api-error",
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        },
        {
          type: "stream_event",
          uuid: "api-error",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "API Error: service overloaded" },
          },
        },
        { type: "stream_event", uuid: "api-error", event: { type: "content_block_stop", index: 0 } },
        {
          type: "result",
          subtype: "error_during_execution",
          uuid: "api-error-result",
          is_error: true,
          result: "API Error: service overloaded",
          usage: {},
        },
      ])
      const events = Array.from(yield* collect(fakeCLI(script)))
      expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
      expect(events.at(-1)).toMatchObject({ type: "provider-error", retryable: true })
    }),
  )

  it.effect("reports a blocked hook without persisting its echoed prompt", () =>
    Effect.sync(() => {
      const echoed = [
        "UserPromptSubmit operation blocked by hook:",
        "Blocked: Detected tool execution manipulation",
        "",
        "Original prompt: USER:",
        "secret rate limit transcript",
      ].join("\n")
      const events = [false, true].map((is_error) =>
        ClaudeCodeBridge.toEvents(ClaudeCodeBridge.adapterState(), {
          type: "result",
          subtype: "success",
          uuid: "hook-blocked",
          is_error,
          num_turns: 0,
          duration_api_ms: 0,
          result: echoed,
          usage: {},
        }),
      )
      const expected = {
        type: "provider-error" as const,
        message:
          "Claude Code blocked this request in its UserPromptSubmit hook. Check your Claude Code hook configuration and try again.",
        retryable: false,
      }
      expect(events).toEqual([[expected], [expected]])
      expect(JSON.stringify(events)).not.toContain("secret rate limit transcript")
      expect(JSON.stringify(events)).not.toContain("Detected tool execution manipulation")
    }),
  )

  it.effect("preserves successful text that quotes a hook diagnostic after a provider turn", () =>
    Effect.sync(() => {
      const result = [
        "UserPromptSubmit operation blocked by hook:",
        "Example explanation",
        "",
        "Original prompt: example",
      ].join("\n")
      const events = ClaudeCodeBridge.toEvents(ClaudeCodeBridge.adapterState(), {
        type: "result",
        subtype: "success",
        uuid: "hook-lookalike",
        is_error: false,
        num_turns: 1,
        duration_api_ms: 10,
        result,
        usage: {},
      })
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: result })
      expect(events.at(-1)?.type).toBe("finish")
    }),
  )

  it.effect("caps terminal fallback text before it reaches the transcript", () =>
    Effect.sync(() => {
      const events = ClaudeCodeBridge.toEvents(ClaudeCodeBridge.adapterState(), {
        type: "result",
        subtype: "success",
        uuid: "large-fallback",
        is_error: false,
        result: `${"context ".repeat(20_000)}private-tail`,
        usage: {},
      })
      const output = events.flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join("")
      expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(64 * 1024 + 24)
      expect(output.endsWith("\n[truncated by TurenOS]")).toBe(true)
      expect(output).not.toContain("private-tail")
      expect(events.at(-1)?.type).toBe("finish")
    }),
  )

  it.effect("caps cumulative streamed assistant text once without corrupting UTF-8", () =>
    Effect.sync(() => {
      const state = ClaudeCodeBridge.adapterState()
      const events = [
        {
          type: "stream_event",
          uuid: "large-stream",
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        },
        {
          type: "stream_event",
          uuid: "large-stream",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "a".repeat(65_529) },
          },
        },
        {
          type: "stream_event",
          uuid: "large-stream",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "界界界private-tail" },
          },
        },
        {
          type: "stream_event",
          uuid: "large-stream",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "never-emitted" } },
        },
        { type: "stream_event", uuid: "large-stream", event: { type: "content_block_stop", index: 0 } },
      ].flatMap((message) => ClaudeCodeBridge.toEvents(state, message))
      const output = events.flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join("")
      expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(64 * 1024 + 24)
      expect(output.match(/\[truncated by TurenOS\]/g)).toHaveLength(1)
      expect(output).not.toContain("�")
      expect(output).not.toContain("private-tail")
      expect(output).not.toContain("never-emitted")
    }),
  )

  it.effect("enforces prompt limits in UTF-8 bytes", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel("claude"))
      const request = LLM.request({
        model,
        system: "界".repeat(100_000),
        prompt: "hello",
      })
      expect(new TextEncoder().encode(ClaudeCodeBridge.systemPrompt(request)).byteLength).toBeLessThanOrEqual(96 * 1024)
    }),
  )

  it.effect("reports a missing executable instead of silently producing nothing", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* collect(path.join(tmpdir(), "forge-claude-code-absent", "claude")))
      const failure = events.at(-1)!
      expect(failure.type).toBe("provider-error")
      if (failure.type === "provider-error") expect(failure.message).toContain("was not found")
    }),
  )

  // Regression: `Stream.callback` forks the transport's register effect and
  // discards its exit, so a failing `ClaudeCodeMcp.serve` (a token with no
  // registered bridge) was silently swallowed — the stream never emitted, never
  // failed, and the turn hung forever. The failure must now surface promptly as
  // a visible LLMError, before any CLI process is ever spawned. `it.live` so
  // the guarding `Effect.timeout` runs on the real clock.
  it.live("fails the turn promptly when the request names an unregistered MCP bridge", () =>
    Effect.gen(function* () {
      const executable = fakeCLI("")
      const marker = path.join(path.dirname(executable), "spawned")
      writeFileSync(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
      chmodSync(executable, 0o755)
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(executable))
      const request = LLM.request({
        model,
        system: "system context",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        metadata: ClaudeCodeMcp.requestMetadata("00000000-0000-0000-0000-000000000000"),
      })
      const failure = yield* LLM.stream(request).pipe(
        Stream.runCollect,
        // Before the fix this hung forever; a timeout failure here (instead of
        // the LLMError below) means the hang regressed.
        Effect.timeout("5 seconds"),
        Effect.flip,
      )
      expect(failure).toBeInstanceOf(LLMError)
      expect(failure.message).toContain("Claude Code MCP bridge is unavailable")
      // The bridge failed during acquisition, so the CLI must never have spawned.
      expect(existsSync(marker)).toBe(false)
    }).pipe(Effect.provide(layer)),
  )

  // `it.live` because this asserts on real elapsed time and real OS processes;
  // the default TestClock would never let the child start.
  it.live("kills the child process when the turn is interrupted", () =>
    Effect.gen(function* () {
      const marker = `forge-cc-orphan-${process.pid}-${Date.now()}`
      // Emits one event so the stream is live, then hangs. Only a working
      // teardown path can end it.
      const script = [
        `# ${marker}`,
        `echo ${envelope({
          type: "stream_event",
          uuid: "u1",
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        })}`,
        `sleep 120`,
      ].join("\n")
      const executable = fakeCLI(script)
      const fiber = yield* collect(executable).pipe(Effect.forkChild)
      yield* Effect.sleep("600 millis")
      expect(survivors(executable).length).toBeGreaterThan(0)
      yield* Fiber.interrupt(fiber)
      yield* Effect.sleep("400 millis")
      expect(survivors(executable)).toEqual([])
    }),
  )

  it.live(
    "kills a SIGTERM-resistant descendant when the direct CLI exits",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const marker = `forge-cc-resistant-${process.pid}-${Date.now()}`
        const executable = fakeCLI(`sh -c 'trap "" TERM; while :; do sleep 1; done' ${marker} &\nwait`)
        const fiber = yield* collect(executable).pipe(Effect.forkChild)
        yield* Effect.sleep("600 millis")
        expect(survivors(marker).length).toBeGreaterThan(0)
        yield* Fiber.interrupt(fiber)
        expect(survivors(marker)).toEqual([])
      }),
    8_000,
  )
})
