import { describe, expect, test } from "bun:test"
import {
  INTEL_POLL_INTERVAL_MS,
  intelAgeLabel,
  intelApi,
  isIntelStale,
  severityDot,
  type AdvisoriesPage,
} from "./intel-api"

const advisoriesPage: AdvisoriesPage = {
  items: [
    {
      id: "CVE-2026-0001",
      title: "Example advisory",
      severity: "high",
      publishedAt: 1_000_000,
      updatedAt: 1_000_000,
      source: "nvd",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
}

describe("intelApi", () => {
  test("maps protocol client methods 1:1", async () => {
    const calls: Array<{ method: string; input: unknown }> = []
    const record = (method: string) => (input?: unknown) => {
      calls.push({ method, input })
      return Promise.resolve(
        method === "advisories"
          ? advisoriesPage
          : method === "feeds"
            ? []
            : method === "status"
              ? { feeds: [] }
              : { items: [], total: 0, page: 1, pageSize: 20 },
      )
    }
    const api = intelApi({
      "server.intel": {
        advisories: record("advisories"),
        kev: record("kev"),
        news: record("news"),
        feeds: record("feeds"),
        status: record("status"),
      },
    })

    await expect(api.advisories({ page: 2, pageSize: 20, severity: "high", search: "kernel" })).resolves.toEqual(
      advisoriesPage,
    )
    await expect(api.kev({ page: 1, pageSize: 20 })).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })
    await expect(api.news()).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 })
    await expect(api.feeds()).resolves.toEqual([])
    await expect(api.status()).resolves.toEqual({ feeds: [] })

    expect(calls).toEqual([
      { method: "advisories", input: { page: 2, pageSize: 20, severity: "high", search: "kernel" } },
      { method: "kev", input: { page: 1, pageSize: 20 } },
      { method: "news", input: undefined },
      { method: "feeds", input: undefined },
      { method: "status", input: undefined },
    ])
  })

  test("unwraps heyapi-style data envelopes", async () => {
    const api = intelApi({
      v2: {
        intel: {
          advisories: () => Promise.resolve({ data: advisoriesPage }),
          kev: () => Promise.resolve({ data: { data: { items: [], total: 0, page: 1, pageSize: 20 } } }),
          news: () => Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } }),
          feeds: () => Promise.resolve({ data: [] }),
          status: () => Promise.resolve({ data: { feeds: [] } }),
        },
      },
    })

    await expect(api.advisories()).resolves.toEqual(advisoriesPage)
    await expect(api.kev()).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 })
  })

  test("throws when neither client shape is present", () => {
    expect(() => intelApi({})).toThrow("Intel API is not available")
    expect(() => intelApi(undefined)).toThrow("Intel API is not available")
  })
})

describe("isIntelStale", () => {
  test("matches the 6h server poll interval", () => {
    expect(INTEL_POLL_INTERVAL_MS).toBe(6 * 60 * 60 * 1_000)
  })

  test("never-polled caches are stale", () => {
    expect(isIntelStale(undefined, 1_000_000)).toBe(true)
  })

  test("fresh polls are not stale, old polls are", () => {
    expect(isIntelStale(1_000_000 - 1_000, 1_000_000)).toBe(false)
    expect(isIntelStale(1_000_000 - INTEL_POLL_INTERVAL_MS - 1, 1_000_000)).toBe(true)
  })
})

describe("intelAgeLabel", () => {
  test("names never-updated, just-now, seconds, minutes, hours, and days", () => {
    expect(intelAgeLabel(1_000_000, undefined)).toBe("never updated")
    expect(intelAgeLabel(1_000_000, 999_995)).toBe("just now")
    expect(intelAgeLabel(1_000_000, 955_000)).toBe("45s ago")
    expect(intelAgeLabel(1_000_000, 880_000)).toBe("2m ago")
    expect(intelAgeLabel(10_000_000, 2_800_000)).toBe("2h ago")
    expect(intelAgeLabel(500_000_000, 240_800_000)).toBe("3d ago")
  })

  test("clamps future timestamps to just now", () => {
    expect(intelAgeLabel(1_000_000, 2_000_000)).toBe("just now")
  })
})

describe("severityDot", () => {
  test("escalates critical/high over low/info", () => {
    expect(severityDot("critical")).toBe(severityDot("high"))
    expect(severityDot("critical")).not.toBe(severityDot("low"))
    expect(severityDot("low")).toBe(severityDot("info"))
    for (const severity of ["critical", "high", "medium", "low", "info"] as const) {
      expect(severityDot(severity).length).toBeGreaterThan(0)
    }
  })
})
