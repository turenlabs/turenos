import { expect, test } from "bun:test"
import { ClientSideConnection, ndJsonStream, type SessionNotification } from "@agentclientprotocol/sdk"
import { LLM } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { Effect, Layer, Stream } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { DevinCLI } from "../src/provider/devin-cli"
import { DevinACP } from "../src/session/runner/devin-acp"
import { ClaudeCodeMcp } from "../src/session/runner/claude-code-mcp-namespace"

const executable = DevinCLI.resolveExecutable(undefined)
const enabled = process.env.FORGE_TEST_DEVIN === "1" && process.platform !== "win32" && executable !== undefined

async function withCredentials<A>(run: () => Promise<A>) {
  // Core's preload replaces XDG paths. Only opt-in live tests restore Devin's
  // credential location; product code keeps the backend's configured location.
  const original = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = process.env.FORGE_LIVE_DEVIN_DATA_HOME ?? join(homedir(), ".local", "share")
  try {
    return await run()
  } finally {
    if (original === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = original
  }
}

async function session(
  run: (input: {
    connection: ClientSideConnection
    sessionID: string
    updates: SessionNotification[]
    directory: string
  }) => Promise<void>,
  brokenGuard = false,
  nativeRead = false,
) {
  return withCredentials(async () => {
    const directory = mkdtempSync(join(tmpdir(), "devin-qualification-"))
    DevinACP.prepare(directory, "This is a bounded compatibility test. Follow the test prompt only.")
    const settings = { ...DevinACP.settings(directory), disabled_tools: [...DevinACP.NATIVE_TOOLS] }
    if (nativeRead) {
      settings.disabled_tools = settings.disabled_tools.filter((name) => name !== "read")
      settings.permissions.deny = settings.permissions.deny.filter((name) => name !== "read")
      settings.permissions.allow.push("read")
    }
    if (brokenGuard) settings.hooks.PreToolUse[0]!.hooks[0]!.command = "exit 1"
    writeFileSync(join(directory, "config", "devin", "config.json"), JSON.stringify(settings))
    const child = spawn(executable!, DevinACP.args(directory, "default"), {
      cwd: join(directory, "workspace"),
      env: DevinACP.environment(directory),
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    })
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, "SIGKILL")
    }, 60_000)
    const updates: SessionNotification[] = []
    const { zSessionNotification, zRequestPermissionRequest } = await import(
      "@agentclientprotocol/sdk/dist/schema/zod.gen.js"
    )
    const connection = new ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async (update) => {
          updates.push(update)
        },
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        DevinACP.frames(
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          {
            zSessionNotification,
            zRequestPermissionRequest,
          },
          new Set([0, 1, 2]),
        ),
      ),
    )
    try {
      const init = await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "turenos-qualification", version: "1" },
      })
      expect(init.protocolVersion).toBe(1)
      const created = await connection.newSession({ cwd: join(directory, "workspace"), mcpServers: [] })
      await run({ connection, sessionID: created.sessionId, updates, directory })
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          /* Owned process group already exited. */
        }
      }
      clearTimeout(timer)
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test.skipIf(!enabled)(
  "real Devin accepts the isolated settings and existing login without inference",
  async () => {
    expect(execFileSync(executable!, ["--version"], { encoding: "utf8" }).trim()).toBe(DevinACP.SUPPORTED_VERSION)
    await session(async ({ sessionID, directory }) => {
      expect(sessionID.length).toBeGreaterThan(0)
      const status = execFileSync(
        executable!,
        ["--config", join(directory, "config", "devin", "config.json"), "auth", "status"],
        { env: DevinACP.environment(directory), encoding: "utf8" },
      )
      expect(status).toContain("Logged in")
    })
  },
  70_000,
)

test.skipIf(!enabled || process.env.FORGE_TEST_DEVIN_LIVE !== "1")(
  "real Devin blocks native reads with working and failed guards",
  async () => {
    for (const broken of [false, true])
      await session(
        async ({ connection, sessionID, updates, directory }) => {
          const token = `NATIVE_CANARY_${crypto.randomUUID()}`
          const canary = join(directory, "canary.txt")
          writeFileSync(canary, token)
          const result = await connection.prompt({
            sessionId: sessionID,
            prompt: [
              {
                type: "text",
                text: `Compatibility test. Use the native read tool exactly once to read ${canary}. Do not use another tool or guess its contents. If a hook blocks the read, report the block and stop.`,
              },
            ],
          })
          expect(result.stopReason).toBe("end_turn")
          expect(JSON.stringify(updates)).toContain(canary)
          expect(JSON.stringify(updates)).not.toContain(token)
          expect(
            updates.some(
              (entry) => entry.update.sessionUpdate === "tool_call_update" && entry.update.status === "failed",
            ),
          ).toBe(true)
          expect(readFileSync(canary, "utf8")).toBe(token)
        },
        broken,
        true,
      )
  },
  150_000,
)

test.skipIf(!enabled || process.env.FORGE_TEST_DEVIN_LIVE !== "1")(
  "real Devin reaches only the private host MCP bridge",
  async () => {
    const calls: string[] = []
    const events = await withCredentials(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const token = yield* ClaudeCodeMcp.register({
            definitions: [
              {
                name: "bridge_probe",
                description: "Return the compatibility marker",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            execute: (call) =>
              Effect.sync(() => {
                calls.push(call.name)
                return { type: "text" as const, value: "DEVIN_HOST_MCP_OK" }
              }),
          })
          const model = DevinACP.routeModel({
            providerID: "devin-cli",
            modelID: "default",
            executable: executable!,
            defaults: {},
          })
          return Array.from(
            yield* LLM.stream(
              LLM.request({
                model,
                system: "Compatibility test. Use only TurenOS tools.",
                prompt:
                  "Call bridge_probe exactly once. Reply with its exact result and stop. Do not call any other tool.",
                metadata: ClaudeCodeMcp.requestMetadata(token),
              }),
            ).pipe(Stream.runCollect),
          )
        }).pipe(
          Effect.scoped,
          Effect.timeout("60 seconds"),
          Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
        ),
      ),
    )
    expect(calls).toEqual(["bridge_probe"])
    expect(events.some((event) => event.type === "provider-error")).toBe(false)
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toContain("DEVIN_HOST_MCP_OK")
    expect(events.at(-1)?.type).toBe("finish")
  },
  70_000,
)
