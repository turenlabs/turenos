import type { Feed } from "@turenlabs/protocol/groups/intel"

export const POLL_INTERVAL_MS = 6 * 60 * 60 * 1_000

export const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
export const NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0/"
export const EPSS_URL = "https://api.first.org/data/v1/epss"
export const GITHUB_ADVISORIES_URL = "https://api.github.com/advisories"
export const FETCH_TIMEOUT_MS = 15_000

export const DEFAULT_FEEDS: ReadonlyArray<Feed> = [
  { id: "kev", name: "CISA KEV", kind: "kev", url: KEV_URL, enabled: true },
  { id: "nvd", name: "NVD (last 7d)", kind: "nvd", url: NVD_URL, enabled: true },
  { id: "epss", name: "EPSS", kind: "epss", url: EPSS_URL, enabled: true },
  { id: "github", name: "GitHub Advisories", kind: "github", url: GITHUB_ADVISORIES_URL, enabled: true },
  {
    id: "cisa-news",
    name: "CISA News",
    kind: "rss",
    url: "https://www.cisa.gov/news.xml",
    enabled: true,
  },
  {
    id: "bleepingcomputer",
    name: "BleepingComputer",
    kind: "rss",
    url: "https://www.bleepingcomputer.com/feed/",
    enabled: true,
  },
  {
    id: "thehackernews",
    name: "The Hacker News",
    kind: "rss",
    url: "https://feeds.feedburner.com/TheHackersNews",
    enabled: true,
  },
  {
    id: "sans-isc",
    name: "SANS ISC",
    kind: "rss",
    url: "https://isc.sans.edu/rssfeed_full.xml",
    enabled: true,
  },
  {
    id: "darkreading",
    name: "Dark Reading",
    kind: "rss",
    url: "https://www.darkreading.com/rss.xml",
    enabled: true,
  },
  {
    id: "greynoise",
    name: "GreyNoise",
    kind: "rss",
    url: "https://www.greynoise.io/blog/rss.xml",
    enabled: true,
  },
  {
    id: "stepsecurity",
    name: "StepSecurity",
    kind: "rss",
    url: "https://www.stepsecurity.io/blog/rss.xml",
    enabled: true,
  },
]

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export const defaultFetch: FetchFn = (url, init) => fetch(url, init)

export interface KevRaw {
  readonly cveID: string
  readonly vendorProject: string
  readonly product: string
  readonly vulnerabilityName: string
  readonly dateAdded: string
  readonly dueDate?: string
  readonly shortDescription: string
}

export interface NvdRaw {
  readonly id: string
  readonly description: string
  readonly published: string
  readonly lastModified: string
  readonly source: string
  readonly cvss?: number
  readonly severity?: string
}

export interface EpssRaw {
  readonly cve: string
  readonly epss: number
  readonly percentile: number
  readonly date: string
}

export interface GitHubAdvisoryRaw {
  readonly id: string
  readonly summary: string
  readonly description: string
  readonly severity: string
  readonly cvss?: number
  readonly publishedAt: string
  readonly updatedAt: string
  readonly url: string
}

export interface RssRaw {
  readonly title: string
  readonly link: string
  readonly pubDate: string
  readonly description?: string
}

const json = async (response: Response) => {
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
  return response.json() as Promise<unknown>
}

const text = async (response: Response) => {
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
  return response.text()
}

// Keep the deadline around response parsing too: a server can send headers and
// then hold the poll open forever while its body remains incomplete.
const request = async <T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`feed fetch timed out after ${FETCH_TIMEOUT_MS}ms`))
      reject(new Error(`feed fetch timed out after ${FETCH_TIMEOUT_MS}ms`))
    }, FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race<T>([fetchFn(url, { ...init, signal: controller.signal }).then(read), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const num = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback
}

const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback)

export const fetchKev = async (
  fetchFn: FetchFn = defaultFetch,
  url: string = KEV_URL,
): Promise<ReadonlyArray<KevRaw>> => {
  const body = (await request(fetchFn, url, { headers: { accept: "application/json" } }, json)) as {
    vulnerabilities?: ReadonlyArray<Record<string, unknown>>
  }
  const list = Array.isArray(body.vulnerabilities) ? body.vulnerabilities : []
  return list.map((item) => ({
    cveID: str(item.cveID),
    vendorProject: str(item.vendorProject),
    product: str(item.product),
    vulnerabilityName: str(item.vulnerabilityName),
    dateAdded: str(item.dateAdded),
    dueDate: typeof item.dueDate === "string" ? item.dueDate : undefined,
    shortDescription: str(item.shortDescription),
  }))
}

