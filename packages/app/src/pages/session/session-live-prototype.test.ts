import { describe, expect, test } from "bun:test"
import { sessionTranscriptVisible } from "./session-live-status"

describe("sessionTranscriptVisible", () => {
  test("keeps the legacy transcript active", () => {
    expect(sessionTranscriptVisible(false, "activity")).toBe(true)
  })

  test("activates new-layout history only in the Transcript view", () => {
    expect(sessionTranscriptVisible(true, "activity")).toBe(false)
    expect(sessionTranscriptVisible(true, "history")).toBe(true)
  })
})
