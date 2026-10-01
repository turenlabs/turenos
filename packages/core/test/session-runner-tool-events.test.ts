import { expect, test } from "bun:test"
import { Effect, Exit, Schema, Stream } from "effect"
import { LLMEvent } from "@turenlabs/llm"
import { EventV2 } from "@turenlabs/core/event"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionV2 } from "@turenlabs/core/session"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { createLLMEventPublisher } from "@turenlabs/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const capture = (
  disclosure: Effect.Effect<SecretOutput.Snapshot, SecretOutput.Error> = Effect.succeed(SecretRedaction),
) => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.durable
            ? EventV2.versionedType(definition.type, definition.durable.version)
            : definition.type,
          data,
        })
        return event
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
  return {
    published,
    publisher: createLLMEventPublisher(
      events,
      {
        sessionID,
        agent: "build",
        model: {
          id: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
        },
      },
      disclosure,
    ),
  }
}

const unavailable = Effect.fail(new SecretOutput.Error({ message: "Secret output protection unavailable" }))
const nested = (depth: number, leaf: unknown): Record<string, unknown> => ({
  child: depth <= 1 ? leaf : nested(depth - 1, leaf),
})

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" },
    ],
  })
})

test("unsettled callback failures redact secrets before becoming replayable tool output", async () => {
  const { published, publisher } = capture()
  const secret = `ghp_${"a".repeat(36)}`
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.failUnsettledTools(secret))
  const failure = published.find((event) => event.type === "session.next.tool.failed.1")
  expect(JSON.stringify(failure)).not.toContain(secret)
  expect(JSON.stringify(failure)).toContain("[SECRET:v1:")
})

test("hosted tool output and compatibility JSON are sanitized before persistence", async () => {
  const { published, publisher } = capture()
  const secret = `ghp_${"a".repeat(36)}`
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        ...result,
        providerExecuted: true,
        result: { type: "json", value: { token: secret } },
        output: { structured: { token: secret }, content: [{ type: "text", text: secret }] },
        providerMetadata: { opaque: { signature: secret } },
      }),
    ),
  )
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toMatchObject({ provider: { metadata: { opaque: { signature: secret } } } })
  const data = success?.data as Record<string, unknown>
  expect(JSON.stringify({ structured: data.structured, content: data.content, result: data.result })).not.toContain(
    secret,
  )
  expect(JSON.stringify(data.structured)).toContain("[SECRET:v1:")
})

test("unavailable protection settles a hosted result once with a fixed failure instead of orphaning it", async () => {
  const { published, publisher } = capture(unavailable)
  const secret = `ghp_${"b".repeat(36)}`
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  const exit = await Effect.runPromiseExit(
    publisher.publish(
      LLMEvent.toolResult({
        ...result,
        providerExecuted: true,
        result: { type: "json", value: { token: secret } },
        output: { structured: { token: secret }, content: [{ type: "text", text: secret }] },
      }),
    ),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(publisher.unsettledToolNames()).toEqual([])
  const failures = published.filter((event) => event.type === "session.next.tool.failed.1")
  expect(failures).toHaveLength(1)
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(JSON.stringify(published)).not.toContain(secret)
  expect(JSON.stringify(failures[0])).toContain("withheld")
})

test("an unprocessable hosted result is withheld and settled rather than left running", async () => {
  const { published, publisher } = capture()
  const secret = `ghp_${"c".repeat(36)}`
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  const exit = await Effect.runPromiseExit(
    publisher.publish(
      LLMEvent.toolResult({
        ...result,
        providerExecuted: true,
        result: { type: "json", value: nested(70, secret) },
        output: undefined,
      }),
    ),
  )
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(publisher.unsettledToolNames()).toEqual([])
  expect(published.filter((event) => event.type === "session.next.tool.failed.1")).toHaveLength(1)
  expect(JSON.stringify(published)).not.toContain(secret)
})

test("cleanup settles every open call with a fixed message when protection is unavailable", async () => {
  const { published, publisher } = capture(unavailable)
  const secret = `ghp_${"d".repeat(36)}`
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ id: "call-other", name: "bash", input: {} })))
  const exit = await Effect.runPromiseExit(publisher.failUnsettledTools(`Tool execution failed: ${secret}`))
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(publisher.unsettledToolNames()).toEqual([])
  expect(published.filter((event) => event.type === "session.next.tool.failed.1")).toHaveLength(2)
  expect(JSON.stringify(published)).not.toContain(secret)
})