export const fetchNvd = async (
  fetchFn: FetchFn = defaultFetch,
  now = Date.now(),
  baseUrl: string = NVD_URL,
): Promise<ReadonlyArray<NvdRaw>> => {
  const end = new Date(now).toISOString()
  const start = new Date(now - 7 * 24 * 60 * 60 * 1_000).toISOString()
  const url = new URL(baseUrl)
  url.searchParams.set("lastModStartDate", start)
  url.searchParams.set("lastModEndDate", end)
  const body = (await request(fetchFn, url.toString(), { headers: { accept: "application/json" } }, json)) as {
    vulnerabilities?: ReadonlyArray<{ cve?: Record<string, unknown> }>
  }
  const list = Array.isArray(body.vulnerabilities) ? body.vulnerabilities : []
  return list.flatMap(({ cve }) => {
    if (!cve) return []
    const id = str(cve.id)
    if (!id) return []
    const descriptions = Array.isArray(cve.descriptions)
      ? (cve.descriptions as ReadonlyArray<Record<string, unknown>>)
      : []
    const en = descriptions.find((entry) => entry.lang === "en")
    const metrics = (cve.metrics ?? {}) as Record<string, unknown>
    const cvssData = (metrics.cvssMetricV31 ?? metrics.cvssMetricV30 ?? metrics.cvssMetricV2 ?? []) as ReadonlyArray<{
      cvssData?: { baseScore?: unknown; baseSeverity?: unknown }
    }>
    const first = Array.isArray(cvssData) ? cvssData[0]?.cvssData : undefined
    return [
      {
        id,
        description: str(en?.value ?? descriptions[0]?.value),
        published: str(cve.published),
        lastModified: str(cve.lastModified),
        source: str(cve.sourceIdentifier),
        cvss: typeof first?.baseScore === "number" ? first.baseScore : undefined,
        severity: typeof first?.baseSeverity === "string" ? first.baseSeverity.toLowerCase() : undefined,
      },
    ]
  })
}

export const fetchEpss = async (
  fetchFn: FetchFn = defaultFetch,
  baseUrl: string = EPSS_URL,
): Promise<ReadonlyArray<EpssRaw>> => {
  const separator = baseUrl.includes("?") ? "&" : "?"
  const body = (await request(
    fetchFn,
    `${baseUrl}${separator}limit=100`,
    {
      headers: { accept: "application/json" },
    },
    json,
  )) as {
    data?: ReadonlyArray<Record<string, unknown>>
  }
  const list = Array.isArray(body.data) ? body.data : []
  return list.map((item) => ({
    cve: str(item.cve),
    epss: num(item.epss),
    percentile: num(item.percentile),
    date: str(item.date),
  }))
}

export const fetchGitHubAdvisories = async (
  fetchFn: FetchFn = defaultFetch,
  baseUrl: string = GITHUB_ADVISORIES_URL,
): Promise<ReadonlyArray<GitHubAdvisoryRaw>> => {
  const separator = baseUrl.includes("?") ? "&" : "?"
  const body = (await request(
    fetchFn,
    `${baseUrl}${separator}type=reviewed&per_page=50`,
    {
      headers: { accept: "application/vnd.github+json" },
    },
    json,
  )) as unknown
  const list = Array.isArray(body) ? (body as ReadonlyArray<Record<string, unknown>>) : []
  return list.map((item) => ({
    id: str(item.ghsa_id ?? item.id),
    summary: str(item.summary),
    description: str(item.description),
    severity: str(item.severity, "unknown"),
    cvss:
      typeof (item.cvss as Record<string, unknown> | undefined)?.score === "number"
        ? ((item.cvss as Record<string, unknown>).score as number)
        : undefined,
    publishedAt: str(item.published_at),
    updatedAt: str(item.updated_at),
    url: str(item.html_url),
  }))
}

export const fetchRss = async (url: string, fetchFn: FetchFn = defaultFetch): Promise<ReadonlyArray<RssRaw>> =>
  parseRss(await request(fetchFn, url, { headers: { accept: "application/rss+xml, application/xml" } }, text))

export function parseRss(xml: string): ReadonlyArray<RssRaw> {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []
  return items.flatMap((block) => {
    const field = (tag: string) => {
      const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"))
      if (!match) return ""
      return match[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, "")
        .trim()
    }
    const title = field("title")
    const link = field("link")
    if (!title || !link) return []
    return [
      {
        title,
        link,
        pubDate: field("pubDate") || field("published") || field("updated"),
        description: field("description") || undefined,
      },
    ]
  })
}
