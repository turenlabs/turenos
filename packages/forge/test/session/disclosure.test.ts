import { expect, test } from "bun:test"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { LLMDisclosure } from "../../src/session/disclosure"
import type { ModelMessage } from "ai"
import type { JSONValue } from "@ai-sdk/provider"

const secret = `ghp_${"a".repeat(36)}`

test("workflow errors cannot leak through hostile error accessors", async () => {
  const error = Object.defineProperty(new Error(), "name", {
    get() {
      throw new Error(secret)
    },
  })
  expect(
    await LLMDisclosure.workflow(async () => {
      throw error
    }, new AbortController().signal),
  ).toEqual({ result: "", error: "Tool execution failed" })
})

test("workflow callback sanitizes output and rejects exception details while preserving abort", async () => {
  const abort = new AbortController()
  const safe = await LLMDisclosure.workflow(
    async () => ({ output: secret, metadata: { token: secret }, title: secret }),
    abort.signal,
  )
  expect(JSON.stringify(safe)).not.toContain(secret)
  expect(JSON.stringify(safe)).toContain("[SECRET:v1:")
  const failure = await LLMDisclosure.workflow(async () => {
    throw new Error(secret)
  }, abort.signal)
  expect(failure.result).toBe("")
  expect(failure.error).toMatch(/^\[SECRET:v1:github:[a-f0-9]{32}\]$/)
  // A thrown non-Error carries no readable own message and stays generic.
  expect(
    await LLMDisclosure.workflow(async () => {
      throw { toString: () => secret }
    }, abort.signal),
  ).toEqual({ result: "", error: "Tool execution failed" })
  await expect(
    LLMDisclosure.workflow(async () => {
      throw new DOMException(secret, "AbortError")
    }, abort.signal),
  ).rejects.toThrow("Tool execution interrupted")
  abort.abort()
  await expect(
    LLMDisclosure.workflow(async () => {
      throw new Error(secret)
    }, abort.signal),
  ).rejects.toThrow("Tool execution interrupted")
})

test("workflow callbacks return a redacted diagnostic rather than a generic failure", async () => {
  const safe = await LLMDisclosure.workflow(async () => {
    throw new Error(`File not found: /tmp/${secret}`)
  }, new AbortController().signal)
  expect(safe.result).toBe("")
  expect(safe.error).toContain("File not found")
  expect(safe.error).not.toContain(secret)
  expect(safe.error).toContain("[SECRET:v1:github:")
})

test("workflow callbacks refuse to execute without protection and report it as a tool error", async () => {
  let executed = false
  const safe = await LLMDisclosure.workflow(
    async () => {
      executed = true
      return secret
    },
    new AbortController().signal,
    Promise.reject(new Error(`vault read failed near ${secret}`)),
  )
  expect(executed).toBe(false)
  expect(safe).toEqual({ result: "", error: LLMDisclosure.UNAVAILABLE })
})

test("an unprocessable historical tool result is withheld alone instead of failing the request", () => {
  const nest = (depth: number): JSONValue => (depth === 0 ? { token: secret } : { child: nest(depth - 1) })
  const deep = nest(70)
  const input: ModelMessage[] = [
    { role: "user", content: secret },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "deep",
          toolName: "read",
          output: { type: "json", value: deep },
        },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "ok", toolName: "read", output: { type: "text", value: secret } }],
    },
  ]
  const safe = LLMDisclosure.messages(input)
  expect(JSON.stringify(safe)).not.toContain(secret)
  expect(JSON.stringify(safe[1])).toContain("withheld")
  expect(JSON.stringify(safe[2])).toContain("[SECRET:v1:github:")
})

test("prepared messages redact old tool JSON but preserve provider options and files", () => {
  const opaque = { provider: { signature: secret } }
  const input: ModelMessage[] = [
    { role: "user", content: secret },
    { role: "assistant", content: [{ type: "reasoning", text: secret, providerOptions: opaque }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "read",
          output: { type: "json", value: { token: secret } },
          providerOptions: opaque,
        },
      ],
    },
    { role: "user", content: [{ type: "file", data: secret, mediaType: "image/png" }] },
  ]
  const safe = LLMDisclosure.messages(input)
  expect(safe[0].content).not.toContain(secret)
  expect(JSON.stringify(safe[2])).toContain("[SECRET:v1:")
  expect(safe[1]).toEqual(input[1])
  expect(safe[3]).toEqual(input[3])
  expect(input[0].content).toBe(secret)
})

test("workflow executors acquire protection per callback and capture no operation snapshot", async () => {
  // The executor outlives the request on a cached language model, so it may hold only a way to
  // acquire protection -- never a compiled snapshot of configured values.
  const rotated = "synthetic-rotated-value-77"
  const acquired: string[][] = []
  const execute = LLMDisclosure.executor({
    tools: {
      echo: {
        execute: async (args: unknown) => ({
          output: typeof args === "object" && args !== null && "value" in args ? String(args.value) : "",
        }),
      },
    },
    messages: [],
    abort: new AbortController().signal,
    protection: () => {
      const values = acquired.length === 0 ? [] : [rotated]
      acquired.push(values)
      return Promise.resolve(SecretRedaction.compile(values))
    },
  })
  expect((await execute("echo", JSON.stringify({ value: rotated }), "first")).result).toBe(rotated)
  expect((await execute("echo", JSON.stringify({ value: rotated }), "second")).result).toMatch(
    /^\[SECRET:v1:known:[a-f0-9]{32}\]$/,
  )
  const unknown = await execute(`missing:${secret}`, "{}", "third")
  expect(unknown.error).toContain("Unknown tool")
  expect(unknown.error).not.toContain(secret)
  expect(acquired).toHaveLength(3)
  expect(await execute("echo", "{", "malformed")).toMatchObject({ result: "" })
})
