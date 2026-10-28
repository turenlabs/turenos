export * as DevinACP from "./devin-acp"

import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import { LLMError, LLMEvent, LLMRequest, TransportReason } from "@turenlabs/llm"
import { Endpoint, Protocol, Route, type RouteDefaultsInput, type TransportDef } from "@turenlabs/llm/route"
import { Cause, Effect, Queue, Schema, Stream } from "effect"
import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { promisify } from "node:util"
import { ModelV2 } from "../../model"
import { DevinCLI } from "../../provider/devin-cli"
import { ClaudeCodeMcp } from "./claude-code-mcp-namespace"

const ROUTE_ID = "devin-acp"
export const SUPPORTED_VERSION = "devin 3000.11.228 (053434014dbd)"
export const NATIVE_TOOLS = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "notebook_read",
  "notebook_edit",
  "grep",
  "glob",
  "exec",
  "get_output",
  "write_to_process",
  "kill_shell",
  "webfetch",
  "web_search",
  "todo_write",
  "exit_plan_mode",
  "skill",
  "run_subagent",
  "read_subagent",
  "request_scope",
  "mcp_list_servers",
  "mcp_list_tools",
  "mcp_call_tool",
  "mcp_read_resource",
  "ask_user_question",
  "shell",
  "shell_command",
  "exec_command",
  "write_stdin",
  "update_plan",
] as const
const PROMPT_LIMIT = 4 * 1024 * 1024
const LINE_LIMIT = 8 * 1024 * 1024
const OUTPUT_LIMIT = 32 * 1024 * 1024
const START_TIMEOUT = 30_000
const TURN_TIMEOUT = 15 * 60_000
const exec = promisify(execFile)
const error = (message: string) =>
  new LLMError({
    module: "DevinACP",
    method: "stream",
    reason: new TransportReason({ message, kind: ROUTE_ID }),
  })

export function environment(directory: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TZ",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
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
    HOME: join(directory, "home"),
    USERPROFILE: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"),
    APPDATA: join(directory, "config"),
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    SHELL: "/bin/sh",
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    ELECTRON_RUN_AS_NODE: "1",
    DEVIN_SESSIONS_DIR: join(directory, "sessions"),
    DEVIN_PERMISSION_MODE: "auto",
  }
}

export const credentialsPath = (source: NodeJS.ProcessEnv = process.env) =>
  process.platform === "win32"
    ? source.APPDATA
      ? join(source.APPDATA, "devin", "credentials.toml")
      : undefined
    : join(source.XDG_DATA_HOME ?? join(source.HOME ?? homedir(), ".local", "share"), "devin", "credentials.toml")

// The hook is a second boundary for tools added by a future model or plugin.
// It must not grant permission: the private MCP server applies current host policy.
export const GUARD = `const { readFileSync } = require("node:fs")
const input = JSON.parse(readFileSync(0, "utf8"))
if (typeof input.tool_name === "string" && input.tool_name.startsWith("mcp__forge__")) process.exit(0)
process.stderr.write("Use only TurenOS tools from the forge MCP server.")
process.exit(2)
`

export const settings = (directory: string) => ({
  auto_update: false,
  subagents_enabled: false,
  disabled_tools: NATIVE_TOOLS,
  agent: { codex_tools: false },
  read_config_from: Object.fromEntries(
    ["agents_standard", "cursor", "windsurf", "claude", "copilot", "opencode", "zed", "cloud"].map((name) => [
      name,
      false,
    ]),
  ),
  permissions: { deny: [...NATIVE_TOOLS], allow: ["mcp__forge__*"], ask: [] },
  hooks: {
    PreToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: [process.execPath, join(directory, "guard.cjs")]
              .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
              .join(" "),
            timeout: 5,
            fail_closed: true,
          },
        ],
      },
    ],
  },
})

export const args = (directory: string, modelID: string) => [
  "--config",
  join(directory, "config", "devin", "config.json"),
  "--permission-mode",
  "auto",
  "acp",
  ...(modelID === "default" ? [] : ["--model", modelID]),
]

