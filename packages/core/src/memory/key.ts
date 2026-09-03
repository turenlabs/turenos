export * as MemoryKey from "./key"

import nodePath from "path"
import type { MemorySchema } from "./schema"

/**
 * Keying rules for anything a memory points at.
 *
 * A memory keyed by `/Users/example/project/packages/core/src/session.ts`
 * is worthless on any machine but this one, and increasingly worthless on this
 * one: 46% of the paths in our own transcript corpus no longer resolve. So a
 * drawer is keyed by (repo identity, repo-relative path, commit) and the
 * absolute path is reconstructed at read time from whatever worktree the
 * caller currently has, if they have one at all.
 */

function posix(input: string): string {
  return input.replaceAll("\\", "/")
}

/**
 * Repo-relative form of `absolute`, or `undefined` when it falls outside the
 * worktree. Undefined is meaningful: a path outside the repo has no portable
 * key, so it should be stored without one rather than with a fabricated one.
 */
export function relative(worktree: string, absolute: string): string | undefined {
  const result = posix(nodePath.relative(worktree, absolute))
  if (result === "" || result.startsWith("../") || nodePath.posix.isAbsolute(result)) return undefined
  return result
}

/** Rehydrate an anchor against the worktree this machine happens to have. */
export function absolute(worktree: string, anchor: MemorySchema.Anchor): string | undefined {
  if (!anchor.path) return undefined
  return nodePath.join(worktree, anchor.path)
}

/**
 * Stable, human-readable rendering of an anchor. Used for the index's anchor
 * column and for display; it is not parsed back.
 */
export function format(anchor: MemorySchema.Anchor): string {
  const parts: string[] = []
  if (anchor.repo) parts.push(anchor.repo)
  if (anchor.path) parts.push(anchor.path)
  if (anchor.commit) parts.push(anchor.commit)
  if (anchor.symbol) parts.push(anchor.symbol)
  return parts.join(" ")
}

/**
 * The text the lexical index sees for an anchor.
 *
 * Deliberately excludes `repo` and `commit`. Both are opaque identifiers — a
 * TurenOS project id is a sha1 hex digest, a commit is a 40-character hash — and
 * neither is something anyone types into a search. Indexing them as free text
 * only adds terms with near-zero IDF that dilute document length, and both are
 * already exact-matchable as columns on `memory_drawer` when the caller wants
 * to filter rather than search.
 *
 * The path is emitted whole, split into segments, and as its bare basename, so
 * `session.ts` reaches a drawer keyed at `packages/core/src/session.ts` without
 * the query having to spell out the whole path.
 */
export function indexable(anchor: MemorySchema.Anchor): string {
  const parts: string[] = []
  if (anchor.path) {
    parts.push(anchor.path)
    parts.push(anchor.path.replaceAll("/", " "))
    parts.push(nodePath.posix.basename(anchor.path))
  }
  if (anchor.symbol) parts.push(anchor.symbol)
  return parts.join(" ")
}
