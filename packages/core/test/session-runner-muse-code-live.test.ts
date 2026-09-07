import { expect, test } from "bun:test"
import { LLM, LLMEvent, LLMRequest, ToolDefinition } from "@turenlabs/llm"
import { LLMClient, RequestExecutor } from "@turenlabs/llm/route"
import { Effect, Layer, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { MuseCodeBridge } from "../src/session/runner/muse-code-bridge"
import { ClaudeCodeMcp } from "../src/session/runner/claude-code-mcp-namespace"

const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))

test.skipIf(process.env.FORGE_LIVE_MUSE !== "1")(
  "signed-in Muse calls the host MCP tool and returns its result",
  async () => {
    const marker = `MUSE_HOST_${randomUUID()}`
    const calls: string[] = []
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Core's preload deliberately replaces XDG_CONFIG_HOME. Opt-in live tests
          // restore only Muse's real credential location for the duration of the call.
          const config = process.env.XDG_CONFIG_HOME
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              process.env.XDG_CONFIG_HOME = process.env.FORGE_LIVE_MUSE_CONFIG_HOME ?? join(homedir(), ".config")
            }),
            () =>
              Effect.sync(() => {
                if (config === undefined) delete process.env.XDG_CONFIG_HOME
                else process.env.XDG_CONFIG_HOME = config
              }),
          )
          const token = yield* ClaudeCodeMcp.register({
            definitions: [
              new ToolDefinition({
                name: "bridge_probe",
                description: "Return the secret verification marker. Call this to obtain the marker; do not guess it.",
                inputSchema: { type: "object", properties: {} },
              }),
            ],
            execute: (call) =>
              Effect.sync(() => {
                calls.push(call.name)
                return { type: "content" as const, value: [{ type: "text" as const, text: marker }] }
              }),
          })
          const model = MuseCodeBridge.routeModel({
            providerID: "muse-code",
            modelID: "muse-spark-1.3",
            executable: "muse",
            effort: "low",
            defaults: {},
          })
          const request = LLMRequest.update(
            LLM.request({
              model,
              system: "Use the provided tool to retrieve the verification marker.",
              messages: [
                {
                  role: "user",
                  content: "Call bridge_probe once, then reply with only its exact verification marker.",
                },
              ],
            }),
            { metadata: ClaudeCodeMcp.requestMetadata(token) },
          )
          return yield* LLM.stream(request).pipe(Stream.runCollect)
        }),
      ).pipe(Effect.provide(layer), Effect.timeout("90 seconds")),
    )
    expect(events.filter(LLMEvent.is.providerError)).toEqual([])
    expect(calls).toEqual(["bridge_probe"])
    expect(
      events
        .filter(LLMEvent.is.textDelta)
        .map((event) => event.text)
        .join(""),
    ).toContain(marker)
    expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
    expect(events.find(LLMEvent.is.finish)?.usage).toBeUndefined()
  },
  100_000,
)
