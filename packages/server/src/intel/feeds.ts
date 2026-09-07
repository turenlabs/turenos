import { Global } from "@turenlabs/core/global"
import { Flock } from "@turenlabs/core/util/flock"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import type { Feed, FeedKind } from "@turenlabs/protocol/groups/intel"
import { ConflictError, IntelFeedNotFoundError, InvalidRequestError } from "@turenlabs/protocol/errors"
import { DEFAULT_FEEDS } from "./sources"

export const FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
export const MAX_FEED_ID_LENGTH = 64
export const MAX_FEED_NAME_LENGTH = 120

/** Per-user overrides live next to the intel cache (per-OS-user state dir). */
export const feedsConfigPath = () => path.join(Global.Path.state, "intel-feeds.json")

export const isFeedKind = (value: unknown): value is FeedKind =>
  value === "kev" || value === "nvd" || value === "epss" || value === "github" || value === "rss"

export const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export const slugifyFeedID = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_FEED_ID_LENGTH)
    .replace(/-+$/g, "")
  return slug || "feed"
}

export const uniqueFeedID = (feeds: ReadonlyArray<Feed>, base: string): string => {
  const taken = new Set(feeds.map((feed) => feed.id))
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = String(suffix)
    const candidate = `${base.slice(0, MAX_FEED_ID_LENGTH - suffixText.length - 1)}-${suffixText}`
    if (!taken.has(candidate)) return candidate
  }
}

const sanitizeFeed = (value: unknown): Feed | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || !FEED_ID_PATTERN.test(record.id) || record.id.length > MAX_FEED_ID_LENGTH) {
    return undefined
  }
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MAX_FEED_NAME_LENGTH) {
    return undefined
  }
  if (!isFeedKind(record.kind)) return undefined
  if (typeof record.url !== "string" || !isHttpUrl(record.url)) return undefined
  if (typeof record.enabled !== "boolean") return undefined
  return { id: record.id, name: record.name, kind: record.kind, url: record.url, enabled: record.enabled }
}

/**
 * Pull a stored feed list out of unknown JSON. Returns undefined when there is
 * no usable stored config, so callers fall back to the built-in defaults
 * without writing anything (lazy defaults).
 */
export const sanitizeFeedList = (value: unknown): Array<Feed> | undefined => {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).feeds)
      ? (value as Record<string, unknown>).feeds
      : undefined
  if (!Array.isArray(list)) return undefined
  return list.flatMap((entry) => {
    const feed = sanitizeFeed(entry)
    return feed ? [feed] : []
  })
}

export interface FeedPatch {
  readonly name?: string
  readonly kind?: FeedKind
  readonly url?: string
  readonly enabled?: boolean
}

export interface FeedCreateInput {
  readonly id?: string
  readonly name: string
  readonly kind: FeedKind
  readonly url: string
  readonly enabled?: boolean
}

const invalid = (message: string) => new InvalidRequestError({ message })

export const validateFeedPatch = (patch: FeedPatch): string | undefined => {
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > MAX_FEED_NAME_LENGTH)) {
    return "Feed name must be non-empty (max 120 characters)"
  }
  if (patch.kind !== undefined && !isFeedKind(patch.kind)) {
    return "Feed kind must be one of kev, nvd, epss, github, rss"
  }
  if (patch.url !== undefined && !isHttpUrl(patch.url)) {
    return "Feed URL must be an http(s) URL"
  }
  if (patch.name === undefined && patch.kind === undefined && patch.url === undefined && patch.enabled === undefined) {
    return "No feed fields to update"
  }
  return undefined
}

export const validateFeedCreate = (input: FeedCreateInput): string | undefined => {
  if (input.id !== undefined && (!FEED_ID_PATTERN.test(input.id) || input.id.length > MAX_FEED_ID_LENGTH)) {
    return "Feed id must match [a-z0-9-] (max 64 characters)"
  }
  if (!input.name.trim() || input.name.length > MAX_FEED_NAME_LENGTH) {
    return "Feed name must be non-empty (max 120 characters)"
  }
  if (!isFeedKind(input.kind)) return "Feed kind must be one of kev, nvd, epss, github, rss"
  if (!isHttpUrl(input.url)) return "Feed URL must be an http(s) URL"
  return undefined
}

