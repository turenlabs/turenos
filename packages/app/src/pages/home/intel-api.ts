import type {
  Forge,
  ServerIntelAdvisoriesOutput,
  ServerIntelFeedAddOutput,
  ServerIntelFeedsOutput,
  ServerIntelFeedsResetOutput,
  ServerIntelFeedUpdateOutput,
  ServerIntelKevOutput,
  ServerIntelNewsOutput,
  ServerIntelPollOutput,
  ServerIntelStatusOutput,
} from "@turenlabs/client"

export type IntelSeverity = "critical" | "high" | "medium" | "low" | "info"
export type IntelSortOrder = "asc" | "desc"
export type AdvisorySort = "publishedAt" | "severity" | "cvss" | "source" | "title"
export type KevSort = "cveID" | "name" | "vendor" | "dateAdded" | "dueDate"
export type NewsSort = "source" | "title" | "publishedAt"
export type AdvisoriesPage = ServerIntelAdvisoriesOutput
export type KevPage = ServerIntelKevOutput
export type NewsPage = ServerIntelNewsOutput
export type IntelFeed = ServerIntelFeedsOutput[number]
export type IntelStatus = ServerIntelStatusOutput
export type Advisory = AdvisoriesPage["items"][number]
export type KevItem = KevPage["items"][number]
export type NewsItem = NewsPage["items"][number]

/** Mirrors the server poll cadence (`POLL_INTERVAL_MS` in `packages/server/src/intel`). */
export const INTEL_POLL_INTERVAL_MS = 6 * 60 * 60 * 1_000

export type AdvisoriesQuery = {
  readonly page?: number
  readonly pageSize?: number
  readonly severity?: IntelSeverity
  readonly search?: string
  readonly sort?: AdvisorySort
  readonly order?: IntelSortOrder
}

export type KevQuery = {
  readonly page?: number
  readonly pageSize?: number
  readonly sort?: KevSort
  readonly order?: IntelSortOrder
}

export type NewsQuery = {
  readonly page?: number
  readonly pageSize?: number
  readonly sort?: NewsSort
  readonly order?: IntelSortOrder
}

export type IntelFeedKind = IntelFeed["kind"]

export type FeedPatch = {
  readonly name?: string
  readonly kind?: IntelFeedKind
  readonly url?: string
  readonly enabled?: boolean
}

export type FeedCreate = {
  readonly id?: string
  readonly name: string
  readonly kind: IntelFeedKind
  readonly url: string
  readonly enabled?: boolean
}

export type IntelApi = {
  advisories: (input?: AdvisoriesQuery) => Promise<AdvisoriesPage>
  kev: (input?: KevQuery) => Promise<KevPage>
  news: (input?: NewsQuery) => Promise<NewsPage>
  feeds: () => Promise<readonly IntelFeed[]>
  status: () => Promise<IntelStatus>
  poll: () => Promise<ServerIntelPollOutput>
  updateFeed: (feedID: string, patch: FeedPatch) => Promise<ServerIntelFeedUpdateOutput>
  addFeed: (input: FeedCreate) => Promise<ServerIntelFeedAddOutput>
  resetFeeds: () => Promise<ServerIntelFeedsResetOutput>
}

type Response<T> = Promise<{ data?: T | { data: T } }>

/**
 * Unwrap a heyapi-style `{ data }` envelope (see `loops/api.ts`). The
 * protocol client (`Forge.make`) returns decoded outputs directly, so values
 * without a top-level `data` key pass through untouched.
 */
function intelData<T>(response: { data?: T | { data: T } }): T {
  const data = response.data
  if (data && typeof data === "object" && !Array.isArray(data) && "data" in data) return (data as { data: T }).data
  if (data === undefined) throw new Error("Intel API returned no data")
  return data
}

/**
 * Thin wrapper over the generated intel client. Prefers the protocol client
 * (`Forge.make`, which already carries `server.intel`) and falls back to a
 * heyapi SDK client (`v2.intel`) once the SDK is regenerated from the
 * OpenAPI contract — mirroring `loopApi` in `loops/api.ts`.
 */
