import { describe, expect, test } from "bun:test"
import type { Part } from "@turenlabs/sdk/v2"
import type { PartGroup } from "@turenlabs/session-ui/message-part"
import { assistantPartKind, separateFrom } from "./density"

const part = (type: string) => ({ id: "prt_1", type }) as unknown as Part
const partGroup: PartGroup = { key: "part:msg_1:prt_1", type: "part", ref: { messageID: "msg_1", partID: "prt_1" } }
const contextGroup: PartGroup = { key: "context:prt_1", type: "context", refs: [] }

describe("separateFrom", () => {
  test("opens the transcript flush and never doubles a gap around a boundary", () => {
    expect(separateFrom(undefined, "block")).toBe(false)
    expect(separateFrom("block", "boundary")).toBe(false)
    expect(separateFrom("boundary", "block")).toBe(false)
    expect(separateFrom("boundary", "inline")).toBe(false)
  })

  test("air belongs at a structural boundary, in either direction", () => {
    expect(separateFrom("block", "inline")).toBe(true)
    expect(separateFrom("inline", "block")).toBe(true)
    expect(separateFrom("block", "block")).toBe(true)
  })

  test("a run of single-line rows stacks flush", () => {
    expect(separateFrom("inline", "inline")).toBe(false)
  })
})

describe("assistantPartKind", () => {
  test("reads prose as a block", () => {
    expect(assistantPartKind(partGroup, part("text"))).toBe("block")
    expect(assistantPartKind(partGroup, part("reasoning"))).toBe("block")
    expect(assistantPartKind(partGroup, part("compaction"))).toBe("block")
  })

  test("reads a tool call, and the collapsed context cluster, as one line", () => {
    expect(assistantPartKind(partGroup, part("tool"))).toBe("inline")
    expect(assistantPartKind(contextGroup, undefined)).toBe("inline")
  })

  test("falls back to inline when the part has not landed yet", () => {
    expect(assistantPartKind(partGroup, undefined)).toBe("inline")
  })
})
