import { Global } from "@turenlabs/core/global"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import type { Advisory, Feed, FeedStatus, KevItem, NewsItem, Severity } from "@turenlabs/protocol/groups/intel"
import { POLL_INTERVAL_MS } from "./sources"
import type { EpssRaw, FetchFn, GitHubAdvisoryRaw, KevRaw, NvdRaw, RssRaw } from "./sources"
import { fetchEpss, fetchGitHubAdvisories, fetchKev, fetchNvd, fetchRss, defaultFetch } from "./sources"
import { readEffectiveFeeds } from "./feeds"

export interface Cache {
  readonly advisories: ReadonlyArray<Advisory>
  readonly kev: ReadonlyArray<KevItem>
  readonly news: ReadonlyArray<NewsItem>
  readonly lastPollAt?: number
  readonly feeds: ReadonlyArray<FeedStatus>
}

export const emptyCache: Cache = { advisories: [], kev: [], news: [], feeds: [] }

export const cachePath = () => path.join(Global.Path.state, "intel-cache.json")

const parsedCache = (raw: string): Cache => {
  const parsed = JSON.parse(raw) as Partial<Cache>
  return {
    advisories: Array.isArray(parsed.advisories) ? parsed.advisories : [],
    kev: Array.isArray(parsed.kev) ? parsed.kev : [],
    news: Array.isArray(parsed.news) ? parsed.news : [],
    lastPollAt: typeof parsed.lastPollAt === "number" ? parsed.lastPollAt : undefined,
    feeds: Array.isArray(parsed.feeds) ? parsed.feeds : [],
  }
}

export const readCache = (): Effect.Effect<Cache> =>
  Effect.promise(() => fs.readFile(cachePath(), "utf8").then(parsedCache, () => emptyCache)).pipe(
    Effect.catch(() => Effect.succeed(emptyCache)),
  )

const writeCacheFile = (cache: Cache): Effect.Effect<void> =>
  Effect.promise(() =>
    fs
      .mkdir(path.dirname(cachePath()), { recursive: true })
      .then(() => {
        // Atomic publish so concurrent readers never see a torn cache file.
        const tmp = `${cachePath()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
        return fs.writeFile(tmp, JSON.stringify(cache), "utf8").then(
          () =>
            fs.rename(tmp, cachePath()).then(
              () => undefined,
              () =>
                fs.rm(tmp, { force: true }).then(
                  () => undefined,
                  () => undefined,
                ),
            ),
          () => undefined,
        )
      })
      .then(
        () => undefined,
        () => undefined,
      ),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)))

const attempt = <T>(
  run: () => Promise<T>,
): Effect.Effect<Readonly<{ ok: true; value: T } | { ok: false; error: unknown }>> =>
  Effect.promise(() =>
    run().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  )

const timeOf = (value: string, fallback: number) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const severityOf = (value: string | undefined, cvss?: number): Severity => {
  const normalized = (value ?? "").toLowerCase()
  if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized
  }
  if (normalized === "moderate") return "medium"
  if (cvss !== undefined) {
    if (cvss >= 9) return "critical"
    if (cvss >= 7) return "high"
    if (cvss >= 4) return "medium"
    return "low"
  }
  return "info"
}

export const normalizeKev = (items: ReadonlyArray<KevRaw>): ReadonlyArray<KevItem> =>
  items.flatMap((item) => {
    if (!item.cveID) return []
    return [
      {
        cveID: item.cveID,
        vendor: item.vendorProject,
        product: item.product,
        name: item.vulnerabilityName,
        dateAdded: timeOf(item.dateAdded, 0),
        ...(item.dueDate ? { dueDate: timeOf(item.dueDate, 0) } : {}),
        url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(item.cveID)}`,
      },
    ]
  })

export const normalizeNvd = (items: ReadonlyArray<NvdRaw>, now: number): ReadonlyArray<Advisory> =>
  items.flatMap((item) => {
    if (!item.id) return []
    const publishedAt = timeOf(item.published, now)
    return [
      {
        id: item.id,
        title: item.id,
        severity: severityOf(item.severity, item.cvss),
        ...(item.cvss !== undefined ? { cvss: item.cvss } : {}),
        publishedAt,
        updatedAt: timeOf(item.lastModified, publishedAt),
        source: item.source || "nvd",
        url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(item.id)}`,
        ...(item.description ? { summary: item.description.slice(0, 500) } : {}),
      },
    ]
  })

export const normalizeGitHub = (items: ReadonlyArray<GitHubAdvisoryRaw>, now: number): ReadonlyArray<Advisory> =>
  items.flatMap((item) => {
    if (!item.id) return []
    const publishedAt = timeOf(item.publishedAt, now)
    return [
      {
        id: item.id,
        title: item.summary || item.id,
        severity: severityOf(item.severity, item.cvss),
        ...(item.cvss !== undefined ? { cvss: item.cvss } : {}),
        publishedAt,
        updatedAt: timeOf(item.updatedAt, publishedAt),
        source: "github",
        ...(item.url ? { url: item.url } : {}),
        ...(item.description ? { summary: item.description.slice(0, 500) } : {}),
      },
    ]
  })

export const normalizeEpss = (items: ReadonlyArray<EpssRaw>, now: number): ReadonlyArray<Advisory> =>
  items.flatMap((item) => {
    if (!item.cve) return []
    const severity = item.epss >= 0.9 ? "critical" : item.epss >= 0.7 ? "high" : item.epss >= 0.4 ? "medium" : "low"
    const publishedAt = timeOf(item.date, now)
    return [
      {
        id: item.cve,
        title: `${item.cve} (EPSS ${item.epss.toFixed(3)})`,
        severity,
        publishedAt,
        updatedAt: publishedAt,
        source: "epss",
        url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(item.cve)}`,
        summary: `EPSS ${item.epss.toFixed(3)} (percentile ${item.percentile.toFixed(3)}) as of ${item.date}.`,
      } satisfies Advisory,
    ]
  })

