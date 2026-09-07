export * as MuseCodeBridge from "./muse-code-bridge"

import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { isContextOverflow, LLMError, LLMEvent, LLMRequest, TransportReason } from "@turenlabs/llm"
import { Endpoint, Protocol, Route, type RouteDefaultsInput, type TransportDef } from "@turenlabs/llm/route"
import { Cause, Effect, Queue, Schema, Stream } from "effect"
import { ModelV2 } from "../../model"
import { MuseCodeCLI } from "../../provider/muse-code"
import { ClaudeCodeMcp } from "./claude-code-mcp-namespace"

const ROUTE_ID = "muse-code-cli"
// Muse has a native-tool exclusion list, not an MCP-only allowlist. Requalify
// both the exposed schemas AND forced native calls before accepting a new build.
export const SUPPORTED_VERSION = "Muse Code 1.0.3 (1.0.3-R2198.1)"
export const NATIVE_TOOLS = [
  "workflow",
  "read_file",
  "search",
  "write_file",
  "edit_file",
  "apply_patch",
  "read_memory",
  "add_memory",
  "edit_memory",
  "bash",
  "bash_input",
  "shell",
  "exec_command",
  "write_stdin",
  "work_stop",
  "monitor",
  "read_skill",
  "write_todos",
  "update_plan",
  "TodoWrite",
  "create_goal",
  "update_goal",
  "report_progress",
  "cron_create",
  "cron_delete",
  "cron_list",
  "code_exec",
  "code_wait",
  "web_search",
  "web_fetch",
  "send_session_message",
  "list_peer_sessions",
  "request_user_input",
  "subagent_spawn",
  "subagent_status",
  "subagent_send_message",
  "subagent_wait",
  "subagent_read_result",
  "subagent_cancel",
  "snooze_reminder",
] as const
const PROMPT_LIMIT = 4 * 1024 * 1024
const LINE_LIMIT = 8 * 1024 * 1024
const OUTPUT_LIMIT = 32 * 1024 * 1024
const STDERR_LIMIT = 8 * 1024
const exec = promisify(execFile)
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const error = (message: string) =>
  new LLMError({
    module: "MuseCodeBridge",
    method: "stream",
    reason: new TransportReason({ message, kind: ROUTE_ID }),
  })

export function environment(directory: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TZ",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]
  return {
    ...Object.fromEntries(names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]]))),
    XDG_CONFIG_HOME: directory,
    XDG_DATA_HOME: join(directory, "data"),
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    MUSE_UPDATE_INTERVAL_SECONDS: "2147483647",
  }
}

export function prompt(request: LLMRequest) {
  const text =
    request.messages
      .map(
        (message) =>
          `${message.role.toUpperCase()}:\n${message.content
            .map((part) => {
              if (part.type === "text") return part.text
              if (part.type === "reasoning") return `[reasoning]\n${part.text}`
              if (part.type === "tool-call") return `[tool call ${part.name}] ${JSON.stringify(part.input)}`
              if (part.type === "tool-result") return `[tool result ${part.name}] ${JSON.stringify(part.result.value)}`
              throw new Error("Muse Code bridge currently supports text only")
            })
            .join("\n")}`,
      )
      .join("\n\n") || "Continue."
  if (Buffer.byteLength(text) > PROMPT_LIMIT) throw new Error("Muse Code prompt exceeds the bridge's 4 MiB limit")
  return text
}

export const settings = (request: LLMRequest, mcp?: { url: string; authorization: string }) => ({
  schema_version: 1,
  run: {
    system_prompt: [
      "You are running inside TurenOS. TurenOS owns the session, permissions, workspace, tools, and conversation history.",
      "Use only tools from the forge MCP server for work. Your local workspace is an empty transport directory, not the user's project. Do not use native write_todos; use the host's todowrite tool when available.",
      ...request.system.map((part) => part.text),
    ].join("\n\n"),
    ...(mcp ? {} : { toolset: [] }),
    context_slimming: { excluded_tool_names: NATIVE_TOOLS },
  },
  mcpServers: mcp
    ? {
        forge: {
          transport: "streamable_http",
          url: mcp.url,
          headers: { Authorization: mcp.authorization },
          enabled: true,
          mode: "required",
        },
      }
    : {},
})

export const args = (input: { directory: string; modelID: string; effort?: MuseCodeCLI.EffortLevel }) => [
  "exec",
  "--json",
  "--provider",
  "meta",
  "--model",
  input.modelID,
  "--workspace",
  join(input.directory, "workspace"),
  "--prompt-file",
  join(input.directory, "prompt.txt"),
  "--no-session-log",
  "--no-foreign-personal-context",
  "--disable-shell",
  "--disable-write",
  "--disable-web-tools",
  "--disable-approval",
  "--approval-judge",
  "off",
  "--max-model-steps",
  "100",
  "--max-tool-output-bytes",
  "524288",
  ...(input.effort ? ["--reasoning-effort", input.effort] : []),
]

export const adapterState = () => ({ text: "", started: false, terminal: false })

