import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest"
import { SessionID } from "../src/session-id"

test("execution settlement is a current live event, never a replayable completion", () => {
  const definition = EventManifest.ServerDefinitions.find((event) => event.type === "session.execution.settled")
  expect(definition).toBeDefined()
  if (!definition) return
  const data = { sessionID: SessionID.make("ses_settled"), outcome: "success" as const }
  expect(Schema.decodeUnknownSync(definition.data)(data)).toEqual(data)
  expect(Schema.is(definition.data)({ ...data, outcome: "interrupted" })).toBe(false)
  expect(definition.durable).toBeUndefined()
  expect(EventManifest.Durable.has("session.execution.settled.1")).toBe(false)
})