export const normalizeRss = (items: ReadonlyArray<RssRaw>, source: string, now: number): ReadonlyArray<NewsItem> =>
  items.flatMap((item) => {
    if (!item.title || !item.link) return []
    return [
      {
        id: item.link,
        title: item.title,
        url: item.link,
        publishedAt: timeOf(item.pubDate, now),
        source,
        ...(item.description ? { summary: item.description.slice(0, 500) } : {}),
      },
    ]
  })

const byNewest = (a: { publishedAt: number }, b: { publishedAt: number }) => b.publishedAt - a.publishedAt

const dedupeAdvisories = (items: ReadonlyArray<Advisory>): ReadonlyArray<Advisory> => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

export interface PollResult {
  readonly cache: Cache
}

export const pollOnce = (fetchFn: FetchFn = defaultFetch, now: number = Date.now()): Effect.Effect<PollResult> =>
  Effect.gen(function* () {
    const feeds = yield* readEffectiveFeeds()
    const previous = yield* readCache()
    const statuses: Array<FeedStatus> = []
    const kevItems: Array<KevItem> = []
    const advisories: Array<Advisory> = []
    const newsItems: Array<NewsItem> = []
    let kevAttempted = false
    let kevFailed = false
    let advisoriesAttempted = false
    let advisoriesFailed = false
    let newsAttempted = false
    let newsFailed = false
    const fail = (feed: Feed, error: unknown) =>
      statuses.push({ feedID: feed.id, lastPollAt: now, lastOk: false, lastError: String(error) })

    for (const feed of feeds) {
      if (!feed.enabled) continue
      if (feed.kind === "kev") {
        kevAttempted = true
        const result = yield* attempt(() => fetchKev(fetchFn, feed.url))
        if (result.ok) {
          const items = normalizeKev(result.value)
          kevItems.push(...items)
          statuses.push({ feedID: feed.id, lastPollAt: now, lastOk: true, itemCount: items.length })
        } else {
          kevFailed = true
          fail(feed, result.error)
        }
      } else if (feed.kind === "nvd") {
        advisoriesAttempted = true
        const result = yield* attempt(() => fetchNvd(fetchFn, now, feed.url))
        if (result.ok) {
          const items = normalizeNvd(result.value, now)
          advisories.push(...items)
          statuses.push({ feedID: feed.id, lastPollAt: now, lastOk: true, itemCount: items.length })
        } else {
          advisoriesFailed = true
          fail(feed, result.error)
        }
      } else if (feed.kind === "epss") {
        advisoriesAttempted = true
        const result = yield* attempt(() => fetchEpss(fetchFn, feed.url))
        if (result.ok) {
          const items = normalizeEpss(result.value, now)
          advisories.push(...items)
          statuses.push({ feedID: feed.id, lastPollAt: now, lastOk: true, itemCount: items.length })
        } else {
          advisoriesFailed = true
          fail(feed, result.error)
        }
      } else if (feed.kind === "github") {
        advisoriesAttempted = true
        const result = yield* attempt(() => fetchGitHubAdvisories(fetchFn, feed.url))
        if (result.ok) {
          const items = normalizeGitHub(result.value, now)
          advisories.push(...items)
          statuses.push({ feedID: feed.id, lastPollAt: now, lastOk: true, itemCount: items.length })
        } else {
          advisoriesFailed = true
          fail(feed, result.error)
        }
      } else {
        newsAttempted = true
        const result = yield* attempt(() => fetchRss(feed.url, fetchFn))
        if (result.ok) {
          const items = normalizeRss(result.value, feed.name, now)
          newsItems.push(...items)
          statuses.push({ feedID: feed.id, lastPollAt: now, lastOk: true, itemCount: items.length })
        } else {
          newsFailed = true
          fail(feed, result.error)
        }
      }
    }

    // A failed feed keeps its previous items instead of wiping them; a
    // disabled feed contributes nothing. lastPollAt only advances when at
    // least one feed succeeded, so a total failure stays stale and retries
    // instead of blacking out for 6h behind an emptied cache.
    const cache: Cache = {
      advisories:
        advisoriesAttempted && !advisoriesFailed
          ? dedupeAdvisories([...advisories].sort(byNewest))
          : advisoriesAttempted
            ? [...previous.advisories]
            : [],
      kev:
        kevAttempted && !kevFailed
          ? [...kevItems].sort((a, b) => b.dateAdded - a.dateAdded)
          : kevAttempted
            ? [...previous.kev]
            : [],
      news: newsAttempted && !newsFailed ? [...newsItems].sort(byNewest) : newsAttempted ? [...previous.news] : [],
      ...(statuses.some((status) => status.lastOk)
        ? { lastPollAt: now }
        : previous.lastPollAt !== undefined
          ? { lastPollAt: previous.lastPollAt }
          : {}),
      feeds: statuses,
    }
    yield* writeCacheFile(cache)
    return { cache }
  })