export function toEvents(state: ReturnType<typeof adapterState>, value: unknown): LLMEvent[] {
  const envelope = record(value)
  const payload = record(envelope?.payload)
  if (envelope?.schema_version !== 1 || !payload || typeof envelope.payload_type !== "string")
    throw new Error("Muse Code returned malformed JSONL")
  if (state.terminal) return []
  if (envelope.payload_type === "run.output.delta" && typeof payload.text === "string") {
    const events = state.started ? [] : [LLMEvent.textStart({ id: "muse-text" })]
    state.started = true
    state.text += payload.text
    return [...events, LLMEvent.textDelta({ id: "muse-text", text: payload.text })]
  }
  if (!envelope.payload_type.startsWith("run.terminal.")) return []
  state.terminal = true
  if (payload.terminal !== "completed") return [safeProviderError(payload.reason ?? payload.terminal)]
  const events: LLMEvent[] = []
  if (!state.started && typeof payload.text === "string" && payload.text) {
    state.started = true
    events.push(LLMEvent.textStart({ id: "muse-text" }), LLMEvent.textDelta({ id: "muse-text", text: payload.text }))
  }
  if (state.started) events.push(LLMEvent.textEnd({ id: "muse-text" }))
  // exec JSONL does not publish token usage. Leave it absent, not estimated or
  // fabricated as zero. MCP callbacks already publish the host tool lifecycle.
  events.push(LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" }))
  return events
}

export function safeProviderError(cause: unknown): LLMEvent {
  const text = cause instanceof Error ? cause.message : String(cause)
  const message = /credential|auth|login/i.test(text)
    ? "Muse Code is not signed in. Run `muse login`, then try again."
    : /ENOENT|not found/i.test(text)
      ? "Muse Code was not found. Install the `muse` CLI or configure its executable path."
      : /malformed|JSON/i.test(text)
        ? "Muse Code returned malformed JSONL. The installed CLI may be incompatible."
        : /limit|exceed/i.test(text)
          ? "Muse Code exceeded a bridge safety limit. Reduce the context or output and try again."
          : "Muse Code stopped before completing the turn. Check the CLI login and model availability."
  return LLMEvent.providerError({
    message,
    retryable: false,
    ...(isContextOverflow(text) ? { classification: "context-overflow" as const } : {}),
  })
}

const protocol = Protocol.make({
  id: ROUTE_ID,
  body: { schema: Schema.declare((value): value is LLMRequest => value instanceof LLMRequest), from: Effect.succeed },
  stream: {
    event: Schema.declare((value): value is LLMEvent => Schema.is(LLMEvent)(value)),
    initial: () => undefined,
    step: (_, event) => Effect.succeed([undefined, [event]] as const),
  },
})

const transport = (input: {
  executable: string
  modelID: string
  effort?: MuseCodeCLI.EffortLevel
}): TransportDef<LLMRequest, LLMRequest, LLMEvent> => ({
  id: ROUTE_ID,
  prepare: (value) => Effect.succeed(value.request),
  frames: (request) =>
    Stream.callback<LLMEvent, LLMError>((queue) =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.try({
            try: () => mkdtempSync(join(tmpdir(), "turen-muse-")),
            catch: () => error("Could not create Muse transport directory"),
          }),
          (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
        )
        const env = environment(directory)
        const version = yield* Effect.tryPromise({
          try: (signal) =>
            exec(input.executable, ["--version"], {
              env,
              cwd: directory,
              signal,
              timeout: 10_000,
              maxBuffer: 32 * 1024,
              killSignal: "SIGKILL",
            }),
          catch: () => error("Could not check Muse Code version. Install Muse Code and run `muse login`."),
        })
        if (version.stdout.trim() !== SUPPORTED_VERSION)
          return yield* Effect.fail(
            error(
              `Unsupported Muse Code build. This bridge is qualified for ${SUPPORTED_VERSION}; its native-tool isolation must be requalified before using another build.`,
            ),
          )
        const token = ClaudeCodeMcp.requestToken(request.metadata)
        if (request.tools.length > 0 && !token)
          return yield* Effect.fail(error("Muse Code requires the host MCP tool bridge"))
        const mcp = token
          ? yield* ClaudeCodeMcp.serve(token).pipe(Effect.mapError((cause) => error(cause.message)))
          : undefined
        yield* Effect.try({
          try: () => {
            mkdirSync(join(directory, "muse"), { recursive: true })
            mkdirSync(join(directory, "workspace"))
            const auth = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "muse", "auth.json")
            if (existsSync(auth)) symlinkSync(auth, join(directory, "muse", "auth.json"))
            const config = JSON.stringify(settings(request, mcp))
            if (Buffer.byteLength(config) > PROMPT_LIMIT) throw new Error("Muse Code settings exceed safety limit")
            writeFileSync(join(directory, "muse", "settings.json"), config, { mode: 0o600 })
            writeFileSync(join(directory, "prompt.txt"), prompt(request), { mode: 0o600 })
          },
          catch: (cause) => error(cause instanceof Error ? cause.message : "Could not prepare Muse Code prompt"),
        })

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const proc = spawn(input.executable, args({ ...input, directory }), {
              env,
              cwd: join(directory, "workspace"),
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
              windowsHide: true,
            })
            const state = adapterState()
            const decoder = new TextDecoder()
            let buffer = ""
            let stderr = ""
            let size = 0
            let closed = false
            let terminalEvents: LLMEvent[] | undefined
            let terminalTimer: ReturnType<typeof setTimeout> | undefined
            const done = (failure?: unknown) => {
              if (closed) return
              closed = true
              clearTimeout(terminalTimer)
              if (failure !== undefined) Queue.offerUnsafe(queue, safeProviderError(failure))
              Queue.endUnsafe(queue)
            }
            const consume = (line: string) => {
              if (!line.trim()) return
              const events = toEvents(state, JSON.parse(line))
              if (state.terminal) {
                if (terminalEvents) return
                terminalEvents = events
                // A terminal envelope is not enough: a nonzero exit still fails. A
                // wedged CLI is torn down rather than keeping the turn open forever.
                terminalTimer = setTimeout(() => done("Muse Code did not exit after its terminal event"), 5_000)
                return
              }
              events.forEach((event) => Queue.offerUnsafe(queue, event))
            }
            Queue.offerUnsafe(queue, LLMEvent.stepStart({ index: 0 }))
            proc.stdout.on("data", (chunk: Buffer) => {
              if (closed) return
              try {
                size += chunk.byteLength
                if (size > OUTPUT_LIMIT) throw new Error("Muse Code output exceeds safety limit")
                buffer += decoder.decode(chunk, { stream: true })
                let newline = buffer.indexOf("\n")
                while (newline >= 0) {
                  if (Buffer.byteLength(buffer.slice(0, newline)) > LINE_LIMIT)
                    throw new Error("Muse Code line exceeds safety limit")
                  consume(buffer.slice(0, newline))
                  buffer = buffer.slice(newline + 1)
                  newline = buffer.indexOf("\n")
                }
                if (Buffer.byteLength(buffer) > LINE_LIMIT) throw new Error("Muse Code line exceeds safety limit")
              } catch (cause) {
                done(cause)
              }
            })
            proc.stdout.on("error", done)
            proc.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8").slice(0, Math.max(0, STDERR_LIMIT - stderr.length))
            })
            proc.stderr.on("error", done)
            proc.on("error", done)
            const exit = new Promise<void>((resolve) =>
              proc.once("close", (code, signal) => {
                resolve()
                if (closed) return
                try {
                  consume(buffer + decoder.decode())
                  if (code !== 0 || signal || !terminalEvents)
                    return done(stderr || `Muse Code exited with code ${code}`)
                  terminalEvents.forEach((event) => Queue.offerUnsafe(queue, event))
                  done()
                } catch (cause) {
                  done(cause)
                }
              }),
            )
            return { proc, exit, done }
          }),
          (child) =>
            Effect.promise(async () => {
              child.done()
              const signal = (value: NodeJS.Signals) => {
                if (!child.proc.pid) return
                try {
                  if (process.platform === "win32") child.proc.kill(value)
                  else process.kill(-child.proc.pid, value)
                } catch {
                  /* process group already exited */
                }
              }
              signal("SIGTERM")
              const timeout = setTimeout(() => signal("SIGKILL"), 2_000)
              await Promise.race([child.exit, new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())])
              clearTimeout(timeout)
              // Descendants can outlive a successfully exited group leader.
              signal("SIGKILL")
            }),
        )
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Queue.failCause(queue, cause),
        ),
      ),
    ),
})

