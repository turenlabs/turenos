import { describe, expect, test } from "bun:test"
import { intelApi } from "./intel-api"
import { INTEL_FEED_KINDS, isValidFeedUrl } from "./intel-settings"

describe("isValidFeedUrl", () => {
  test("accepts http and https URLs", () => {
    expect(isValidFeedUrl("https://example.com/feed.xml")).toBe(true)
    expect(isValidFeedUrl("http://localhost:8080/rss")).toBe(true)
    expect(isValidFeedUrl("  https://example.com/trimmed  ")).toBe(true)
  })

  test("rejects non-http, relative, and malformed URLs", () => {
    expect(isValidFeedUrl("ftp://example.com/feed.xml")).toBe(false)
    expect(isValidFeedUrl("file:///etc/passwd")).toBe(false)
    expect(isValidFeedUrl("/relative/path.xml")).toBe(false)
    expect(isValidFeedUrl("not a url")).toBe(false)
    expect(isValidFeedUrl("")).toBe(false)
  })

  test("covers every ingest feed kind", () => {
    expect([...INTEL_FEED_KINDS].sort()).toEqual(["epss", "github", "kev", "nvd", "rss"])
  })
})

describe("intelApi feed settings", () => {
  test("maps protocol client methods 1:1", async () => {
    const calls: Array<{ method: string; input: unknown }> = []
    const record = (method: string) => (input?: unknown) => {
      calls.push({ method, input })
      return Promise.resolve(method === "feedsReset" ? [] : { id: "kev", enabled: false })
    }
    const api = intelApi({
      "server.intel": {
        advisories: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
        kev: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
        news: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
        feeds: () => Promise.resolve([]),
        status: () => Promise.resolve({ feeds: [] }),
        feedUpdate: record("feedUpdate"),
        feedAdd: record("feedAdd"),
        feedsReset: record("feedsReset"),
      },
    })

    await api.updateFeed("kev", { enabled: false })
    await api.addFeed({ name: "Example", kind: "rss", url: "https://example.com/feed.xml" })
    await api.resetFeeds()

    expect(calls).toEqual([
      { method: "feedUpdate", input: { feedID: "kev", enabled: false } },
      { method: "feedAdd", input: { name: "Example", kind: "rss", url: "https://example.com/feed.xml" } },
      { method: "feedsReset", input: undefined },
    ])
  })

  test("unwraps heyapi-style data envelopes", async () => {
    const feed = { id: "kev", name: "KEV", kind: "kev" as const, url: "https://example.com/kev", enabled: true }
    const api = intelApi({
      v2: {
        intel: {
          advisories: () => Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } }),
          kev: () => Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } }),
          news: () => Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } }),
          feeds: () => Promise.resolve({ data: [] }),
          status: () => Promise.resolve({ data: { feeds: [] } }),
          feedUpdate: () => Promise.resolve({ data: feed }),
          feedAdd: () => Promise.resolve({ data: { data: feed } }),
          feedsReset: () => Promise.resolve({ data: [feed] }),
        },
      },
    })

    await expect(api.updateFeed("kev", { url: "https://example.com/kev" })).resolves.toEqual(feed)
    await expect(api.addFeed({ name: "KEV", kind: "kev", url: "https://example.com/kev" })).resolves.toEqual(feed)
    await expect(api.resetFeeds()).resolves.toEqual([feed])
  })
})
