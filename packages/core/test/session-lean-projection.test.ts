import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionLeanMessage } from "../src/session/lean-message"
import { SessionLeanProjection } from "../src/session/lean-projection"
import { SessionMessage } from "../src/session/message"

const load = Effect.runPromise(SessionLeanProjection.load)
const decode = Schema.decodeUnknownSync(SessionMessage.Message)
const text = 'diff --git "révision 🦀"\\\n'.repeat(3_000)
const part = {
  id: "part_tool",
  type: "tool",
  name: "bash",
  time: { created: 1, ran: 2, completed: 3 },
  state: {
    status: "completed",
    input: { command: "git diff" },
    content: [{ type: "text", text }],
    result: { type: "text", value: text },
    structured: { exit: 0 },
  },
}
const message = {
  id: "msg_fixture",
  type: "assistant",
  agent: "build",
  model: { providerID: "fixture", id: "local" },
  time: { created: 1, completed: 3 },
  content: [part],
}

test("the packaged kernel matches full decoding and lean trimming across mixed tool parts", async () => {
  const project = await load
  if (!project) throw new Error("Expected the bundled transcript projection kernel")
  const input = {
    ...message,
    content: [
      { id: "part_note", type: "text", text: "Inspect the change" },
      { ...part, id: "part_completed" },
      {
        ...part,
        id: "part_failed",
        state: {
          ...part.state,
          status: "error",
          result: { type: "text", value: `${text}\tfixture error` },
          structured: { output: text },
          error: { type: "unknown", message: "fixture error" },
        },
      },
      { ...part, id: "part_running", state: { ...part.state, status: "running" } },
    ],
  }
  const raw = Buffer.from(JSON.stringify(input))
  const projected = SessionLeanProjection.decode(raw, project)
  expect([...(projected.elided?.keys() ?? [])]).toEqual([1, 2])
  const trimmed = SessionLeanMessage.trim(decode(projected.data), projected.elided)
  expect(trimmed).toEqual(SessionLeanMessage.trim(decode(input)))
  if (trimmed.type !== "assistant" || trimmed.content[1]?.type !== "tool") throw new Error("Expected tool part")
  expect(trimmed.content[1].truncated?.bytes).toBe(
    [part.state.content, part.state.structured, part.state.result].reduce(
      (bytes, field) => bytes + Buffer.byteLength(JSON.stringify(field)),
      0,
    ),
  )
})

test("unsupported escapes, result shapes and oversized rows keep their original decoding", async () => {
  const project = await load
  if (!project) throw new Error("Expected the bundled transcript projection kernel")
  for (const result of [
    { type: "text", value: `${text}\uD800` },
    { type: "text", value: `${text}\u0001` },
    { type: "text", value: text, extra: true },
    { type: "text", value: "x".repeat(SessionLeanProjection.maxBytes) },
  ]) {
    const input = { ...message, content: [{ ...part, state: { ...part.state, result } }] }
    const projected = SessionLeanProjection.decode(Buffer.from(JSON.stringify(input)), project)
    expect(projected.elided).toBeUndefined()
    expect(projected.data).toEqual(input)
  }
})

test("the kernel still validates the message shape through the normal decoder", async () => {
  const project = await load
  if (!project) throw new Error("Expected the bundled transcript projection kernel")
  const input = { ...message, content: [{ ...part, state: { ...part.state, structured: null } }] }
  const projected = SessionLeanProjection.decode(Buffer.from(JSON.stringify(input)), project)
  expect(projected.elided?.size).toBe(1)
  expect(() => decode(projected.data)).toThrow()
})
