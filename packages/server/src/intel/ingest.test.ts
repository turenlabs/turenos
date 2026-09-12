import { describe, expect, test } from "bun:test"
import type { Advisory, KevItem, NewsItem } from "@turenlabs/protocol/groups/intel"
import { sortAdvisories, sortKev, sortNews } from "./ingest"

const advisory = (partial: Partial<Advisory> & Pick<Advisory, "id">): Advisory => ({
  title: partial.id,
  severity: "info",
  publishedAt: 0,
  updatedAt: 0,
  source: "test",
  ...partial,
})

describe("sortAdvisories", () => {
  const items = [
    advisory({ id: "low", severity: "low", cvss: 2.1, publishedAt: 10, source: "b", title: "b" }),
    advisory({ id: "critical", severity: "critical", cvss: 9.8, publishedAt: 30, source: "a", title: "c" }),
    advisory({ id: "unscored", severity: "high", publishedAt: 20, source: "a", title: "a" }),
  ]

  test("orders severity critical-first on desc and reverses on asc", () => {
    expect(sortAdvisories(items, "severity", "desc").map((item) => item.id)).toEqual([
      "critical",
      "unscored",
      "low",
    ])
    expect(sortAdvisories(items, "severity", "asc").map((item) => item.id)).toEqual([
      "low",
      "unscored",
      "critical",
    ])
  })

  test("keeps missing cvss scores last in both directions", () => {
    expect(sortAdvisories(items, "cvss", "desc").map((item) => item.id)).toEqual([
      "critical",
      "low",
      "unscored",
    ])
    expect(sortAdvisories(items, "cvss", "asc").map((item) => item.id)).toEqual([
      "low",
      "critical",
      "unscored",
    ])
  })

  test("sorts by source then newest first within a source", () => {
    expect(sortAdvisories(items, "source", "asc").map((item) => item.id)).toEqual([
      "critical",
      "unscored",
      "low",
    ])
  })

  test("leaves input order untouched without a sort", () => {
    expect(sortAdvisories(items).map((item) => item.id)).toEqual(["low", "critical", "unscored"])
  })
})

const kev = (partial: Partial<KevItem> & Pick<KevItem, "cveID">): KevItem => ({
  vendor: "vendor",
  product: "product",
  name: partial.cveID,
  dateAdded: 0,
  ...partial,
})

describe("sortKev", () => {
  const items = [
    kev({ cveID: "CVE-2026-2", vendor: "b", product: "x", dateAdded: 10, dueDate: 10 }),
    kev({ cveID: "CVE-2026-1", vendor: "a", product: "y", dateAdded: 30 }),
    kev({ cveID: "CVE-2026-3", vendor: "a", product: "a", dateAdded: 20, dueDate: 5 }),
  ]

  test("sorts vendor/product pairs alphabetically", () => {
    expect(sortKev(items, "vendor", "asc").map((item) => item.cveID)).toEqual([
      "CVE-2026-3",
      "CVE-2026-1",
      "CVE-2026-2",
    ])
  })

  test("keeps missing due dates last in both directions", () => {
    expect(sortKev(items, "dueDate", "asc").map((item) => item.cveID)).toEqual([
      "CVE-2026-3",
      "CVE-2026-2",
      "CVE-2026-1",
    ])
    expect(sortKev(items, "dueDate", "desc").map((item) => item.cveID)).toEqual([
      "CVE-2026-2",
      "CVE-2026-3",
      "CVE-2026-1",
    ])
  })
})

const news = (partial: Partial<NewsItem> & Pick<NewsItem, "id">): NewsItem => ({
  title: partial.id,
  url: "https://example.com",
  publishedAt: 0,
  source: "test",
  ...partial,
})

describe("sortNews", () => {
  test("sorts titles alphabetically and keeps feed order without a sort", () => {
    const items = [
      news({ id: "1", title: "b", publishedAt: 10 }),
      news({ id: "2", title: "a", publishedAt: 20 }),
    ]
    expect(sortNews(items, "title", "asc").map((item) => item.id)).toEqual(["2", "1"])
    expect(sortNews(items, "publishedAt", "desc").map((item) => item.id)).toEqual(["2", "1"])
    expect(sortNews(items).map((item) => item.id)).toEqual(["1", "2"])
  })
})
