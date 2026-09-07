import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { Memory } from "@turenlabs/core/memory"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionExecutionLocal } from "@turenlabs/core/session/execution/local"
import { createRoutes } from "@turenlabs/server/routes"
import { pollOnce, readCache } from "@turenlabs/server/intel/ingest"
import { isStale, ensureFreshOnBoot, pollNow } from "@turenlabs/server/intel/scheduler"
import { DEFAULT_FEEDS, FETCH_TIMEOUT_MS, fetchRss, parseRss, POLL_INTERVAL_MS } from "@turenlabs/server/intel/sources"
import {
  applyFeedAdd,
  applyFeedUpdate,
  feedsConfigPath,
  readEffectiveFeeds,
  resetFeeds,
  sanitizeFeedList,
  slugifyFeedID,
  uniqueFeedID,
  validateFeedCreate,
  validateFeedPatch,
} from "@turenlabs/server/intel/feeds"
import { tmpdir } from "../fixture/fixture"

// Feed settings share the per-user state dir with the intel cache, so every
// run in this file starts (and ends) on the lazy defaults.
beforeAll(async () => {
  await Effect.runPromise(resetFeeds())
})

afterAll(async () => {
  await Effect.runPromise(resetFeeds())
})

const authorization = `Basic ${Buffer.from("forge:intel-test").toString("base64")}`
const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1_000
const isoAt = (agoMs: number) => new Date(NOW - agoMs).toISOString()

const kevPayload = {
  vulnerabilities: [
    {
      cveID: "CVE-2026-0001",
      vendorProject: "acme",
      product: "widget",
      vulnerabilityName: "Acme Widget RCE",
      dateAdded: isoAt(3 * DAY_MS).slice(0, 10),
      dueDate: isoAt(-7 * DAY_MS).slice(0, 10),
      shortDescription: "Remote code execution in Acme Widget.",
    },
  ],
}

const nvdPayload = {
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2026-0002",
        descriptions: [{ lang: "en", value: "Buffer overflow in example library." }],
        published: isoAt(12 * 60 * 60 * 1_000),
        lastModified: isoAt(6 * 60 * 60 * 1_000),
        sourceIdentifier: "nvd@nist.gov",
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: "CRITICAL" } }] },
      },
    },
  ],
}

const epssPayload = { data: [{ cve: "CVE-2026-0003", epss: 0.82, percentile: 0.97, date: isoAt(0).slice(0, 10) }] }

const githubPayload = [
  {
    ghsa_id: "GHSA-aaaa-bbbb-cccc",
    summary: "Example package XSS",
    description: "Cross-site scripting in example package.",
    severity: "high",
    cvss: { score: 7.5 },
    published_at: isoAt(36 * 60 * 60 * 1_000),
    updated_at: isoAt(30 * 60 * 60 * 1_000),
    html_url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  },
]

