import { describe, expect, test } from "bun:test"
import { parsePhishingDomains } from "../../src/security/integrations/data-ti-open/phishing-database"
import { parseTorExitList } from "../../src/security/integrations/data-ti-open/tor-exit"
import { parseTweetFeed } from "../../src/security/integrations/data-ti-open/tweetfeed"

describe("open threat intelligence parsers", () => {
  test("keeps TweetFeed provenance and drops enrichment objects", () => {
    expect(
      parseTweetFeed(
        {
          found: true,
          query: "bad.example",
          window: "30d",
          records: [
            {
              value: "bad.example",
              type: "domain",
              count: 2,
              users: ["reporter"],
              tweets: ["https://x.com/example/status/1"],
              related: [["ip", "192.0.2.1"]],
            },
          ],
          ai: { summary: "separate terms" },
          reg: { org: "separate terms" },
        },
        "bad.example",
      ),
    ).toEqual({
      found: true,
      query: "bad.example",
      window: "30d",
      records: [
        {
          value: "bad.example",
          type: "domain",
          count: 2,
          related: [["ip", "192.0.2.1"]],
          tags: [],
          reporters: ["reporter"],
          provenance: ["https://x.com/example/status/1"],
        },
      ],
      recordsTotal: 1,
    })
  })

  test("rejects malformed or implausibly small bulk feeds", () => {
    expect(() => parseTorExitList("<html>error</html>")).toThrow()
    expect(() => parsePhishingDomains("example.invalid")).toThrow()
    expect(() => parseTorExitList("198.51.100.1\n".repeat(100))).toThrow()
    expect(() => parsePhishingDomains("bad.example\n".repeat(1000))).toThrow()
    expect(() =>
      parseTweetFeed(
        { found: true, query: "other.example", records: [{ value: "other.example", type: "domain" }] },
        "requested.example",
      ),
    ).toThrow("did not match")
  })

  test("accepts plausible exact-value bulk feeds", () => {
    const tor = Array.from({ length: 100 }, (_, index) => `198.51.100.${index + 1}`).join("\n")
    const phishing = Array.from({ length: 1000 }, (_, index) => `bad-${index}.example`).join("\n")
    expect(parseTorExitList(tor)).toHaveLength(100)
    expect(parsePhishingDomains(phishing)).toHaveLength(1000)
  })
})