export type IntelOrder = "asc" | "desc"

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

const dir = (order?: IntelOrder) => (order === "asc" ? 1 : -1)

// Missing values trail sorted rows in both directions.
const trailing = <T>(a: T | undefined, b: T | undefined, compare: (a: T, b: T) => number) =>
  a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : compare(a, b)

export const sortAdvisories = (items: ReadonlyArray<Advisory>, sort?: string, order?: IntelOrder) => {
  const sign = dir(order)
  switch (sort) {
    case "severity":
      return [...items].sort((a, b) => sign * (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]))
    case "cvss":
      return [...items].sort((a, b) => trailing(a.cvss, b.cvss, (x, y) => sign * (x - y)))
    case "source":
      return [...items].sort((a, b) => sign * a.source.localeCompare(b.source) || b.publishedAt - a.publishedAt)
    case "title":
      return [...items].sort((a, b) => sign * a.title.localeCompare(b.title))
    case "publishedAt":
      return [...items].sort((a, b) => sign * (a.publishedAt - b.publishedAt))
    default:
      return items
  }
}

export const sortKev = (items: ReadonlyArray<KevItem>, sort?: string, order?: IntelOrder) => {
  const sign = dir(order)
  switch (sort) {
    case "cveID":
      return [...items].sort((a, b) => sign * a.cveID.localeCompare(b.cveID))
    case "name":
      return [...items].sort((a, b) => sign * a.name.localeCompare(b.name))
    case "vendor":
      return [...items].sort(
        (a, b) =>
          sign * `${a.vendor} / ${a.product}`.localeCompare(`${b.vendor} / ${b.product}`) ||
          b.dateAdded - a.dateAdded,
      )
    case "dateAdded":
      return [...items].sort((a, b) => sign * (a.dateAdded - b.dateAdded))
    case "dueDate":
      return [...items].sort((a, b) => trailing(a.dueDate, b.dueDate, (x, y) => sign * (x - y)))
    default:
      return items
  }
}

export const sortNews = (items: ReadonlyArray<NewsItem>, sort?: string, order?: IntelOrder) => {
  const sign = dir(order)
  switch (sort) {
    case "source":
      return [...items].sort((a, b) => sign * a.source.localeCompare(b.source) || b.publishedAt - a.publishedAt)
    case "title":
      return [...items].sort((a, b) => sign * a.title.localeCompare(b.title))
    case "publishedAt":
      return [...items].sort((a, b) => sign * (a.publishedAt - b.publishedAt))
    default:
      return items
  }
}

export const paginate = <T>(items: ReadonlyArray<T>, page?: number, pageSize?: number) => {
  const safePage = page !== undefined && Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
  const safeSize =
    pageSize !== undefined && Number.isFinite(pageSize) ? Math.min(100, Math.max(1, Math.floor(pageSize))) : 25
  const total = items.length
  const start = (safePage - 1) * safeSize
  return { items: items.slice(start, start + safeSize), total, page: safePage, pageSize: safeSize }
}

export const nextPollAt = (lastPollAt?: number) =>
  lastPollAt === undefined ? undefined : lastPollAt + POLL_INTERVAL_MS

export const trendPoints = (advisories: ReadonlyArray<Advisory>, days: number, now: number) => {
  const windowDays = Number.isFinite(days) ? Math.min(90, Math.max(7, Math.floor(days))) : 14
  const counts = new Map<string, number>()
  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = new Date(now - offset * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
    counts.set(date, 0)
  }
  for (const item of advisories) {
    const date = new Date(item.publishedAt).toISOString().slice(0, 10)
    if (counts.has(date)) counts.set(date, (counts.get(date) ?? 0) + 1)
  }
  return {
    points: [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, count]) => ({ date, count })),
    windowDays,
  }
}