export const isMuseCode = (model: ModelV2.Info) =>
  model.providerID === MuseCodeCLI.ID && model.api.type === "native" && model.api.url === MuseCodeCLI.API_URL

export const routeModel = (input: {
  providerID: string
  modelID: string
  executable: string
  effort?: MuseCodeCLI.EffortLevel
  defaults: RouteDefaultsInput
}) =>
  Route.make({
    id: ROUTE_ID,
    provider: input.providerID,
    protocol,
    endpoint: Endpoint.path("", { baseURL: "https://muse-code-cli.invalid" }),
    transport: transport(input),
    defaults: input.defaults,
  }).model({ id: input.modelID })

export const model = (input: { model: ModelV2.Info; defaults: RouteDefaultsInput }) => {
  const configured = input.model.request.body[MuseCodeCLI.EXECUTABLE_KEY]
  const effort = input.model.request.body[MuseCodeCLI.EFFORT_KEY]
  return routeModel({
    providerID: input.model.providerID,
    modelID: input.model.api.id,
    executable:
      MuseCodeCLI.resolveExecutable(configured) ??
      (typeof configured === "string" ? configured : MuseCodeCLI.DEFAULT_EXECUTABLE),
    effort: MuseCodeCLI.isEffortLevel(effort) ? effort : undefined,
    defaults: input.defaults,
  })
}
