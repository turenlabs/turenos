import { describe, expect, test } from "bun:test"
import { DateTime, Option, Schema } from "effect"
import { Prompt, TextPart } from "../src/prompt"
import { PromptInput } from "../src/prompt-input"
import { SessionInput } from "../src/session-input"
import { SessionMessage } from "../src/session-message"

const part = TextPart.make({
  id: "prt_comment",
  text: "Review this line",
  synthetic: true,
  metadata: {
    forgeComment: {
      path: "src/index.ts",
      selection: { startLine: 3, startChar: 0, endLine: 3, endChar: 10 },
      comment: "Handle the empty case",
      preview: "return value",
      origin: "review",
    },
  },
})

describe("Prompt structured text parts", () => {
  test("round trips ordered text flags and bounded comment metadata", () => {
    const prompt = Prompt.make({ text: "Review this line", parts: [part] })
    const encoded = Schema.encodeSync(Prompt)(prompt)

    expect(Schema.decodeUnknownSync(Prompt)(encoded)).toEqual(prompt)
    expect(
      SessionMessage.User.make({
        id: SessionMessage.ID.make("msg_prompt_parts"),
        type: "user",
        text: prompt.text,
        parts: prompt.parts,
        time: { created: DateTime.makeUnsafe(0) },
      }).parts,
    ).toEqual([part])
  })

  test("keeps old-client aggregate text prompts valid", () => {
    expect(Schema.decodeUnknownSync(Prompt)({ text: "Legacy client" })).toEqual({ text: "Legacy client" })
  })

  test("accepts stable historical part IDs while requiring the part prefix", () => {
    expect(
      Schema.decodeUnknownSync(Prompt)({
        text: "Legacy part",
        parts: [{ id: "prtlegacy", text: "Legacy part" }],
      }).parts?.[0]?.id,
    ).toBe("prtlegacy")
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(Prompt)({
          text: "Invalid part",
          parts: [{ id: "part_invalid", text: "Invalid part" }],
        }),
      ),
    ).toBeTrue()
  })

  test("preserves structured text parts at the public prompt boundary", () => {
    expect(
      Schema.decodeUnknownSync(PromptInput.Prompt)({
        text: "Review this line",
        parts: [part],
      }),
    ).toEqual({
      text: "Review this line",
      parts: [part],
    })
  })

  test("rejects oversized or excessive structured text metadata", () => {
    const decode = Schema.decodeUnknownOption(Prompt)
    expect(
      Option.isNone(
        decode({
          text: "oversized",
          parts: [{ id: "prt_oversized", text: "x".repeat(1_000_001) }],
        }),
      ),
    ).toBeTrue()
    expect(
      Option.isNone(
        decode({
          text: "too many",
          parts: Array.from({ length: 257 }, (_, index) => ({ id: `prt_${index}`, text: "x" })),
        }),
      ),
    ).toBeTrue()
    expect(
      Option.isNone(
        decode({
          text: "duplicate",
          parts: [
            { id: "prt_duplicate", text: "first" },
            { id: "prt_duplicate", text: "second" },
          ],
        }),
      ),
    ).toBeTrue()
  })
})

describe("Session input provenance", () => {
  test("uses one canonical source and leaves historical missing provenance unspecified", () => {
    expect(SessionInput.Source).toBe(SessionMessage.Source)
    const user = {
      id: SessionMessage.ID.make("msg_legacy"),
      type: "user" as const,
      text: "<forge-team-board-update>",
      time: { created: DateTime.makeUnsafe(0) },
    }
    const encode = Schema.encodeSync(SessionMessage.User)
    expect(encode(SessionMessage.User.make({ ...user, source: undefined }))).not.toHaveProperty("source")
    expect(Schema.decodeUnknownSync(SessionMessage.User)(encode(SessionMessage.User.make(user))).source).toBeUndefined()
    expect(encode(SessionMessage.User.make({ ...user, source: "user" })).source).toBe("user")
    expect(encode(SessionMessage.User.make({ ...user, source: "subagent_board" })).source).toBe("subagent_board")
  })
})
