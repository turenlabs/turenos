import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { addFeed, readEffectiveFeeds, resetFeeds, updateFeed } from "../intel/feeds"
import { nextPollAt, paginate, readCache, trendPoints } from "../intel/ingest"
import { pollNow } from "../intel/scheduler"

const readStatus = Effect.gen(function* () {
  const cache = yield* readCache()
  return {
    ...(cache.lastPollAt !== undefined ? { lastPollAt: cache.lastPollAt } : {}),
    ...(cache.lastPollAt !== undefined ? { nextPollAt: nextPollAt(cache.lastPollAt) } : {}),
    feeds: [...cache.feeds],
  }
})

export const IntelHandler = HttpApiBuilder.group(Api, "server.intel", (handlers) =>
  handlers
    .handle("intel.advisories", (ctx) =>
      Effect.gen(function* () {
        const cache = yield* readCache()
        const severity = ctx.query.severity
        const search = ctx.query.search?.toLowerCase()
        const filtered = cache.advisories.filter((item) => {
          if (severity && item.severity !== severity) return false
          if (search && !`${item.id} ${item.title} ${item.summary ?? ""}`.toLowerCase().includes(search)) return false
          return true
        })
        return paginate(filtered, ctx.query.page, ctx.query.pageSize)
      }),
    )
    .handle("intel.kev", (ctx) =>
      Effect.gen(function* () {
        const cache = yield* readCache()
        return paginate(cache.kev, ctx.query.page, ctx.query.pageSize)
      }),
    )
    .handle("intel.news", (ctx) =>
      Effect.gen(function* () {
        const cache = yield* readCache()
        return paginate(cache.news, ctx.query.page, ctx.query.pageSize)
      }),
    )
    .handle("intel.trends", (ctx) =>
      Effect.gen(function* () {
        const cache = yield* readCache()
        return trendPoints(cache.advisories, ctx.query.days ?? 14, Date.now())
      }),
    )
    .handle("intel.feeds", () =>
      Effect.gen(function* () {
        return yield* readEffectiveFeeds()
      }),
    )
    .handle("intel.feedAdd", (ctx) =>
      Effect.gen(function* () {
        return yield* addFeed({
          ...(ctx.payload.id !== undefined ? { id: ctx.payload.id } : {}),
          name: ctx.payload.name,
          kind: ctx.payload.kind,
          url: ctx.payload.url,
          ...(ctx.payload.enabled !== undefined ? { enabled: ctx.payload.enabled } : {}),
        })
      }),
    )
    .handle("intel.feedUpdate", (ctx) =>
      Effect.gen(function* () {
        return yield* updateFeed(ctx.params.feedID, {
          ...(ctx.payload.name !== undefined ? { name: ctx.payload.name } : {}),
          ...(ctx.payload.kind !== undefined ? { kind: ctx.payload.kind } : {}),
          ...(ctx.payload.url !== undefined ? { url: ctx.payload.url } : {}),
          ...(ctx.payload.enabled !== undefined ? { enabled: ctx.payload.enabled } : {}),
        })
      }),
    )
    .handle("intel.feedsReset", () =>
      Effect.gen(function* () {
        return yield* resetFeeds()
      }),
    )
    .handle("intel.status", () => readStatus)
    .handle("intel.poll", () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => pollNow())
        return yield* readStatus
      }),
    ),
)
