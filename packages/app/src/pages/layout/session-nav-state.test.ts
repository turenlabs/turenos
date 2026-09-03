import { describe, expect, test } from "bun:test"
import { sessionNavStatus } from "./session-nav-state"

describe("sessionNavStatus", () => {
  const status = (overrides: Partial<Parameters<typeof sessionNavStatus>[0]> = {}) =>
    sessionNavStatus({
      hasPermission: false,
      hasQuestion: false,
      hasError: false,
      working: false,
      loading: false,
      unreadCount: 0,
      ...overrides,
    })

  test("prioritizes a pending permission or question", () => {
    expect(status({ hasPermission: true, working: true, unreadCount: 3 })).toBe("attention")
    expect(status({ hasQuestion: true })).toBe("attention")
  })

  test("treats an unseen error as needing attention", () => {
    expect(status({ hasError: true, unreadCount: 1 })).toBe("attention")
  })

  test("prioritizes active work over an ordinary unread result", () => {
    expect(status({ working: true, unreadCount: 1 })).toBe("working")
  })

  test("distinguishes unread and settled sessions", () => {
    expect(status({ unreadCount: 1 })).toBe("unread")
    expect(status()).toBe("settled")
  })

  test("keeps a cold session visibly loading until its state is hydrated", () => {
    expect(status({ loading: true })).toBe("loading")
    expect(status({ loading: true, working: true })).toBe("working")
  })
})
