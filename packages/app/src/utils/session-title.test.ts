import { describe, expect, test } from "bun:test"
import { SessionTitle } from "@turenlabs/client/session-title"
import { sessionTitle } from "./session-title"

describe("sessionTitle", () => {
  test("names new and child placeholders", () => {
    expect(sessionTitle(SessionTitle.placeholder("new", 0))).toBe("New session")
    expect(sessionTitle(SessionTitle.placeholder("child", 0))).toBe("Child session")
  })

  test("passes other titles through", () => {
    expect(sessionTitle("Fix the build")).toBe("Fix the build")
    expect(sessionTitle("")).toBe("")
    expect(sessionTitle(undefined)).toBeUndefined()
  })
})
