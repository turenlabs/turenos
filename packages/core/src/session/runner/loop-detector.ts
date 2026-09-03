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
  // A delta can split a word, so the trailing fragment is held back and prepended to the next one.
  let partial = ""
  let sinceCheck = 0
  let collapsedDeltas = 0
  let tripped = false

  const ratios = () => {
    const unigrams = new Set(window)
    const trigrams = new Set<string>()
    for (let i = 2; i < window.length; i++) trigrams.add(`${window[i - 2]} ${window[i - 1]} ${window[i]}`)
    return {
      unigram: unigrams.size / window.length,
      trigram: trigrams.size / (window.length - 2),
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

    window.push(...words.slice(-WINDOW))
    sinceCheck += words.length
    if (window.length > WINDOW) window.splice(0, window.length - WINDOW)
    if (window.length < WINDOW || sinceCheck < STRIDE) return false

    sinceCheck = 0
    const { unigram, trigram } = ratios()
    collapsedDeltas = unigram < MAX_UNIGRAM_RATIO && trigram < MAX_TRIGRAM_RATIO ? collapsedDeltas + 1 : 0
    tripped = collapsedDeltas >= REQUIRED_COLLAPSED_DELTAS
    return tripped
  }

  return { observe }
}
