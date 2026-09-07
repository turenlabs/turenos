import { ClaudeCodeBridge } from "@turenlabs/core/session/runner/claude-code-bridge"
import { ClaudeCodeMcp } from "@turenlabs/core/session/runner/claude-code-mcp-namespace"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { MuseCodeCLI } from "@turenlabs/core/provider/muse-code"
import { MuseCodeBridge } from "@turenlabs/core/session/runner/muse-code-bridge"
import { LLMEvent, LLMRequest, ToolRuntime, toDefinitions } from "@turenlabs/llm"
import type { LLMClientShape } from "@turenlabs/llm/route"
import { Cause, Effect, Queue, Stream } from "effect"
import type { Provider } from "@/provider/provider"
import { LLMNativeRuntime } from "./native-runtime"
import { LLMNative } from "./native-request"
import type { LLMRequestPrep } from "./request"

type StreamInput = {
  readonly model: Provider.Model
  readonly prepared: LLMRequestPrep.Prepared
  readonly llmClient: LLMClientShape
  readonly directory: string
  readonly executable: string
  readonly effort?: ClaudeCodeCLI.EffortLevel | MuseCodeCLI.EffortLevel
  readonly toolChoice?: "auto" | "required" | "none"
  readonly abort: AbortSignal
}

export function stream(input: StreamInput) {
  return Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<LLMEvent, Cause.Done>()
        const tools =
          input.toolChoice === "none"
            ? {}
            : LLMNativeRuntime.nativeTools(input.prepared.tools, {
                messages: input.prepared.messages,
                abort: input.abort,
              })
        const definitions = toDefinitions(tools)
        const token =
          definitions.length === 0
            ? undefined
            : yield* ClaudeCodeMcp.register({
                definitions,
                execute: Effect.fnUntraced(function* (call) {
                  const text = JSON.stringify(call.input) ?? "{}"
                  const toolCall = LLMEvent.toolCall({
                    id: call.id,
                    name: call.name,
                    input: call.input,
                    providerExecuted: false,
                  })
                  yield* Queue.offerAll(events, [
                    LLMEvent.toolInputStart({ id: call.id, name: call.name }),
                    LLMEvent.toolInputDelta({ id: call.id, name: call.name, text }),
                    LLMEvent.toolInputEnd({ id: call.id, name: call.name }),
                    toolCall,
                  ])
                  const dispatched = yield* ToolRuntime.dispatch(tools, toolCall)
                  yield* Queue.offerAll(events, dispatched.events)
                  return dispatched.result
                }),
              })
        const model =
          input.model.providerID === MuseCodeCLI.ID
            ? MuseCodeBridge.routeModel({
                providerID: input.model.providerID,
                modelID: input.model.api.id,
                executable: input.executable,
                effort: MuseCodeCLI.isEffortLevel(input.effort) ? input.effort : undefined,
                defaults: {},
              })
            : ClaudeCodeBridge.routeModel({
                providerID: input.model.providerID,
                modelID: input.model.api.id,
                executable: input.executable,
                directory: input.directory,
                effort: ClaudeCodeCLI.isEffortLevel(input.effort) ? input.effort : undefined,
                defaults: {},
              })
        const request = LLMRequest.update(
          LLMNative.request({
            model: input.model,
            resolvedModel: model,
            messages: input.prepared.messages,
            tools: input.prepared.tools,
            toolChoice: input.toolChoice,
            temperature: input.prepared.params.temperature,
            topP: input.prepared.params.topP,
            topK: input.prepared.params.topK,
            maxOutputTokens: input.prepared.params.maxOutputTokens,
            providerOptions: input.prepared.params.options,
            headers: input.prepared.headers,
          }),
          { metadata: token ? ClaudeCodeMcp.requestMetadata(token) : undefined },
        )
        const provider = input.llmClient.stream(request).pipe(Stream.ensuring(Queue.end(events)))
        return provider.pipe(Stream.merge(Stream.fromQueue(events)))
      }),
    ),
  )
}

export * as LLMClaudeCodeDirect from "./claude-code-direct"
