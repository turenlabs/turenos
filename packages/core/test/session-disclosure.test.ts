import { expect, test } from "bun:test"
import { LLM, Message, Model } from "@turenlabs/llm"
import { OpenAIChat } from "@turenlabs/llm/protocols"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { SessionDisclosure } from "@turenlabs/core/session/disclosure"

const secret = `ghp_${"a".repeat(36)}`

test("tool result guard leaves binary payloads opaque and fails closed on invalid JSON", () => {
  const file = { type: "file" as const, uri: `data:image/png;base64,${secret}`, mime: "image/png" }
  expect(SessionDisclosure.result({ type: "content", value: [{ type: "text", text: secret }, file] })).toEqual({
    type: "content",
    value: [{ type: "text", text: SecretRedaction.text(secret) }, file],
  })
  const cycle: Record<string, unknown> = { token: secret }
  cycle.self = cycle
  expect(() => SessionDisclosure.result({ type: "json", value: cycle })).toThrow("Secret redaction failed")
})

test("request guard uses supplied known-value snapshot without touching transport credentials", () => {
  const known = "synthetic-private-provider-value"
  const request = LLM.request({
    model: Model.make({ id: "test", provider: "openai", route: OpenAIChat.route }),
    messages: [Message.user(known)],
    http: { headers: { Authorization: known } },
  })
  const safe = SessionDisclosure.request(request, {
    text: (value) => value.replaceAll(known, "[known]"),
    json: (value) => value,
  })
  expect(safe.messages[0].content).toEqual([{ type: "text", text: "[known]" }])
  expect(safe.http).toBe(request.http)
})

test("an unprocessable historical part is withheld alone instead of failing every later request", () => {
  const nest = (depth: number): Record<string, unknown> =>
    depth === 0 ? { token: secret } : { child: nest(depth - 1) }
  const deep = nest(70)
  const colliding = { [secret]: "first", [SecretRedaction.text(secret)]: "second" }
  const request = LLM.request({
    model: Model.make({ id: "test", provider: "openai", route: OpenAIChat.route }),
    messages: [
      Message.user(`first ${secret}`),
      Message.tool({ id: "deep", name: "read", result: deep }),
      Message.tool({ id: "colliding", name: "read", result: colliding }),
      Message.user("x".repeat(SecretRedaction.MAX_BYTES + 1)),
      Message.tool({ id: "ok", name: "read", result: { token: secret } }),
    ],
  })
  const safe = SessionDisclosure.request(request)
  const serialized = JSON.stringify(safe.messages)
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain("x".repeat(1024))
  expect(JSON.stringify(safe.messages[0])).toContain("[SECRET:v1:github:")
  expect(JSON.stringify(safe.messages[4])).toContain("[SECRET:v1:github:")
  for (const index of [1, 2, 3]) expect(JSON.stringify(safe.messages[index])).toContain(SessionDisclosure.WITHHELD)
  expect(safe.messages.map((message) => message.role)).toEqual(request.messages.map((message) => message.role))
})

test("request guard sanitizes conversational text and historical results, not opaque fields", () => {
  const metadata = { opaque: { signature: secret } }
  const reasoning = { type: "reasoning" as const, text: secret, encrypted: secret, providerMetadata: metadata }
  const media = { type: "media" as const, mediaType: "image/png", data: secret }
  const request = LLM.request({
    model: Model.make({ id: "test", provider: "openai", route: OpenAIChat.route }),
    system: secret,
    messages: [
      Message.user(secret),
      Message.assistant([reasoning, media]),
      Message.tool({ id: "one", name: "read", result: { token: secret }, providerMetadata: metadata }),
    ],
    http: { headers: { Authorization: secret } },
  })
  const safe = SessionDisclosure.request(request)
  expect(JSON.stringify(safe.system)).not.toContain(secret)
  expect(JSON.stringify(safe.messages[0])).not.toContain(secret)
  expect(JSON.stringify(safe.messages[2].content[0])).toContain("[SECRET:v1:")
  expect(safe.messages[1].content[0]).toEqual(reasoning)
  expect(safe.messages[1].content[1]).toEqual(media)
  expect(safe.http).toBe(request.http)
  expect(request.messages[0].content[0]).toEqual({ type: "text", text: secret })
})
