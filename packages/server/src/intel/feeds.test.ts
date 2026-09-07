import { describe, expect, test } from "bun:test"
import type { Feed } from "@turenlabs/protocol/groups/intel"
import { applyFeedAdd, uniqueFeedID } from "./feeds"

describe("intel feed ids", () => {
  test.each([63, 64])("reserves room for a suffix when the base is %d characters", (length) => {
    const base = "a".repeat(length)
    const existing = {
      id: base,
      name: "Existing",
      kind: "rss" as const,
      url: "https://example.com/feed.xml",
      enabled: true,
    }
    const added = applyFeedAdd([existing], {
      name: base,
      kind: "rss",
      url: "https://example.com/next.xml",
    })

    expect(added?.id).toBe(`${"a".repeat(62)}-2`)
    expect(added?.id).not.toBe(base)
    expect(added?.id.length).toBeLessThanOrEqual(64)
  })

  test("continues to generate bounded ids across repeated collisions", () => {
    const base = "a".repeat(64)
    const second = `${"a".repeat(62)}-2`
    const feeds = [base, second].map(
      (id) =>
        ({
          id,
          name: id,
          kind: "rss",
          url: "https://example.com/feed.xml",
          enabled: true,
        }) satisfies Feed,
    )
    expect(uniqueFeedID(feeds, base)).toBe(`${"a".repeat(62)}-3`)
  })
})
