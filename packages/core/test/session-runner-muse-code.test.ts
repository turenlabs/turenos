import { describe, expect } from "bun:test"
import { LLM } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ModelV2 } from "@turenlabs/core/model"
import { MuseCodeCLI } from "@turenlabs/core/provider/muse-code"
import { MuseCodeBridge } from "@turenlabs/core/session/runner/muse-code-bridge"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { it } from "./lib/effect"

const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
const catalogModel = (executable: string) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("muse-spark-1.3"),
    providerID: MuseCodeCLI.ID,
    name: "Muse Spark 1.3",
    api: { type: "native", id: ModelV2.ID.make("muse-spark-1.3"), url: MuseCodeCLI.API_URL, settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: { [MuseCodeCLI.EXECUTABLE_KEY]: executable } },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 128_000, output: 16_000 },
  })

const terminal = {
  schema_version: 1,
  payload_type: "run.terminal.completed",
  payload: { terminal: "completed", text: "hello world" },
}
const delta = (text: string) => ({ schema_version: 1, payload_type: "run.output.delta", payload: { text } })
const replay = (values: ReadonlyArray<unknown>) =>
  values.map((value) => `console.log(${JSON.stringify(JSON.stringify(value))})`).join("\n")

/** A real subprocess, never the installed Muse CLI or a live provider. */
const fakeCLI = (body: string, version = MuseCodeBridge.SUPPORTED_VERSION) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(tmpdir(), "forge-muse-test-"))
      const executable = path.join(directory, "muse")
      const capture = path.join(directory, "capture.json")
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          `if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0) }`,
          `const capture = ${JSON.stringify(capture)}`,
          `await Bun.write(capture, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, settings: await Bun.file(process.env.XDG_CONFIG_HOME + "/muse/settings.json").json(), prompt: await Bun.file(process.env.XDG_CONFIG_HOME + "/prompt.txt").text() }))`,
          body,
          "",
        ].join("\n"),
      )
      chmodSync(executable, 0o755)
      return { executable, capture }
    }),
    (cli) => Effect.sync(() => rmSync(path.dirname(cli.executable), { recursive: true, force: true })),
  )

const collect = (
  executable: string,
  content: Parameters<typeof LLM.request>[0]["messages"] = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ],
) =>
  Effect.gen(function* () {
    const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel(executable))
    return Array.from(
      yield* LLM.stream(LLM.request({ model, system: "system context", messages: content })).pipe(Stream.runCollect),
    )
  }).pipe(Effect.provide(layer))

const failureText = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
}