export function prepare(directory: string, system: string) {
  for (const path of ["home", "config/devin", "data/devin", "cache", "state", "sessions", "workspace/.devin"])
    mkdirSync(join(directory, path), { recursive: true })
  const auth = credentialsPath()
  if (auth && existsSync(auth)) symlinkSync(auth, join(directory, "data", "devin", "credentials.toml"))
  writeFileSync(join(directory, "config", "devin", "config.json"), JSON.stringify(settings(directory)), { mode: 0o600 })
  writeFileSync(join(directory, "guard.cjs"), GUARD, { mode: 0o600 })
  writeFileSync(join(directory, "workspace", ".devin", "global_rules.md"), system, { mode: 0o600 })
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
              if (part.type === "tool-result") {
                const value =
                  part.result.type === "content"
                    ? part.result.value.map((item) =>
                        item.type === "file"
                          ? {
                              type: "text",
                              text: `[${item.mime} attachment ${item.name ?? ""} omitted: text-only history]`,
                            }
                          : item,
                      )
                    : part.result.value
                return `[tool result ${part.name}] ${JSON.stringify(value)}`
              }
              throw new Error("Devin CLI currently supports text only")
            })
            .join("\n")}`,
      )
      .join("\n\n") || "Continue."
  if (Buffer.byteLength(text) > PROMPT_LIMIT) throw new Error("Devin CLI prompt exceeds the 4 MiB limit")
  return text
}

export const adapterState = () => ({ kind: undefined as "text" | "reasoning" | undefined, index: 0 })
export function closeContent(state: ReturnType<typeof adapterState>): LLMEvent[] {
  if (!state.kind) return []
  const event =
    state.kind === "text"
      ? LLMEvent.textEnd({ id: `devin-${state.index}` })
      : LLMEvent.reasoningEnd({ id: `devin-${state.index}` })
  state.kind = undefined
  return [event]
}

export function toEvents(state: ReturnType<typeof adapterState>, update: SessionNotification["update"]): LLMEvent[] {
  // MCP callbacks already record and settle host tool calls. ACP tool reports
  // must never execute them again or create duplicate transcript cards.
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return []
  if (update.content.type !== "text") return []
  const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning"
  const events = state.kind === kind ? [] : closeContent(state)
  if (state.kind !== kind) {
    state.kind = kind
    state.index++
    events.push(
      kind === "text"
        ? LLMEvent.textStart({ id: `devin-${state.index}` })
        : LLMEvent.reasoningStart({ id: `devin-${state.index}` }),
    )
  }
  events.push(
    kind === "text"
      ? LLMEvent.textDelta({ id: `devin-${state.index}`, text: update.content.text })
      : LLMEvent.reasoningDelta({ id: `devin-${state.index}`, text: update.content.text }),
  )
  return events
}

export function safeProviderError(cause: unknown): LLMEvent {
  const text = cause instanceof Error ? cause.message : String(cause)
  const message = /auth|credential|login|sign.?in/i.test(text)
    ? "Devin CLI is not signed in. Run `devin auth login` on this backend, then refresh Local Providers."
    : /timeout|timed out/i.test(text)
      ? "Devin CLI timed out. The turn was stopped; resume explicitly before trying again."
      : /limit|exceed/i.test(text)
        ? "Devin CLI exceeded a bridge safety limit. Reduce the context or output and try again."
        : /JSON|protocol|ACP|frame/i.test(text)
          ? "Devin CLI returned an incompatible ACP response. Check the installed CLI build."
          : "Devin CLI stopped before completing the turn. Check its login and model availability."
  return LLMEvent.providerError({ message, retryable: false })
}

async function deadline<T>(promise: Promise<T>, duration: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Devin CLI request timed out")), duration)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
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

type FrameSchemas = Pick<
  typeof import("@agentclientprotocol/sdk/dist/schema/zod.gen.js"),
  "zSessionNotification" | "zRequestPermissionRequest"
>

function validateFrame(line: string, schemas: FrameSchemas, pending: Set<number>) {
  const frame: unknown = JSON.parse(line)
  if (typeof frame !== "object" || frame === null || !("jsonrpc" in frame) || frame.jsonrpc !== "2.0")
    throw new Error("Invalid Devin ACP frame")
  if (!("method" in frame)) {
    if (
      !("id" in frame) ||
      typeof frame.id !== "number" ||
      !pending.has(frame.id) ||
      "result" in frame === "error" in frame
    )
      throw new Error("Invalid Devin ACP response")
    if (
      "error" in frame &&
      (typeof frame.error !== "object" ||
        frame.error === null ||
        !("code" in frame.error) ||
        !Number.isInteger(frame.error.code) ||
        !("message" in frame.error) ||
        typeof frame.error.message !== "string")
    )
      throw new Error("Invalid Devin ACP error response")
    pending.delete(frame.id)
    return line
  }
  // The SDK's default error logger includes incoming payloads. Optional vendor
  // notifications have no authority, so drop them before protocol dispatch.
  if (typeof frame.method === "string" && frame.method.startsWith("_") && !("id" in frame)) return
  if (
    (frame.method === "session/update" && "id" in frame) ||
    (frame.method === "session/request_permission" &&
      (!("id" in frame) ||
        (typeof frame.id !== "string" && (typeof frame.id !== "number" || !Number.isFinite(frame.id)))))
  )
    throw new Error("Invalid Devin ACP message kind")
  const schema =
    frame.method === "session/update"
      ? schemas.zSessionNotification
      : frame.method === "session/request_permission"
        ? schemas.zRequestPermissionRequest
        : undefined
  if (!schema || !("params" in frame) || !schema.safeParse(frame.params).success)
    throw new Error("Invalid or unsupported Devin ACP client request")
  return line
}

export function frames(source: ReadableStream<Uint8Array>, schemas: FrameSchemas, pending: Set<number>) {
  const state = { total: 0, pending: "" }
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const encoder = new TextEncoder()
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        state.total += chunk.byteLength
        if (state.total > OUTPUT_LIMIT) throw new Error("Devin ACP output exceeds safety limit")
        state.pending += decoder.decode(chunk, { stream: true })
        const lines = state.pending.split("\n")
        state.pending = lines.pop() ?? ""
        if (Buffer.byteLength(state.pending) > LINE_LIMIT) throw new Error("Devin ACP frame exceeds safety limit")
        for (const line of lines) {
          if (!line.trim()) continue
          if (Buffer.byteLength(line) > LINE_LIMIT) throw new Error("Devin ACP frame exceeds safety limit")
          const valid = validateFrame(line, schemas, pending)
          if (valid) controller.enqueue(encoder.encode(`${valid}\n`))
        }
      },
      flush() {
        if ((state.pending + decoder.decode()).trim()) throw new Error("Incomplete Devin ACP frame")
      },
    }),
  )
}

const transport = (input: { executable: string; modelID: string }): TransportDef<LLMRequest, LLMRequest, LLMEvent> => ({
  id: ROUTE_ID,
  prepare: (value) => Effect.succeed(value.request),
  frames: (request) =>
    Stream.callback<LLMEvent, LLMError>((queue) =>
      Effect.gen(function* () {
        if (process.platform === "win32")
          return yield* Effect.fail(
            error("Devin CLI transport currently requires macOS or Linux. Use a WSL backend on Windows."),
          )
        const text = yield* Effect.try({
          try: () => prompt(request),
          catch: (cause) => error(cause instanceof Error ? cause.message : "Could not prepare Devin prompt"),
        })
        const system = [
          "You are running inside TurenOS. TurenOS owns the session history, workspace, permissions, and tools.",
          "Use only tools from the forge MCP server. Native tools and subagents are disabled. Your current directory is an empty transport workspace, not the user's project.",
          ...request.system.map((part) => part.text),
        ].join("\n\n")
        if (Buffer.byteLength(system) > PROMPT_LIMIT)
          return yield* Effect.fail(error("Devin CLI system context exceeds the 4 MiB limit"))
        const directory = yield* Effect.acquireRelease(
          Effect.try({
            try: () => mkdtempSync(join(tmpdir(), "turen-devin-")),
            catch: () => error("Could not create Devin transport directory"),
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
          catch: () => error("Could not check Devin CLI version. Install Devin CLI and run `devin auth login`."),
        })
        if (version.stdout.trim() !== SUPPORTED_VERSION)
          return yield* Effect.fail(
            error(
              `Unsupported Devin CLI build. This bridge is qualified for ${SUPPORTED_VERSION}; requalify native-tool isolation before using another build.`,
            ),
          )
        const token = ClaudeCodeMcp.requestToken(request.metadata)
        if (request.tools.length > 0 && !token)
          return yield* Effect.fail(error("Devin CLI requires the host MCP tool bridge"))
        yield* Effect.try({
          try: () => prepare(directory, system),
          catch: () => error("Could not prepare the isolated Devin CLI workspace"),
        })
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const proc = spawn(input.executable, args(directory, input.modelID), {
              env,
              cwd: join(directory, "workspace"),
              stdio: ["pipe", "pipe", "pipe"],
              detached: true,
              windowsHide: true,
            })
            const exit = new Promise<void>((resolve) => proc.once("close", () => resolve()))
            // Diagnostics can contain credentials. Drain without forwarding them.
            proc.stderr.resume()
            proc.on("error", () => undefined)
            return {
              proc,
              exit,
              connection: undefined as ClientSideConnection | undefined,
              sessionID: undefined as string | undefined,
              closed: false,
            }
          }),
          (child) =>
            Effect.promise(async () => {
              child.closed = true
              if (child.sessionID)
                await Promise.race([
                  child.connection?.cancel({ sessionId: child.sessionID }).catch(() => undefined),
                  new Promise<void>((resolve) => setTimeout(resolve, 250)),
                ])
              const signal = (value: NodeJS.Signals) => {
                if (!child.proc.pid) return
                try {
                  process.kill(-child.proc.pid, value)
                } catch {
                  /* Owned process group already exited. */
                }
              }
              signal("SIGTERM")
              await Promise.race([child.exit, new Promise<void>((resolve) => setTimeout(resolve, 500))])
              signal("SIGKILL")
              await Promise.race([child.exit, new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
            }),
        )
        // Revoke host tool access before waiting for the CLI's process teardown.
        const mcp = token
          ? yield* ClaudeCodeMcp.serve(token).pipe(Effect.mapError((cause) => error(cause.message)))
          : undefined
        const state = adapterState()
        Queue.offerUnsafe(queue, LLMEvent.stepStart({ index: 0 }))
        const outcome = yield* Effect.tryPromise({
          try: async (signal) => {
            const { ClientSideConnection, ndJsonStream } = await import("@agentclientprotocol/sdk")
            const { zSessionNotification, zRequestPermissionRequest } = await import(
              "@agentclientprotocol/sdk/dist/schema/zod.gen.js"
            )
            // Stream cleanup can close the process before this promise receives an abort signal.
            const requireActive = () => {
              signal.throwIfAborted()
              if (child.closed) throw new Error("Devin ACP turn stopped")
            }
            requireActive()
            const pending = new Set<number>()
            const sequence = { id: 0 }
            // SDK 0.21.0 assigns numeric IDs from zero. Track requests before dispatch
            // so unsolicited responses cannot reach its raw-payload error logger.
            const call = <T>(request: () => Promise<T>, timeout: number) => {
              requireActive()
              const id = sequence.id++
              pending.add(id)
              return deadline(request(), timeout).finally(() => pending.delete(id))
            }
            const output = frames(
              Readable.toWeb(child.proc.stdout) as ReadableStream<Uint8Array>,
              {
                zSessionNotification,
                zRequestPermissionRequest,
              },
              pending,
            )
            const connection = new ClientSideConnection(
              () => ({
                requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
                sessionUpdate: async (notification) => {
                  if (child.closed || notification.sessionId !== child.sessionID) return
                  toEvents(state, notification.update).forEach((event) => Queue.offerUnsafe(queue, event))
                },
              }),
              ndJsonStream(Writable.toWeb(child.proc.stdin), output),
            )
            child.connection = connection
            const init = await call(
              () =>
                connection.initialize({
                  protocolVersion: 1,
                  clientCapabilities: {},
                  clientInfo: { name: "turenos", version: "1" },
                }),
              START_TIMEOUT,
            )
            requireActive()
            if (init.protocolVersion !== 1 || (mcp && !init.agentCapabilities?.mcpCapabilities?.http))
              throw new Error("Devin ACP capabilities are incompatible")
            const session = await call(
              () =>
                connection.newSession({
                  cwd: join(directory, "workspace"),
                  mcpServers: mcp
                    ? [
                        {
                          type: "http",
                          name: "forge",
                          url: mcp.url,
                          headers: [{ name: "Authorization", value: mcp.authorization }],
                        },
                      ]
                    : [],
                }),
              START_TIMEOUT,
            )
            requireActive()
            child.sessionID = session.sessionId
            return await call(
              () => connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text }] }),
              TURN_TIMEOUT,
            )
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        )
        if (!outcome.ok) Queue.offerUnsafe(queue, safeProviderError(outcome.cause))
        if (outcome.ok) {
          closeContent(state).forEach((event) => Queue.offerUnsafe(queue, event))
          const stopped = outcome.value.stopReason
          if (stopped === "end_turn" || stopped === "max_tokens") {
            const reason = stopped === "end_turn" ? "stop" : "length"
            Queue.offerUnsafe(queue, LLMEvent.stepFinish({ index: 0, reason }))
            Queue.offerUnsafe(queue, LLMEvent.finish({ reason }))
          } else Queue.offerUnsafe(queue, safeProviderError(new Error(`Devin ACP turn stopped: ${stopped}`)))
        }
        child.closed = true
        Queue.endUnsafe(queue)
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Queue.failCause(queue, cause),
        ),
      ),
    ),
})

export const isDevin = (model: ModelV2.Info) =>
  model.providerID === DevinCLI.ID && model.api.type === "native" && model.api.url === DevinCLI.API_URL

export const routeModel = (input: {
  providerID: string
  modelID: string
  executable: string
  defaults: RouteDefaultsInput
}) =>
  Route.make({
    id: ROUTE_ID,
    provider: input.providerID,
    protocol,
    endpoint: Endpoint.path("", { baseURL: "https://devin-cli.invalid" }),
    transport: transport(input),
    defaults: input.defaults,
  }).model({ id: input.modelID, compatibility: { mediaInput: false } })

export const model = (input: { model: ModelV2.Info; defaults: RouteDefaultsInput }) => {
  const configured = input.model.request.body[DevinCLI.EXECUTABLE_KEY]
  return routeModel({
    providerID: input.model.providerID,
    modelID: input.model.api.id,
    executable:
      DevinCLI.resolveExecutable(configured) ??
      (typeof configured === "string" ? configured : DevinCLI.DEFAULT_EXECUTABLE),
    defaults: input.defaults,
  })
}
