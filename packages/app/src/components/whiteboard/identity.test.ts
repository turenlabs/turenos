import { describe, expect, test } from "bun:test"
import { whiteboardClientID } from "./identity"

describe("whiteboard client identity", () => {
  test("reuses an identity for a scoped whiteboard", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }

    const first = whiteboardClientID("server/session", storage)
    expect(whiteboardClientID("server/session", storage)).toBe(first)
    expect(whiteboardClientID("server/other-session", storage)).not.toBe(first)
  })

  test("retains an identity when session storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage unavailable")
      },
      setItem: () => {
        throw new Error("storage unavailable")
      },
    }

    const first = whiteboardClientID("storage-disabled", storage)
    expect(whiteboardClientID("storage-disabled", storage)).toBe(first)
  })
})