export function intelApi(client: unknown): IntelApi {
  const shaped = client as {
    readonly "server.intel"?: {
      readonly advisories: (input?: AdvisoriesQuery) => Promise<AdvisoriesPage>
      readonly kev: (input?: KevQuery) => Promise<KevPage>
      readonly news: (input?: NewsQuery) => Promise<NewsPage>
      readonly feeds: () => Promise<readonly IntelFeed[]>
      readonly status: () => Promise<IntelStatus>
      readonly poll: () => Promise<ServerIntelPollOutput>
      readonly feedUpdate: (input: { feedID: string } & FeedPatch) => Promise<ServerIntelFeedUpdateOutput>
      readonly feedAdd: (input: FeedCreate) => Promise<ServerIntelFeedAddOutput>
      readonly feedsReset: () => Promise<ServerIntelFeedsResetOutput>
    }
    readonly v2?: {
      readonly intel?: {
        readonly advisories: (input?: AdvisoriesQuery) => Response<AdvisoriesPage>
        readonly kev: (input?: KevQuery) => Response<KevPage>
        readonly news: (input?: NewsQuery) => Response<NewsPage>
        readonly feeds: () => Response<readonly IntelFeed[]>
        readonly status: () => Response<IntelStatus>
        readonly poll: () => Response<ServerIntelPollOutput>
        readonly feedUpdate: (input: { feedID: string } & FeedPatch) => Response<ServerIntelFeedUpdateOutput>
        readonly feedAdd: (input: FeedCreate) => Response<ServerIntelFeedAddOutput>
        readonly feedsReset: () => Response<ServerIntelFeedsResetOutput>
      }
    }
  }
  const protocol = shaped?.["server.intel"]
  if (protocol) {
    return {
      advisories: (input) => protocol.advisories(input),
      kev: (input) => protocol.kev(input),
      news: (input) => protocol.news(input),
      feeds: () => protocol.feeds(),
      status: () => protocol.status(),
      poll: () => protocol.poll(),
      updateFeed: (feedID, patch) => protocol.feedUpdate({ feedID, ...patch }),
      addFeed: (input) => protocol.feedAdd(input),
      resetFeeds: () => protocol.feedsReset(),
    } satisfies IntelApi
  }
  const sdk = shaped?.v2?.intel
  if (sdk) {
    return {
      advisories: (input) => sdk.advisories(input).then(intelData),
      kev: (input) => sdk.kev(input).then(intelData),
      news: (input) => sdk.news(input).then(intelData),
      feeds: () => sdk.feeds().then(intelData),
      status: () => sdk.status().then(intelData),
      poll: () => sdk.poll().then(intelData),
      updateFeed: (feedID, patch) => sdk.feedUpdate({ feedID, ...patch }).then(intelData),
      addFeed: (input) => sdk.feedAdd(input).then(intelData),
      resetFeeds: () => sdk.feedsReset().then(intelData),
    } satisfies IntelApi
  }
  throw new Error("Intel API is not available on this server client")
}

export type ProtocolIntelClient = ReturnType<typeof Forge.make>

/** True when the cache has never been polled or the last poll is older than the interval. */
export function isIntelStale(
  lastPollAt: number | undefined,
  now = Date.now(),
  staleAfterMs = INTEL_POLL_INTERVAL_MS,
): boolean {
  if (lastPollAt === undefined || !Number.isFinite(lastPollAt)) return true
  return now - lastPollAt > staleAfterMs
}

/** Short relative age in the same vocabulary as `relativeAgo` in `loops/latest-runs`. */
export function intelAgeLabel(now: number, timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "never updated"
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

const SEVERITY_TONE: Record<IntelSeverity, string> = {
  critical: "bg-v2-state-fg-danger",
  high: "bg-v2-state-fg-danger",
  medium: "bg-v2-state-fg-warning",
  low: "bg-v2-text-text-faint",
  info: "bg-v2-text-text-faint",
}

/** Status-dot fill class for an advisory severity. */
export function severityDot(severity: IntelSeverity): string {
  return SEVERITY_TONE[severity] ?? "bg-v2-text-text-faint"
}