test("provider tool errors and step failures never persist raw text when protection is unavailable", async () => {
  const { published, publisher } = capture(unavailable)
  const secret = `ghp_${"e".repeat(36)}`
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  const errored = await Effect.runPromiseExit(
    publisher.publish(LLMEvent.toolError({ id: call.id, name: call.name, message: `upstream said ${secret}` })),
  )
  expect(Exit.isSuccess(errored)).toBe(true)
  const failed = await Effect.runPromiseExit(publisher.failAssistant(`Provider stream failed: ${secret}`))
  expect(Exit.isSuccess(failed)).toBe(true)
  expect(publisher.unsettledToolNames()).toEqual([])
  expect(published.some((event) => event.type.startsWith("session.next.step.failed"))).toBe(true)
  expect(JSON.stringify(published)).not.toContain(secret)
})

test("provider failure text is redacted before it becomes a durable step failure", async () => {
  const { published, publisher } = capture()
  const secret = `ghp_${"f".repeat(36)}`
  await Effect.runPromise(publisher.publish(LLMEvent.providerError({ message: `rejected request body: ${secret}` })))
  expect(JSON.stringify(published)).not.toContain(secret)
  expect(JSON.stringify(published)).toContain("[SECRET:v1:github:")
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("provider-executed tool output is bounded before durable storage", async () => {
  const { published, publisher } = capture()
  const huge = "x".repeat(3 * 1024 * 1024)
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        ...result,
        providerExecuted: true,
        result: { type: "content", value: [{ type: "text", text: huge }] },
        output: {
          structured: {},
          content: [{ type: "text", text: huge }],
        },
      }),
    ),
  )
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  const serialized = JSON.stringify(success)
  expect(serialized.length).toBeLessThan(1_200_000)
  expect(serialized).toContain("tool output truncated before durable storage")
})

test("provider wrapper output does not persist its raw content field", async () => {
  const { published, publisher } = capture()
  const huge = "x".repeat(3 * 1024 * 1024)
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        ...result,
        providerExecuted: true,
        result: {
          type: "json",
          value: {
            output: "bounded output",
            metadata: {},
            content: [{ type: "text", text: huge }],
          },
        },
        output: undefined,
      }),
    ),
  )
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  const serialized = JSON.stringify(success)
  expect(serialized.length).toBeLessThan(200_000)
  expect(serialized).toContain("bounded output")
  expect(serialized).not.toContain(huge)
})

test("failed provider results are bounded before durable storage", async () => {
  const { published, publisher } = capture()
  const huge = "x".repeat(3 * 1024 * 1024)
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        ...result,
        providerExecuted: true,
        result: { type: "error", value: huge },
        output: undefined,
      }),
    ),
  )
  const failure = published.find((event) => event.type === "session.next.tool.failed.1")
  const serialized = JSON.stringify(failure)
  expect(serialized.length).toBeLessThan(1_200_000)
  expect(serialized).not.toContain(huge)
})

test("streamed tool input is bounded before durable storage", async () => {
  const { published, publisher } = capture()
  const huge = "x".repeat(3 * 1024 * 1024)
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call-input", name: "read" })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputDelta({ id: "call-input", name: "read", text: huge })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputEnd({ id: "call-input", name: "read" })))
  const ended = published.find((event) => event.type === "session.next.tool.input.ended.1")
  const serialized = JSON.stringify(ended)
  expect(serialized.length).toBeLessThan(600_000)
  expect(serialized).not.toContain(huge)
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }],
    result: { type: "content", value: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})

test("step finish records settlement without publishing step ended", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  expect(published.some((event) => event.type === "session.next.step.ended.2")).toBe(false)
  expect(publisher.stepSettlement()).toMatchObject({ finish: "stop" })
})
