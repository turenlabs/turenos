import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createTabNavigationIntent, resolveCurrentTab } from "./tab-navigation-intent"

describe("tab navigation intent", () => {
  test("keeps the requested neighbor active after the committed tab is removed", () => {
    expect(resolveCurrentTab({ routing: false, pending: "left", committed: undefined })).toBe("left")
  })

  test("does not let a stale request override a committed external route", () => {
    expect(resolveCurrentTab({ routing: false, pending: "old", committed: "external" })).toBe("external")
  })

  test("publishes a selection synchronously", () => {
    createRoot((dispose) => {
      const intent = createTabNavigationIntent()

      expect(intent.current()).toBeUndefined()
      const selected = intent.request("session:a")

      expect(intent.current()).toBe(selected)
      expect(selected).toEqual({ generation: 1, destinationKey: "session:a" })
      dispose()
    })
  })

  test("later selections supersede earlier intents with increasing generations", () => {
    createRoot((dispose) => {
      const intent = createTabNavigationIntent()
      const first = intent.request("session:a")
      const second = intent.request("session:b")
      const third = intent.request("session:b")

      expect(intent.current()).toBe(third)
      expect([first.generation, second.generation, third.generation]).toEqual([1, 2, 3])
      expect(third.destinationKey).toBe("session:b")
      dispose()
    })
  })

  test("keeps generations local to each tab context", () => {
    createRoot((dispose) => {
      const first = createTabNavigationIntent()
      const second = createTabNavigationIntent()

      expect(first.request("session:a").generation).toBe(1)
      expect(first.request("session:b").generation).toBe(2)
      expect(second.request("session:c").generation).toBe(1)
      dispose()
    })
  })
})
