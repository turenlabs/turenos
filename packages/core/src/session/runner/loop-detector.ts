export * as SessionRunnerLoopDetector from "./loop-detector"

/**
 * Detects a degenerate provider turn: the model stops making progress and cycles a handful of short
 * phrases ("Run." / "Now." / "Running.") until it exhausts its output budget.
 *
 * Two signals, and both are required. Vocabulary collapse alone does not separate the cases: dense
 * source code legitimately reuses a small vocabulary, and measured against real transcripts it sits
 * at 12-18% distinct words -- close enough to the 4-6% a real loop reaches that a unigram threshold
 * would abort long code output. What distinguishes a loop is that it is cyclic rather than merely
 * repetitive: it repeats whole phrases, so its distinct-trigram ratio collapses with it, while code
 * at the same unigram diversity stays above 50%.
 *
 * Judged over a sliding window rather than the whole message, because a turn usually starts healthy
 * and degenerates part-way through; a whole-message ratio dilutes the collapse until it is too late
 * to be worth catching.
 */

const WINDOW = 400
// Re-check on this cadence rather than per delta: one window scan per 50 words, not per token.
const STRIDE = 50
const MAX_UNIGRAM_RATIO = 0.15
const MAX_TRIGRAM_RATIO = 0.45
const REQUIRED_COLLAPSED_DELTAS = 4

const WORD = /[a-z0-9_]+/g
const ENDS_MID_WORD = /[a-z0-9_]$/i

export type Detector = ReturnType<typeof make>

export function make() {
  const window: string[] = []
  const unigramCounts = new Map<string, number>()
  const trigramCounts = new Map<string, number>()
  // A delta can split a word, so the trailing fragment is held back and prepended to the next one.
  let partial = ""
  let sinceCheck = 0
  let collapsedDeltas = 0
  let tripped = false

  const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  const decrement = (counts: Map<string, number>, key: string) => {
    const count = counts.get(key)!
    if (count === 1) counts.delete(key)
    else counts.set(key, count - 1)
  }
  const trigramAt = (index: number) =>
    index < 2 ? undefined : `${window[index - 2]} ${window[index - 1]} ${window[index]}`

  const ratios = () => {
    return {
      unigram: unigramCounts.size / window.length,
      trigram: trigramCounts.size / (window.length - 2),
    }
  }

  /**
   * Feeds one text delta in and reports whether the turn has degenerated. Returns true once and
   * only once: the caller ends the turn on that signal, and re-reporting would double-publish.
   */
  const observe = (delta: string) => {
    if (tripped) return false
    const text = partial + delta
    const words = text.toLowerCase().match(WORD) ?? []
    partial = ENDS_MID_WORD.test(text) ? (words.pop() ?? "") : ""
    if (words.length === 0) return false

    const previousLength = window.length
    window.push(...words.slice(-WINDOW))
    for (let i = previousLength; i < window.length; i++) {
      increment(unigramCounts, window[i]!)
      const trigram = trigramAt(i)
      if (trigram !== undefined) increment(trigramCounts, trigram)
    }
    sinceCheck += words.length
    if (window.length < WINDOW || sinceCheck < STRIDE) return false

    const excess = window.length - WINDOW
    if (excess > 0) {
      // Trigrams are indexed by their right endpoint, so two more endpoints cross the evicted prefix.
      for (let i = 0; i < excess + 2; i++) {
        if (i < excess) decrement(unigramCounts, window[i]!)
        const trigram = trigramAt(i)
        if (trigram !== undefined) decrement(trigramCounts, trigram)
      }
      window.splice(0, excess)
    }
    sinceCheck = 0
    const { unigram, trigram } = ratios()
    collapsedDeltas = unigram < MAX_UNIGRAM_RATIO && trigram < MAX_TRIGRAM_RATIO ? collapsedDeltas + 1 : 0
    tripped = collapsedDeltas >= REQUIRED_COLLAPSED_DELTAS
    return tripped
  }

  return { observe }
}
