import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Model } from "../src/model"
import { SessionMessage } from "../src/session-message"

const tool: SessionMessage.AssistantTool = {
  type: "tool",
  id: "prt_tool",
  name: "read",
  state: {
    status: "completed",
    input: { path: "/tmp/a" },
    content: [{ type: "text", text: "body" }],
    structured: {},
  },
  time: { created: DateTime.makeUnsafe(1) },
}

describe("SessionMessage assistant tool truncation marker", () => {
  const encode = Schema.encodeSync(SessionMessage.Assistant)

  const assistant = (content: SessionMessage.AssistantContent[]) =>
    SessionMessage.Assistant.make({
      type: "assistant",
      id: SessionMessage.ID.make("msg_tool_marker"),
      agent: "build",
      model: { providerID: "provider" as Model.Ref["providerID"], id: "model" as Model.Ref["id"] },
      content,
      time: { created: DateTime.makeUnsafe(1) },
    })

  test("omits the marker when the row is returned in full", () => {
    expect(encode(assistant([tool])).content[0]).not.toHaveProperty("truncated")
  })

  test("round trips the marker a lean page row carries", () => {
    const encoded = encode(assistant([{ ...tool, truncated: { bytes: 70_000 } }]))
    expect(encoded.content[0]).toMatchObject({ truncated: { bytes: 70_000 } })
    expect(Schema.decodeUnknownSync(SessionMessage.Assistant)(encoded)).toEqual(
      assistant([{ ...tool, truncated: { bytes: 70_000 } }]),
    )
  })
})
