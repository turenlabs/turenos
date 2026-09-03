import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@turenlabs/sdk/v2"
import { latestAssistantError, latestAssistantResponse, sessionLiveError } from "./session-live-response"

const assistant = (id: string, input: Partial<Extract<Message, { role: "assistant" }>> = {}) =>
  ({ id, role: "assistant", ...input }) as Message
const text = (value: string, time?: number) =>
  ({ type: "text", text: value, time: time === undefined ? undefined : { start: time, end: time } }) as Part
const toolError = (value: string, time = 0) =>
  ({ type: "tool", state: { status: "error", error: value, time: { start: time, end: time } } }) as Part
const toolCompleted = (time = 0) =>
  ({ type: "tool", state: { status: "completed", time: { start: time, end: time } } }) as Part

describe("latestAssistantResponse", () => {
  test("keeps the prior response while a new assistant message has no text", () => {
    const messages = [assistant("previous"), assistant("continuation")]

    expect(latestAssistantResponse(messages, { previous: [text("Prior response")], continuation: [] })).toBe(
      "Prior response",
    )
    expect(
      latestAssistantResponse(messages, {
        previous: [text("Prior response")],
        continuation: [text("Streaming response")],
      }),
    ).toBe("Streaming response")
  })

  test("ignores whitespace-only assistant text", () => {
    expect(
      latestAssistantResponse([assistant("previous"), assistant("empty")], {
        previous: [text("Prior response")],
        empty: [text("  \n ")],
      }),
    ).toBe("Prior response")
  })
})

describe("latestAssistantError", () => {
  test("clears a tool failure when a later assistant response exists", () => {
    const messages = [assistant("failed"), assistant("response")]

    expect(
      latestAssistantError(messages, {
        failed: [toolError("Failed tool")],
        response: [text("Recovered response")],
      }),
    ).toBeUndefined()
  })

  test("keeps a tool failure that occurs after the latest assistant response", () => {
    const messages = [assistant("response"), assistant("failed")]

    expect(
      latestAssistantError(messages, {
        response: [text("Response before failure")],
        failed: [toolError("Latest tool failed")],
      }),
    ).toBe("Latest tool failed")
  })

  test("uses timestamps when live part IDs place a later response before an earlier failure", () => {
    expect(
      latestAssistantError([assistant("message")], {
        message: [text("Recovered response", 20), toolError("Earlier failure", 10)],
      }),
    ).toBeUndefined()
  })

  test("uses timestamps when live part IDs place a later failure before an earlier response", () => {
    expect(
      latestAssistantError([assistant("message")], {
        message: [toolError("Later failure", 20), text("Earlier response", 10)],
      }),
    ).toBe("Later failure")
  })

  test("clears an old tool failure when a later tool completes", () => {
    const messages = [assistant("failed"), assistant("continued")]

    expect(
      latestAssistantError(messages, {
        failed: [toolError("Old failure")],
        continued: [toolCompleted()],
      }),
    ).toBeUndefined()
  })

  test("uses timestamps when a later completed tool is sorted before an earlier failure", () => {
    expect(
      latestAssistantError([assistant("message")], {
        message: [toolCompleted(20), toolError("Earlier failure", 10)],
      }),
    ).toBeUndefined()
  })

  test("keeps a tool failure that occurs after a completed tool", () => {
    expect(
      latestAssistantError([assistant("message")], {
        message: [toolError("Latest failure", 20), toolCompleted(10)],
      }),
    ).toBe("Latest failure")
  })

  test("surfaces a terminal assistant failure after an older response", () => {
    const messages = [
      assistant("response"),
      assistant("failed", { error: { name: "UnknownError", data: { message: "Provider failed" } } }),
    ]

    expect(latestAssistantError(messages, { response: [text("Earlier response")], failed: [] })).toBe("Provider failed")
  })

  test("clears an assistant failure when a later response exists", () => {
    const messages = [
      assistant("failed", { error: { name: "UnknownError", data: { message: "Provider failed" } } }),
      assistant("response"),
    ]

    expect(latestAssistantError(messages, { failed: [], response: [text("Recovered response")] })).toBeUndefined()
  })

  test("does not treat an interrupted assistant message as a terminal failure", () => {
    const messages = [
      assistant("interrupted", { error: { name: "MessageAbortedError", data: { message: "Stopped" } } }),
    ]

    expect(latestAssistantError(messages, { interrupted: [] })).toBeUndefined()
  })
})

describe("sessionLiveError", () => {
  test("suppresses a recoverable tool failure while the session is working", () => {
    const messages = [assistant("failed")]
    const parts = { failed: [toolError("Recoverable failure")] }

    expect(sessionLiveError({ working: true, attention: false, messages, parts })).toBeUndefined()
    expect(sessionLiveError({ working: false, attention: false, messages, parts })).toBe("Recoverable failure")
  })

  test("suppresses failures while the session needs an explicit response", () => {
    const messages = [assistant("failed")]
    const parts = { failed: [toolError("Failure before question")] }

    expect(sessionLiveError({ working: false, attention: true, messages, parts })).toBeUndefined()
  })
})
