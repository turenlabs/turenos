import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, IntelFeedNotFoundError, InvalidRequestError } from "../errors"

export const Severity = Schema.Literals(["critical", "high", "medium", "low", "info"]).annotate({
  identifier: "Intel.Severity",
})
export type Severity = typeof Severity.Type

export const Advisory = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  severity: Severity,
  cvss: Schema.optional(Schema.Number),
  publishedAt: Schema.Number,
  updatedAt: Schema.Number,
  source: Schema.String,
  url: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
}).annotate({ identifier: "Intel.Advisory" })
export type Advisory = typeof Advisory.Type

export const AdvisoriesPage = Schema.Struct({
  items: Schema.Array(Advisory),
  total: Schema.Int,
  page: Schema.Int,
  pageSize: Schema.Int,
}).annotate({ identifier: "Intel.AdvisoriesPage" })
export type AdvisoriesPage = typeof AdvisoriesPage.Type

export const KevItem = Schema.Struct({
  cveID: Schema.String,
  vendor: Schema.String,
  product: Schema.String,
  name: Schema.String,
  dateAdded: Schema.Number,
  dueDate: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
}).annotate({ identifier: "Intel.KevItem" })
export type KevItem = typeof KevItem.Type

export const KevPage = Schema.Struct({
  items: Schema.Array(KevItem),
  total: Schema.Int,
  page: Schema.Int,
  pageSize: Schema.Int,
}).annotate({ identifier: "Intel.KevPage" })
export type KevPage = typeof KevPage.Type

export const NewsItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  publishedAt: Schema.Number,
  source: Schema.String,
  summary: Schema.optional(Schema.String),
}).annotate({ identifier: "Intel.NewsItem" })
export type NewsItem = typeof NewsItem.Type

export const NewsPage = Schema.Struct({
  items: Schema.Array(NewsItem),
  total: Schema.Int,
  page: Schema.Int,
  pageSize: Schema.Int,
}).annotate({ identifier: "Intel.NewsPage" })
export type NewsPage = typeof NewsPage.Type

export const TrendPoint = Schema.Struct({
  date: Schema.String,
  count: Schema.Number,
}).annotate({ identifier: "Intel.TrendPoint" })
export type TrendPoint = typeof TrendPoint.Type

export const TrendsResponse = Schema.Struct({
  points: Schema.Array(TrendPoint),
  windowDays: Schema.Number,
}).annotate({ identifier: "Intel.TrendsResponse" })
export type TrendsResponse = typeof TrendsResponse.Type

export const FeedKind = Schema.Literals(["kev", "nvd", "epss", "github", "rss"]).annotate({
  identifier: "Intel.FeedKind",
})
export type FeedKind = typeof FeedKind.Type

export const Feed = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: FeedKind,
  url: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "Intel.Feed" })
export type Feed = typeof Feed.Type

export const FeedStatus = Schema.Struct({
  feedID: Schema.String,
  lastPollAt: Schema.optional(Schema.Number),
  lastOk: Schema.optional(Schema.Boolean),
  lastError: Schema.optional(Schema.String),
  itemCount: Schema.optional(Schema.Number),
}).annotate({ identifier: "Intel.FeedStatus" })
export type FeedStatus = typeof FeedStatus.Type

export const StatusResponse = Schema.Struct({
  lastPollAt: Schema.optional(Schema.Number),
  nextPollAt: Schema.optional(Schema.Number),
  feeds: Schema.Array(FeedStatus),
}).annotate({ identifier: "Intel.StatusResponse" })
export type StatusResponse = typeof StatusResponse.Type

const SortOrder = Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])

const AdvisoriesQuery = Schema.Struct({
  page: Schema.optional(Schema.NumberFromString),
  pageSize: Schema.optional(Schema.NumberFromString),
  severity: Schema.optional(Severity),
  search: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.Literals(["publishedAt", "severity", "cvss", "source", "title"])),
  order: Schema.optional(SortOrder),
})

const KevQuery = Schema.Struct({
  page: Schema.optional(Schema.NumberFromString),
  pageSize: Schema.optional(Schema.NumberFromString),
  sort: Schema.optional(Schema.Literals(["cveID", "name", "vendor", "dateAdded", "dueDate"])),
  order: Schema.optional(SortOrder),
})

const NewsQuery = Schema.Struct({
  page: Schema.optional(Schema.NumberFromString),
  pageSize: Schema.optional(Schema.NumberFromString),
  sort: Schema.optional(Schema.Literals(["source", "title", "publishedAt"])),
  order: Schema.optional(SortOrder),
})

const TrendsQuery = Schema.Struct({
  days: Schema.optional(Schema.NumberFromString),
})

export const FeedUpdate = Schema.Struct({
  name: Schema.optional(Schema.String),
  kind: Schema.optional(FeedKind),
  url: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Intel.FeedUpdate" })
export type FeedUpdate = typeof FeedUpdate.Type

export const FeedCreate = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  kind: FeedKind,
  url: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Intel.FeedCreate" })
export type FeedCreate = typeof FeedCreate.Type

export const IntelGroup = HttpApiGroup.make("server.intel")
  .add(
    HttpApiEndpoint.get("intel.advisories", "/api/intel/advisories", {
      query: AdvisoriesQuery,
      success: AdvisoriesPage,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.advisories",
        summary: "List security advisories",
        description: "List cached normalized security advisories newest first.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("intel.kev", "/api/intel/kev", {
      query: KevQuery,
      success: KevPage,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.kev",
        summary: "List KEV items",
        description: "List cached CISA KEV items newest first.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("intel.news", "/api/intel/news", {
      query: NewsQuery,
      success: NewsPage,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.news",
        summary: "List security news",
        description: "List cached security news newest first.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("intel.trends", "/api/intel/trends", {
      query: TrendsQuery,
      success: TrendsResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.trends",
        summary: "Advisory trends",
        description: "Daily advisory counts over a trailing window.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("intel.feeds", "/api/intel/feeds", {
      success: Schema.Array(Feed),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.feeds",
        summary: "List intel feeds",
        description: "List the effective intel feed list: built-in defaults plus per-user overrides.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("intel.feedAdd", "/api/intel/feeds", {
      payload: FeedCreate,
      success: Feed,
      error: [InvalidRequestError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.feedAdd",
        summary: "Add intel feed",
        description: "Add a custom intel feed. The id is derived from the name when omitted.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("intel.feedUpdate", "/api/intel/feeds/:feedID", {
      params: Schema.Struct({ feedID: Schema.String }),
      payload: FeedUpdate,
      success: Feed,
      error: [InvalidRequestError, IntelFeedNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.feedUpdate",
        summary: "Update intel feed",
        description: "Enable, disable, or edit an intel feed. Only provided fields change.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("intel.feedsReset", "/api/intel/feeds/reset", {
      success: Schema.Array(Feed),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.feedsReset",
        summary: "Reset intel feeds",
        description: "Discard per-user feed overrides and restore the built-in defaults.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("intel.status", "/api/intel/status", {
      success: StatusResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.status",
        summary: "Intel poll status",
        description: "Last poll times and per-feed status.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("intel.poll", "/api/intel/poll", {
      success: StatusResponse,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.intel.poll",
        summary: "Poll intel feeds now",
        description: "Force an immediate feed poll (overlap-guarded, staleness ignored) and return the fresh status.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "intel",
      description: "Cached security intelligence (zero-config reads, per-user feed settings).",
    }),
  )
