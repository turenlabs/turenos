export * as MemoryTokenize from "./tokenize"

import { MemorySchema } from "./schema"

/**
 * Token normalisation for the lexical index.
 *
 * Everything about this is symmetric: whatever transformation is applied to a
 * drawer on write is applied to the query on read. That symmetry is the only
 * reason the transformation is allowed to be lossy.
 *
 * The one non-obvious rule is identifier splitting. Our own workload
 * measurement put agent-issued retrieval at 91% exact-anchored — the "query" is
 * usually a path, a symbol, or a call site pasted verbatim. `unicode61` alone
 * would index `sessionRunner` as one opaque token that `session runner` can
 * never reach, and would shred `session_runner` into parts that the literal
 * `session_runner` can no longer match. Emitting the whole token *and* its
 * camel/pascal/snake/digit parts makes both directions reachable.
 */

// Deliberately narrow: the only characters that survive into a term are
// [A-Za-z0-9_], so a term can never contain an FTS5 metacharacter (`"`, `*`,
// `(`, `:`, `-`) and the MATCH expression cannot be injected into. `assertTerm`
// below re-checks that at the boundary rather than trusting this by inspection.
const WORD = /[A-Za-z0-9_]+/g
const TERM = /^[A-Za-z0-9_]+$/

/** Shortest term the index will store or search for. Single characters are pure noise. */
export const MIN_TERM_LENGTH = 2

export function tokenize(input: string): string[] {
  const out: string[] = []
  for (const raw of input.match(WORD) ?? []) {
    const whole = raw.toLowerCase()
    if (whole.length >= MIN_TERM_LENGTH) out.push(whole)
    for (const part of split(raw)) {
      const lower = part.toLowerCase()
      if (lower.length >= MIN_TERM_LENGTH && lower !== whole) out.push(lower)
    }
  }
  return out
}

function split(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .split(/[_\s]+/)
}

/** Token stream stored in an FTS5 column. */
export function normalize(input: string): string {
  return tokenize(input).join(" ")
}

/**
 * The distinct, capped, safe-to-interpolate terms of a free-text query.
 *
 * Separate from `expression` so the caller can drop terms in between — see
 * `MemoryIndex.prune`. Every term returned here has already been through
 * `assertTerm`, and `expression` checks again, so a term cannot become unsafe
 * by passing through whatever sits in the middle.
 */
export function searchTerms(input: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const term of tokenize(input.slice(0, MemorySchema.MAX_SEARCH_LENGTH))) {
    if (seen.has(term)) continue
    seen.add(term)
    terms.push(assertTerm(term))
    if (terms.length >= MemorySchema.MAX_SEARCH_TERMS) break
  }
  return terms
}

/**
 * Build the FTS5 MATCH expression from already-tokenised terms.
 *
 * FTS5 ANDs bare terms, which is wrong for a memory lookup: a 2,000-character
 * pasted brief would match nothing. Terms are ORed and ranked by `bm25()`
 * instead, so partial overlap still scores.
 *
 * Returns `undefined` when there is nothing to search for — callers must treat
 * that as "no results", never as "match everything".
 */
export function expression(terms: readonly string[]): string | undefined {
  if (terms.length === 0) return undefined
  return terms.map((term) => `"${assertTerm(term)}"`).join(" OR ")
}

/** `expression(searchTerms(input))` — the unpruned path, and what tests assert on. */
export function toMatch(input: string): string | undefined {
  return expression(searchTerms(input))
}

function assertTerm(term: string): string {
  if (!TERM.test(term)) throw new Error(`Memory index term is not safe to interpolate: ${JSON.stringify(term)}`)
  return term
}