const rssPayload = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>CISA News</title>
<item><title>CISA Adds One Known Exploited Vulnerability</title><link>https://www.cisa.gov/news/1</link><pubDate>${new Date(NOW - 2 * 60 * 60 * 1_000).toUTCString()}</pubDate><description>Catalog update.</description></item>
</channel></rss>`

const stubFetch = async (url: string, _init?: RequestInit): Promise<Response> => {
  if (url.includes("known_exploited_vulnerabilities")) return Response.json(kevPayload)
  if (url.includes("services.nvd.nist.gov")) return Response.json(nvdPayload)
  if (url.includes("api.first.org")) return Response.json(epssPayload)
  if (url.includes("api.github.com")) return Response.json(githubPayload)
  if (url.includes("cisa.gov/news.xml"))
    return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
  if (url.includes("bleepingcomputer.com/feed"))
    return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
  if (url.includes("feedburner.com/TheHackersNews"))
    return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
  if (url.includes("isc.sans.edu/rssfeed_full.xml"))
    return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
  if (url.includes("darkreading.com/rss.xml"))
    return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
  if (url.includes("greynoise.io/blog/rss.xml"))
    return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
  if (url.includes("stepsecurity.io/blog/rss.xml"))
    return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
  throw new Error(`unexpected url: ${url}`)
}

const failingFetch = async (): Promise<Response> => new Response("boom", { status: 500 })

function actualServerAPI(directory: string) {
  const app = HttpRouter.toWebHandler(
    createRoutes("intel-test").pipe(
      Layer.provide(HttpServer.layerServices),
      Layer.provideMerge(
        AppNodeBuilder.build(LayerNode.group([Memory.node, Loop.node, PermissionSaved.node, SessionV2.node]), [
          [SessionExecution.node, SessionExecutionLocal.node],
        ]),
      ),
    ),
    { disableLogger: true },
  )
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set("x-forge-directory", directory)
    headers.set("authorization", authorization)
    return app.handler(new Request(new URL(path, "http://localhost"), { ...init, headers }))
  }
  return { request, [Symbol.asyncDispose]: () => app.dispose() }
}

const isolatedTmpDir = () => tmpdir({ config: { formatter: false, lsp: false } })

const seed = () => Effect.runPromise(pollOnce(stubFetch, NOW))

describe("intel HttpApi", () => {
  test("serves default feeds with zero config", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const response = await api.request("/api/intel/feeds")
    expect(response.status).toBe(200)
    const feeds = (await response.json()) as ReadonlyArray<{ id: string; enabled: boolean }>
    expect(feeds.map((feed) => feed.id).sort()).toEqual(
      [
        "bleepingcomputer",
        "cisa-news",
        "darkreading",
        "epss",
        "github",
        "greynoise",
        "kev",
        "nvd",
        "sans-isc",
        "stepsecurity",
        "thehackernews",
      ].sort(),
    )
    expect(feeds.every((feed) => feed.enabled)).toBe(true)
  })

  test("polls stub feeds and serves paged advisories, kev, news, trends, status", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const { cache } = await seed()
    expect(cache.advisories.length).toBe(3)
    expect(cache.kev.length).toBe(1)
    expect(cache.news.length).toBe(7)

    const advisories = (await (await api.request("/api/intel/advisories")).json()) as {
      items: ReadonlyArray<{ id: string; publishedAt: number }>
      total: number
      page: number
      pageSize: number
    }
    expect(advisories.total).toBe(3)
    expect(advisories.page).toBe(1)
    expect(advisories.pageSize).toBe(25)
    expect(advisories.items.map((item) => item.id).sort()).toEqual(
      ["CVE-2026-0002", "CVE-2026-0003", "GHSA-aaaa-bbbb-cccc"].sort(),
    )
    const times = advisories.items.map((item) => item.publishedAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)

    const critical = (await (await api.request("/api/intel/advisories?severity=critical")).json()) as { total: number }
    expect(critical.total).toBe(1)

    const search = (await (await api.request("/api/intel/advisories?search=xss")).json()) as {
      items: ReadonlyArray<{ id: string }>
      total: number
    }
    expect(search.total).toBe(1)
    expect(search.items[0]?.id).toBe("GHSA-aaaa-bbbb-cccc")

    const second = (await (await api.request("/api/intel/advisories?page=2&pageSize=2")).json()) as {
      items: ReadonlyArray<unknown>
      total: number
      page: number
      pageSize: number
    }
    expect(second.total).toBe(3)
    expect(second.page).toBe(2)
    expect(second.pageSize).toBe(2)
    expect(second.items.length).toBe(1)

    const kev = (await (await api.request("/api/intel/kev")).json()) as {
      items: ReadonlyArray<{ cveID: string }>
      total: number
    }
    expect(kev.total).toBe(1)
    expect(kev.items[0]?.cveID).toBe("CVE-2026-0001")

    const news = (await (await api.request("/api/intel/news")).json()) as {
      items: ReadonlyArray<{ title: string }>
      total: number
    }
    expect(news.total).toBe(7)
    expect(news.items[0]?.title).toBe("CISA Adds One Known Exploited Vulnerability")

    const trends = (await (await api.request("/api/intel/trends?days=7")).json()) as {
      points: ReadonlyArray<{ date: string; count: number }>
      windowDays: number
    }
    expect(trends.windowDays).toBe(7)
    expect(trends.points.length).toBe(7)
    expect(trends.points.reduce((sum, point) => sum + point.count, 0)).toBe(3)

    const status = (await (await api.request("/api/intel/status")).json()) as {
      lastPollAt: number
      nextPollAt: number
      feeds: ReadonlyArray<{ feedID: string; lastOk: boolean }>
    }
    expect(status.lastPollAt).toBe(NOW)
    expect(status.nextPollAt).toBe(NOW + POLL_INTERVAL_MS)
    expect(status.feeds.every((feed) => feed.lastOk)).toBe(true)
  })

  test("records per-feed failures without throwing and preserves the previous cache", async () => {
    const seeded = await Effect.runPromise(pollOnce(stubFetch, NOW))
    expect(seeded.cache.advisories.length).toBe(3)
    const { cache } = await Effect.runPromise(pollOnce(failingFetch, NOW + 1_000))
    expect(cache.advisories).toEqual(seeded.cache.advisories)
    expect(cache.kev).toEqual(seeded.cache.kev)
    expect(cache.news).toEqual(seeded.cache.news)
    // A total failure must not advance lastPollAt, or retries black out for 6h.
    expect(cache.lastPollAt).toBe(NOW)
    expect(cache.feeds.length).toBeGreaterThan(0)
    expect(cache.feeds.every((feed) => feed.lastOk === false)).toBe(true)
  })

  test("scheduler treats missing or old rows as stale and skips fresh rows", async () => {
    expect(isStale(undefined, NOW)).toBe(true)
    expect(isStale(NOW - POLL_INTERVAL_MS - 1, NOW)).toBe(true)
    expect(isStale(NOW - 60_000, NOW)).toBe(false)
    expect(await Effect.runPromise(ensureFreshOnBoot(stubFetch, NOW))).toBe(false)
    await Effect.runPromise(pollOnce(stubFetch, NOW - POLL_INTERVAL_MS - 1))
    expect(await Effect.runPromise(ensureFreshOnBoot(stubFetch, NOW))).toBe(true)
  })

  test("pollNow forces a poll even when the cache is fresh", async () => {
    await Effect.runPromise(pollOnce(stubFetch, NOW))
    let calls = 0
    const counting = (url: string): Promise<Response> => {
      calls += 1
      return stubFetch(url)
    }
    await pollNow(counting, NOW + 1_000)
    expect(calls).toBeGreaterThan(0)
    const cache = await Effect.runPromise(readCache())
    expect(cache.lastPollAt).toBe(NOW + 1_000)
  })

  test("parses RSS items and skips malformed entries", () => {
    expect(parseRss("<rss></rss>")).toEqual([])
    const items = parseRss(rssPayload)
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({
      title: "CISA Adds One Known Exploited Vulnerability",
      link: "https://www.cisa.gov/news/1",
    })
  })
})

describe("intel feed settings", () => {
  const writeJson = (
    api: { request: (path: string, init?: RequestInit) => Promise<Response> },
    path: string,
    method: string,
    body: unknown,
  ) => api.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  test("disables a feed and ingestion skips it", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const response = await writeJson(api, "/api/intel/feeds/kev", "PATCH", { enabled: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: "kev", enabled: false })

    const feeds = (await (await api.request("/api/intel/feeds")).json()) as ReadonlyArray<{
      id: string
      enabled: boolean
    }>
    expect(feeds.find((feed) => feed.id === "kev")?.enabled).toBe(false)

    const { cache } = await Effect.runPromise(pollOnce(stubFetch, NOW))
    expect(cache.kev).toEqual([])
    expect(cache.advisories.length).toBe(3)
    expect(cache.feeds.some((feed) => feed.feedID === "kev")).toBe(false)
    await Effect.runPromise(resetFeeds())
  })

  test("honors an edited feed URL during ingestion", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const customBase = "https://nvd.example.invalid/rest/json/cves/2.0"
    const response = await writeJson(api, "/api/intel/feeds/nvd", "PATCH", { url: customBase })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: "nvd", url: customBase })

    const seen: Array<string> = []
    const customFetch = async (url: string): Promise<Response> => {
      seen.push(url)
      if (url.startsWith(customBase)) return Response.json(nvdPayload)
      return stubFetch(url)
    }
    const { cache } = await Effect.runPromise(pollOnce(customFetch, NOW))
    expect(seen.some((url) => url.startsWith(customBase))).toBe(true)
    expect(cache.advisories.map((item) => item.id)).toContain("CVE-2026-0002")
    await Effect.runPromise(resetFeeds())
  })

  test("serializes concurrent edits without losing either update", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    await Effect.runPromise(resetFeeds())
    await Promise.all([
      writeJson(api, "/api/intel/feeds/nvd", "PATCH", { enabled: false }),
      writeJson(api, "/api/intel/feeds/github", "PATCH", { enabled: false }),
    ])
    const feeds = await Effect.runPromise(readEffectiveFeeds())
    expect(feeds.find((feed) => feed.id === "nvd")?.enabled).toBe(false)
    expect(feeds.find((feed) => feed.id === "github")?.enabled).toBe(false)
    await Effect.runPromise(resetFeeds())
  })

  test("preserves advisory and news categories when one enabled feed fails", async () => {
    await Effect.runPromise(resetFeeds())
    const seeded = await Effect.runPromise(pollOnce(stubFetch, NOW))
    const partialFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("services.nvd.nist.gov")) throw new Error("NVD unavailable")
      if (url.includes("bleepingcomputer.com/feed")) throw new Error("RSS unavailable")
      return stubFetch(url, init)
    }
    const { cache } = await Effect.runPromise(pollOnce(partialFetch, NOW + 1_000))
    expect(cache.advisories).toEqual(seeded.cache.advisories)
    expect(cache.news).toEqual(seeded.cache.news)
    expect(cache.feeds.find((feed) => feed.feedID === "nvd")?.lastOk).toBe(false)
    expect(cache.feeds.find((feed) => feed.feedID === "github")?.lastOk).toBe(true)
    expect(cache.feeds.find((feed) => feed.feedID === "bleepingcomputer")?.lastOk).toBe(false)
    await Effect.runPromise(resetFeeds())
  })

  test("clears a category when every feed in it is disabled", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    await Effect.runPromise(resetFeeds())
    await Effect.runPromise(pollOnce(stubFetch, NOW))
    await Promise.all(
      DEFAULT_FEEDS.filter((feed) => feed.kind === "rss").map((feed) =>
        writeJson(api, `/api/intel/feeds/${feed.id}`, "PATCH", { enabled: false }),
      ),
    )
    const { cache } = await Effect.runPromise(pollOnce(stubFetch, NOW + 1_000))
    expect(cache.news).toEqual([])
    await Effect.runPromise(resetFeeds())
  })

  test(
    "bounds a response body that never completes",
    async () => {
      const hangingBody = new ReadableStream<Uint8Array>({ start() {} })
      await expect(fetchRss("https://example.com/hanging.xml", async () => new Response(hangingBody))).rejects.toThrow(
        /timed out/,
      )
    },
    FETCH_TIMEOUT_MS + 15_000,
  )

  test("adds a custom RSS feed and polls it", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    const customUrl = "https://example.com/extra.xml"
    const created = await writeJson(api, "/api/intel/feeds", "POST", {
      name: "Example Extra",
      kind: "rss",
      url: customUrl,
    })
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ id: "example-extra", name: "Example Extra", enabled: true })

    const feeds = (await (await api.request("/api/intel/feeds")).json()) as ReadonlyArray<{ id: string }>
    expect(feeds.length).toBe(DEFAULT_FEEDS.length + 1)
    expect(feeds.map((feed) => feed.id)).toContain("example-extra")

    const extraFetch = async (url: string): Promise<Response> => {
      if (url === customUrl) return new Response(rssPayload, { headers: { "content-type": "application/rss+xml" } })
      return stubFetch(url)
    }
    const { cache } = await Effect.runPromise(pollOnce(extraFetch, NOW))
    expect(cache.news.length).toBe(8)
    expect(cache.news.map((item) => item.source)).toContain("Example Extra")
    expect(new Set(cache.news.map((item) => item.source)).size).toBe(8)
    expect(cache.feeds.find((feed) => feed.feedID === "example-extra")).toMatchObject({ lastOk: true })
    await Effect.runPromise(resetFeeds())
  })

  test("rejects invalid feed writes without persisting them", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    expect((await writeJson(api, "/api/intel/feeds/nope", "PATCH", { enabled: false })).status).toBe(404)
    expect((await writeJson(api, "/api/intel/feeds/kev", "PATCH", { url: "ftp://example.com/kev" })).status).toBe(400)
    expect((await writeJson(api, "/api/intel/feeds/kev", "PATCH", {})).status).toBe(400)
    expect(
      (
        await writeJson(api, "/api/intel/feeds", "POST", {
          id: "kev",
          name: "Dup",
          kind: "rss",
          url: "https://example.com/dup.xml",
        })
      ).status,
    ).toBe(409)
    expect(
      (await writeJson(api, "/api/intel/feeds", "POST", { name: "Bad URL", kind: "rss", url: "notaurl" })).status,
    ).toBe(400)
    expect(
      (
        await writeJson(api, "/api/intel/feeds", "POST", {
          name: "",
          kind: "rss",
          url: "https://example.com/empty.xml",
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await writeJson(api, "/api/intel/feeds", "POST", {
          name: "Bad kind",
          kind: "atom",
          url: "https://example.com/atom.xml",
        })
      ).status,
    ).toBe(400)

    const feeds = (await (await api.request("/api/intel/feeds")).json()) as unknown
    expect(feeds).toEqual([...DEFAULT_FEEDS])
  })

  test("resets overrides back to the lazy defaults", async () => {
    await using directory = await isolatedTmpDir()
    await using api = actualServerAPI(directory.path)
    expect((await writeJson(api, "/api/intel/feeds/github", "PATCH", { enabled: false })).status).toBe(200)
    expect(await Bun.file(feedsConfigPath()).exists()).toBe(true)

    const reset = await api.request("/api/intel/feeds/reset", { method: "POST" })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual([...DEFAULT_FEEDS])

    const feeds = (await (await api.request("/api/intel/feeds")).json()) as unknown
    expect(feeds).toEqual([...DEFAULT_FEEDS])
    expect(await Bun.file(feedsConfigPath()).exists()).toBe(false)
    expect(await Effect.runPromise(readEffectiveFeeds())).toEqual([...DEFAULT_FEEDS])
  })

  test("feed helpers validate, slugify, and merge", () => {
    expect(slugifyFeedID("CISA News!")).toBe("cisa-news")
    expect(slugifyFeedID("!!!")).toBe("feed")
    expect(uniqueFeedID([...DEFAULT_FEEDS], "kev")).toBe("kev-2")
    expect(uniqueFeedID([...DEFAULT_FEEDS], "brand-new")).toBe("brand-new")
    expect(validateFeedPatch({})).toMatch(/No feed fields/)
    expect(validateFeedPatch({ url: "gopher://example.com" })).toMatch(/http/)
    expect(validateFeedPatch({ enabled: false })).toBeUndefined()
    expect(validateFeedCreate({ name: "  ", kind: "rss", url: "https://example.com/f.xml" })).toMatch(/non-empty/)
    expect(validateFeedCreate({ name: "Ok", kind: "rss", url: "https://example.com/f.xml" })).toBeUndefined()
    expect(sanitizeFeedList("not json")).toBeUndefined()
    expect(sanitizeFeedList({ feeds: [{ id: "bogus" }] })).toEqual([])
    const added = applyFeedAdd([...DEFAULT_FEEDS], {
      name: "Example Extra",
      kind: "rss",
      url: "https://example.com/extra.xml",
    })
    expect(added?.id).toBe("example-extra")
    expect(
      applyFeedAdd([...DEFAULT_FEEDS], { id: "kev", name: "Dup", kind: "rss", url: "https://example.com/dup.xml" }),
    ).toBeUndefined()
    const updated = applyFeedUpdate([...DEFAULT_FEEDS], "kev", { enabled: false })
    expect(updated?.feed.enabled).toBe(false)
    expect(updated?.feeds.find((feed) => feed.id === "kev")?.enabled).toBe(false)
    expect(applyFeedUpdate([...DEFAULT_FEEDS], "missing", { enabled: false })).toBeUndefined()
  })
})