/** Pure update: returns undefined when no feed matches. Assumes the patch validated. */
export const applyFeedUpdate = (
  feeds: ReadonlyArray<Feed>,
  feedID: string,
  patch: FeedPatch,
): { readonly feeds: Array<Feed>; readonly feed: Feed } | undefined => {
  const index = feeds.findIndex((feed) => feed.id === feedID)
  if (index === -1) return undefined
  const current = feeds[index]!
  const feed: Feed = {
    id: current.id,
    name: patch.name?.trim() ?? current.name,
    kind: patch.kind ?? current.kind,
    url: patch.url ?? current.url,
    enabled: patch.enabled ?? current.enabled,
  }
  const next = [...feeds]
  next[index] = feed
  return { feeds: next, feed }
}

/**
 * Pure add: returns undefined when the id is taken (explicit id) so callers
 * can surface a conflict. Derived ids are de-duplicated with a numeric suffix.
 */
export const applyFeedAdd = (feeds: ReadonlyArray<Feed>, input: FeedCreateInput): Feed | undefined => {
  if (input.id !== undefined) {
    if (feeds.some((feed) => feed.id === input.id)) return undefined
    return { id: input.id, name: input.name.trim(), kind: input.kind, url: input.url, enabled: input.enabled ?? true }
  }
  return {
    id: uniqueFeedID(feeds, slugifyFeedID(input.name)),
    name: input.name.trim(),
    kind: input.kind,
    url: input.url,
    enabled: input.enabled ?? true,
  }
}

const readStoredFeeds = (): Effect.Effect<Array<Feed> | undefined> =>
  Effect.promise(() =>
    fs.readFile(feedsConfigPath(), "utf8").then(
      (raw) => sanitizeFeedList(JSON.parse(raw) as unknown),
      () => undefined,
    ),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)))

const writeStoredFeeds = (feeds: ReadonlyArray<Feed>): Effect.Effect<void> =>
  Effect.promise(async () => {
    const target = feedsConfigPath()
    const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, feeds: [...feeds] }), "utf8")
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  })

const withFeedConfigLock = <A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise((signal) =>
      Flock.acquire("intel-feeds", { dir: path.join(Global.Path.state, "locks"), signal }),
    ).pipe(Effect.orDie),
    () => operation,
    (lock) => Effect.promise(() => lock.release()).pipe(Effect.orDie),
  )

/**
 * Effective feed list: stored per-user overrides when present, otherwise the
 * built-in defaults. A missing or corrupt config never writes — the defaults
 * stay lazy until the user changes something.
 */
export const readEffectiveFeeds = (): Effect.Effect<Array<Feed>> =>
  Effect.gen(function* () {
    const stored = yield* readStoredFeeds()
    if (stored === undefined) return [...DEFAULT_FEEDS]
    return stored
  })

export const updateFeed = (
  feedID: string,
  patch: FeedPatch,
): Effect.Effect<Feed, InvalidRequestError | IntelFeedNotFoundError> =>
  withFeedConfigLock(
    Effect.gen(function* () {
      const failure = validateFeedPatch(patch)
      if (failure !== undefined) return yield* Effect.fail(invalid(failure))
      const applied = applyFeedUpdate(yield* readEffectiveFeeds(), feedID, patch)
      if (!applied) {
        return yield* Effect.fail(new IntelFeedNotFoundError({ feedID, message: `Intel feed not found: ${feedID}` }))
      }
      yield* writeStoredFeeds(applied.feeds)
      return applied.feed
    }),
  )

export const addFeed = (input: FeedCreateInput): Effect.Effect<Feed, InvalidRequestError | ConflictError> =>
  withFeedConfigLock(
    Effect.gen(function* () {
      const failure = validateFeedCreate(input)
      if (failure !== undefined) return yield* Effect.fail(invalid(failure))
      const feeds = yield* readEffectiveFeeds()
      const feed = applyFeedAdd(feeds, input)
      if (!feed) {
        return yield* Effect.fail(
          new ConflictError({ message: `Intel feed already exists: ${input.id}`, resource: input.id }),
        )
      }
      yield* writeStoredFeeds([...feeds, feed])
      return feed
    }),
  )

/** Discard per-user overrides; the next read falls back to the lazy defaults. */
export const resetFeeds = (): Effect.Effect<Array<Feed>> =>
  withFeedConfigLock(
    Effect.promise(() =>
      fs.rm(feedsConfigPath(), { force: true }).then(
        () => [...DEFAULT_FEEDS],
        () => [...DEFAULT_FEEDS],
      ),
    ).pipe(Effect.catch(() => Effect.succeed([...DEFAULT_FEEDS]))),
  )