describe("SessionRunner muse-code transport", () => {
  it.effect("resolves the supported catalog model onto the local CLI route", () =>
    Effect.gen(function* () {
      const info = catalogModel("muse")
      expect(MuseCodeCLI.MODELS.map((model) => model.id)).toContain(info.id)
      expect(MuseCodeBridge.isMuseCode(info)).toBe(true)
      expect(SessionRunnerModel.supported(info)).toBe(true)
      expect(SessionRunnerModel.selectable(info)).toBe(true)
      const model = yield* SessionRunnerModel.fromCatalogModel(info)
      expect(model.route.id).toBe("muse-code-cli")
      expect(String(model.provider)).toBe("muse-code")
    }),
  )

  it.effect("streams deltas once and does not repeat terminal text or terminal events", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(replay([delta("hello "), delta("world"), terminal, terminal]))
      const events = yield* collect(cli.executable)
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(
        events
          .filter((event) => event.type === "text-delta")
          .map((event) => event.text)
          .join(""),
      ).toBe("hello world")
    }),
  )

  it.effect("uses terminal-only text but does not fabricate absent usage", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(replay([terminal]))
      const events = yield* collect(cli.executable)
      expect(events.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual(["hello world"])
      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(events.find((event) => event.type === "step-finish")?.usage).toBeUndefined()
      expect(events.find((event) => event.type === "finish")?.usage).toBeUndefined()
    }),
  )

  it.effect("rejects nonzero exit even after a successful terminal envelope", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(`${replay([delta("partial"), terminal])}\nprocess.exitCode = 7`)
      const events = yield* collect(cli.executable)
      expect(events.at(-1)).toMatchObject({ type: "provider-error", retryable: false })
      expect(events.filter((event) => event.type === "finish" || event.type === "step-finish")).toEqual([])
    }),
  )

  for (const [name, output] of [
    ["malformed JSON", 'console.log("{broken")'],
    ["unknown schema version", replay([{ ...terminal, schema_version: 2 }])],
    ["missing payload", replay([{ schema_version: 1, payload_type: "run.terminal.completed" }])],
  ]) {
    it.effect(`fails closed on ${name}`, () =>
      Effect.gen(function* () {
        const cli = yield* fakeCLI(output!)
        const events = yield* collect(cli.executable)
        expect(events.map((event) => event.type)).toEqual(["step-start", "provider-error"])
        expect(events.at(-1)).toMatchObject({ message: expect.stringContaining("malformed JSONL") })
      }),
    )
  }

  it.effect("does not finish when the CLI exits without a terminal", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(replay([delta("partial")]))
      const events = yield* collect(cli.executable)
      expect(events.map((event) => event.type)).toEqual(["step-start", "text-start", "text-delta", "provider-error"])
    }),
  )

  it.effect("rejects an incompatible build before executing a model turn", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(replay([terminal]), "Muse Code unsupported-test-version")
      const exit = yield* collect(cli.executable).pipe(Effect.exit)
      expect(failureText(exit)).toContain("Unsupported Muse Code build")
      expect(existsSync(cli.capture)).toBe(false)
    }),
  )

  it.effect("spawns exec in an isolated workspace with restrictive settings", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(replay([terminal]))
      yield* collect(cli.executable)
      const captured = JSON.parse(readFileSync(cli.capture, "utf8"))
      expect(captured.argv.slice(0, 6)).toEqual(["exec", "--json", "--provider", "meta", "--model", "muse-spark-1.3"])
      expect(captured.argv).toContain("--disable-shell")
      expect(captured.argv).toContain("--disable-write")
      expect(captured.argv).toContain("--disable-web-tools")
      expect(captured.argv).toContain("--no-foreign-personal-context")
      expect(captured.cwd).toBe(
        path.join(realpathSync(tmpdir()), path.basename(captured.env.XDG_CONFIG_HOME), "workspace"),
      )
      expect(captured.settings.run.toolset).toEqual([])
      expect(captured.settings.mcpServers).toEqual({})
      expect(captured.settings.run.system_prompt).toContain("system context")
      expect(captured.prompt).toBe("USER:\nhello")
      expect(existsSync(captured.env.XDG_CONFIG_HOME)).toBe(false)
    }),
  )

  it.effect("excludes API keys and runtime/hook environment overrides", () =>
    Effect.sync(() => {
      const env = MuseCodeBridge.environment("/isolated", {
        HOME: "/home/test",
        PATH: "/bin",
        LANG: "en_US.UTF-8",
        META_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        MUSE_API_KEY: "secret",
        MUSE_HOOKS: "unsafe",
        BASH_ENV: "/unsafe",
        NODE_OPTIONS: "--require=/unsafe",
        LD_PRELOAD: "/unsafe",
        DYLD_INSERT_LIBRARIES: "/unsafe",
        XDG_CONFIG_HOME: "/unsafe",
        XDG_DATA_HOME: "/unsafe",
        TBH_CREDENTIAL_BACKEND: "unsafe",
      })
      expect(env).toMatchObject({ HOME: "/home/test", PATH: "/bin", LANG: "en_US.UTF-8", XDG_CONFIG_HOME: "/isolated" })
      for (const name of [
        "META_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "MUSE_API_KEY",
        "MUSE_HOOKS",
        "BASH_ENV",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "TBH_CREDENTIAL_BACKEND",
      ]) {
        expect(env).not.toHaveProperty(name)
      }
      expect(env.XDG_DATA_HOME).toBe("/isolated/data")
      expect(env.NO_PROXY).toContain("127.0.0.1")
    }),
  )

  it.effect("requires authenticated host MCP and excludes native work tools", () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.fromCatalogModel(catalogModel("muse"))
      const settings = MuseCodeBridge.settings(LLM.request({ model, prompt: "hello" }), {
        url: "http://127.0.0.1:1234/mcp",
        authorization: "Bearer test-only",
      })
      expect(settings.mcpServers.forge).toEqual({
        transport: "streamable_http",
        url: "http://127.0.0.1:1234/mcp",
        headers: { Authorization: "Bearer test-only" },
        enabled: true,
        mode: "required",
      })
      expect(settings.run).not.toHaveProperty("toolset")
      for (const name of [
        "read_file",
        "search",
        "write_file",
        "edit_file",
        "apply_patch",
        "bash",
        "shell",
        "exec_command",
        "write_todos",
        "web_search",
        "web_fetch",
        "subagent_spawn",
        "code_exec",
        "read_memory",
        "add_memory",
      ]) {
        expect(settings.run.context_slimming.excluded_tool_names.some((tool) => tool === name)).toBe(true)
      }
    }),
  )

  it.effect("rejects media before the exec subprocess starts", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(replay([terminal]))
      const exit = yield* collect(cli.executable, [
        { role: "user", content: [{ type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "image.png" }] },
      ]).pipe(Effect.exit)
      expect(failureText(exit)).toContain("supports text only")
      expect(existsSync(cli.capture)).toBe(false)
    }),
  )

  it.effect("rejects oversized UTF-8 prompts before the exec subprocess starts", () =>
    Effect.gen(function* () {
      const cli = yield* fakeCLI(replay([terminal]))
      const exit = yield* collect(cli.executable, [
        { role: "user", content: [{ type: "text", text: "é".repeat(2 * 1024 * 1024) }] },
      ]).pipe(Effect.exit)
      expect(failureText(exit)).toContain("4 MiB limit")
      expect(existsSync(cli.capture)).toBe(false)
    }),
  )

  it.live(
    "tears down the subprocess on cancellation",
    () =>
      Effect.gen(function* () {
        const cli = yield* fakeCLI(`${replay([delta("started")])}\nsetTimeout(() => process.exit(0), 10_000)`)
        const fiber = yield* collect(cli.executable).pipe(Effect.forkChild)
        // Wait for the actual exec handshake, rather than assuming a spawn delay.
        for (let attempt = 0; attempt < 100 && !existsSync(cli.capture); attempt++) yield* Effect.sleep("20 millis")
        expect(existsSync(cli.capture)).toBe(true)
        const captured = JSON.parse(readFileSync(cli.capture, "utf8"))
        expect(() => process.kill(captured.pid, 0)).not.toThrow()
        yield* Fiber.interrupt(fiber)
        expect(() => process.kill(captured.pid, 0)).toThrow()
        expect(existsSync(captured.env.XDG_CONFIG_HOME)).toBe(false)
      }),
    8_000,
  )
})
