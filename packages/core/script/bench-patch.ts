/**
 * A/B + hill-climb benchmark for apply_patch chunk-matching algorithms.
 *
 * Each algorithm maps (fileLines, chunks) -> [start, remove, insert] replacements
 * or throws. Cases carry `expect: "apply" | "reject"` — a "reject" case is one
 * where no safe placement exists (e.g. a duplicated block with no context), so
 * failing IS the good outcome.
 *
 * Outcomes: ok (text == expected), wrong (applied but != expected), fail.
 * Good = ok on apply-cases + fail on reject-cases.
 *
 * Run: bun run script/bench-patch.ts   (from packages/core)
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Patch } from "../src/patch"

type Chunk = Patch.UpdateFileChunk
type Replacement = readonly [number, number, ReadonlyArray<string>]
type Algo = (lines: string[], chunks: ReadonlyArray<Chunk>) => Replacement[]

// ---------- shared ----------

const normalize = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")

function lineQuality(fileLine: string, patternLine: string): number {
  if (fileLine === patternLine) return 1
  if (fileLine.trimEnd() === patternLine.trimEnd()) return 0.95
  if (fileLine.trim() === patternLine.trim()) return 0.9
  if (normalize(fileLine.trim()) === normalize(patternLine.trim())) return 0.85
  return 0
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (!m || !n) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]!
}

const TAU = 0.7

function windowScore(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, offset: number): number {
  if (offset + pattern.length > lines.length) return 0
  let score = 0
  for (let i = 0; i < pattern.length; i++) score += lineQuality(lines[offset + i]!, pattern[i]!)
  return score / pattern.length
}

function applyReplacements(lines: ReadonlyArray<string>, replacements: Replacement[]): string {
  const updated = [...lines]
  for (const [start, remove, insert] of replacements.toReversed()) updated.splice(start, remove, ...insert)
  if (updated.at(-1) !== "") updated.push("")
  return updated.join("\n")
}

function splitLines(text: string): string[] {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

// ---------- baseline (current sequential first-match seek, pre-change) ----------

const baselineComparators = [
  (a: string, b: string) => a === b,
  (a: string, b: string) => a.trimEnd() === b.trimEnd(),
  (a: string, b: string) => a.trim() === b.trim(),
  (a: string, b: string) => normalize(a.trim()) === normalize(b.trim()),
]

function seekBaseline(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, start: number, eof = false) {
  if (pattern.length === 0) return -1
  for (const compare of baselineComparators) {
    if (eof) {
      const offset = lines.length - pattern.length
      if (offset >= start && pattern.every((line, i) => compare(lines[offset + i]!, line))) return offset
    }
    for (let offset = start; offset <= lines.length - pattern.length; offset++) {
      if (pattern.every((line, i) => compare(lines[offset + i]!, line))) return offset
    }
  }
  return -1
}

const baseline: Algo = (lines, chunks) => {
  const replacements: Replacement[] = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seekBaseline(lines, [chunk.changeContext], lineIndex)
      if (context === -1) throw new Error(`Failed to find context '${chunk.changeContext}'`)
      lineIndex = context + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let found = seekBaseline(lines, oldLines, lineIndex, chunk.endOfFile)
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1)
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
      found = seekBaseline(lines, oldLines, lineIndex, chunk.endOfFile)
    }
    if (found === -1) throw new Error("Failed to find expected lines")
    replacements.push([found, oldLines.length, newLines])
    lineIndex = found + oldLines.length
  }
  return replacements.toSorted((a, b) => a[0] - b[0])
}

// ---------- scored-anchor v1 (currently shipped) ----------

const scoredAnchor = (TAU: number, rejectAmbiguous: boolean): Algo => (lines, chunks) => {
  const replacements: Replacement[] = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seekScored(lines, chunk.changeContext, lineIndex)
      if (context === -1) throw new Error(`Failed to find context '${chunk.changeContext}'`)
      lineIndex = context + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }
    let oldLines = [...chunk.oldLines]
    let newLines = [...chunk.newLines]
    let found = bestWindow(lines, oldLines, lineIndex, chunk.endOfFile, TAU, rejectAmbiguous)
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1)
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
      found = bestWindow(lines, oldLines, lineIndex, chunk.endOfFile, TAU, rejectAmbiguous)
    }
    if (found === -1) throw new Error("Failed to find expected lines")
    replacements.push([found, oldLines.length, newLines])
    lineIndex = found + oldLines.length
  }
  return replacements.toSorted((a, b) => a[0] - b[0])
}

function seekScored(lines: ReadonlyArray<string>, context: string, start: number) {
  let best = -1
  let bestScore = 0
  for (let i = start; i < lines.length; i++) {
    const q = lineQuality(lines[i]!, context)
    if (q >= 0.85 && q > bestScore) {
      bestScore = q
      best = i
    }
  }
  if (best !== -1) return best
  for (let i = 0; i < Math.min(start, lines.length); i++) {
    const q = lineQuality(lines[i]!, context)
    if (q >= 0.85 && q > bestScore) {
      bestScore = q
      best = i
    }
  }
  return best
}

function bestWindow(
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  start: number,
  eof = false,
  TAU = 0.7,
  rejectAmbiguous = true,
) {
  if (pattern.length === 0) return -1
  const last = lines.length - pattern.length
  if (eof && last >= start && windowScore(lines, pattern, last) >= TAU) return last
  const forward = bestWindowIn(lines, pattern, start, last, TAU, rejectAmbiguous)
  if (forward !== -1) return forward
  return bestWindowIn(lines, pattern, 0, Math.min(start - 1, last), TAU, rejectAmbiguous)
}

function bestWindowIn(
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  lo: number,
  hi: number,
  TAU: number,
  rejectAmbiguous: boolean,
) {
  if (hi < lo) return -1
  let anchor = -1
  let anchorCount = Infinity
  for (let i = 0; i < pattern.length; i++) {
    let count = 0
    for (let j = lo + i; j <= hi + i; j++) if (lineQuality(lines[j]!, pattern[i]!) >= 0.85) count++
    if (count > 0 && count < anchorCount) {
      anchorCount = count
      anchor = i
    }
  }
  if (anchor === -1) return -1
  const scored: Array<{ pos: number; score: number }> = []
  for (let j = lo + anchor; j <= hi + anchor; j++) {
    if (lineQuality(lines[j]!, pattern[anchor]!) < 0.85) continue
    const score = windowScore(lines, pattern, j - anchor)
    if (score >= TAU) scored.push({ pos: j - anchor, score })
  }
  if (scored.length === 0) return -1
  scored.sort((a, b) => b.score - a.score || a.pos - b.pos)
  const best = scored[0]!
  if (rejectAmbiguous) {
    const rival = scored.find((c) => Math.abs(c.pos - best.pos) >= pattern.length)
    if (rival && best.score - rival.score <= 0.01) return -1
  }
  return best.pos
}

// ---------- v2: offset voting + context-candidate retry + edge fuzz + insert-after-context ----------

// Score-gap telemetry: per resolved chunk, the gap between the best candidate
// and the best non-overlapping runner-up (1.0 when no runner-up exists).
const gapEvents: Array<{ gap: number; score: number; runnerScore?: number; outcome?: string; category?: string }> = []
let gapRecording = false

interface WindowMatch {
  readonly type: "found" | "ambiguous" | "missing"
  readonly pos?: number
  readonly score?: number
  readonly best?: { pos: number; score: number }
  readonly rivals?: ReadonlyArray<{ pos: number; score: number }>
  readonly runnerUp?: { pos: number; score: number }
}

const contextCandidates = (lines: ReadonlyArray<string>, context: string): number[] => {
  const found: Array<{ pos: number; q: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const q = lineQuality(lines[i]!, context)
    if (q >= 0.85) found.push({ pos: i, q })
  }
  return found.sort((a, b) => b.q - a.q || a.pos - b.pos).map((c) => c.pos)
}

interface V2Options {
  readonly tau?: number
  readonly margin?: number
  readonly rejectAmbiguous?: boolean
  readonly edgeFuzz?: boolean
  readonly insertAfterContext?: boolean
  readonly multiContext?: boolean
  readonly levenshteinTier?: boolean
  readonly rarity?: boolean
  readonly tieFloor?: number
}

const v2 = (options: V2Options = {}): Algo => {
  const TAU = options.tau ?? 0.7
  const margin = options.margin ?? 0.01
  const rejectAmbiguous = options.rejectAmbiguous ?? true
  const edgeFuzz = options.edgeFuzz ?? true
  const insertAfterContext = options.insertAfterContext ?? true
  const multiContext = options.multiContext ?? true
  const quality = options.levenshteinTier ? withLev(lineQuality) : lineQuality

  // Per-file line frequency for rarity weighting: common lines (braces, blank,
  // boilerplate) carry little evidence; a fuzzy match on rare lines outweighs an
  // exact match on generic ones.
  const freqCache = new WeakMap<ReadonlyArray<string>, Map<string, number>>()
  const weight = (lines: ReadonlyArray<string>, line: string) => {
    let freq = freqCache.get(lines)
    if (!freq) {
      freq = new Map()
      for (const l of lines) {
        const k = normalize(l.trim())
        freq.set(k, (freq.get(k) ?? 0) + 1)
      }
      freqCache.set(lines, freq)
    }
    return options.rarity ? 1 / (1 + (freq.get(normalize(line.trim())) ?? 0)) : 1
  }
  const wScore = (lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, offset: number) => {
    if (offset + pattern.length > lines.length) return 0
    let score = 0
    let ws = 0
    for (let i = 0; i < pattern.length; i++) {
      const w = weight(lines, pattern[i]!)
      score += quality(lines[offset + i]!, pattern[i]!) * w
      ws += w
    }
    return ws === 0 ? 0 : score / ws
  }

  const voteAll = (lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, lo: number, hi: number) => {
    if (hi < lo || pattern.length === 0) return []
    const votes = new Map<number, number>()
    for (let i = 0; i < pattern.length; i++)
      for (let pos = lo + i; pos <= hi + i; pos++)
        if (quality(lines[pos]!, pattern[i]!) >= 0.85) votes.set(pos - i, (votes.get(pos - i) ?? 0) + 1)
    const need = Math.max(1, Math.ceil(pattern.length * 0.5))
    const scored: Array<{ pos: number; score: number }> = []
    for (const [pos, count] of votes) {
      if (count < need) continue
      const score = wScore(lines, pattern, pos)
      if (score >= TAU) scored.push({ pos, score })
    }
    return scored.sort((a, b) => b.score - a.score || a.pos - b.pos)
  }

  const vote = (
    lines: ReadonlyArray<string>,
    pattern: ReadonlyArray<string>,
    lo: number,
    hi: number,
  ): WindowMatch => {
    const scored = voteAll(lines, pattern, lo, hi)
    if (scored.length === 0) return { type: "missing" }
    const best = scored[0]!
    if (rejectAmbiguous) {
      const rivals = scored.filter(
        (c) => Math.abs(c.pos - best.pos) >= pattern.length && best.score - c.score <= margin,
      )
      if (rivals.length)
        return {
          type: "ambiguous",
          best,
          rivals,
          runnerUp: scored.find((c) => Math.abs(c.pos - best.pos) >= pattern.length),
        }
    }
    return {
      type: "found",
      pos: best.pos,
      score: best.score,
      runnerUp: scored.find((c) => Math.abs(c.pos - best.pos) >= pattern.length),
    }
  }

  /** Full-pattern then edge-fuzz retries inside one search band. Fuzz affects
   * location only: the replacement always covers the full original span. Score is
   * discounted by matchedLen/fullLen so a trimmed-core hit never ties an exact one. */
  const matchIn = (
    lines: ReadonlyArray<string>,
    oldLines: ReadonlyArray<string>,
    newLines: ReadonlyArray<string>,
    lo: number,
    hi: number,
  ): {
    type: "found" | "ambiguous" | "missing"
    pos?: number
    score?: number
    best?: { pos: number; score: number }
    rivals?: Array<{ pos: number; score: number }>
    runnerUp?: { pos: number; score: number }
    matchedLen?: number
  } => {
    const fullLen = oldLines.length
    const discount = (score: number, matchedLen: number) => score * (matchedLen / fullLen)
    let old_ = [...oldLines]
    let new_ = [...newLines]
    let head = 0
    let tail = 0
    // legacy trailing-empty strip first
    const shift = (p: number, matchedLen: number) => {
      const pos = p - head
      return pos >= 0 && pos + fullLen <= lines.length ? pos : -1
    }
    const runner = (m: WindowMatch, matchedLen: number) => {
      if (!m.runnerUp) return undefined
      const pos = shift(m.runnerUp.pos, matchedLen)
      return pos >= lo ? { pos, score: discount(m.runnerUp.score, matchedLen) } : undefined
    }
    if (old_.at(-1) === "") {
      const m = vote(lines, old_, lo, Math.min(hi, lines.length - old_.length))
      if (m.type === "found" && m.pos! + fullLen <= lines.length)
        return { type: "found", pos: m.pos, score: discount(m.score!, old_.length), runnerUp: runner(m, old_.length), matchedLen: old_.length }
      if (m.type === "ambiguous")
        return {
          type: "ambiguous",
          best: { pos: m.best!.pos, score: discount(m.best!.score, old_.length) },
          rivals: m.rivals!.map((r) => ({ pos: r.pos, score: discount(r.score, old_.length) })),
          matchedLen: old_.length,
        }
      old_ = old_.slice(0, -1)
      if (new_.at(-1) === "") new_ = new_.slice(0, -1)
      tail++
    }
    while (old_.length > 0) {
      // keep the full original span in bounds: pos-head >= lo and pos-head+fullLen <= lines.length
      const m = vote(lines, old_, lo + head, Math.min(hi, lines.length - fullLen + head))
      if (m.type === "found") {
        const pos = m.pos! - head
        if (pos >= lo && pos + fullLen <= lines.length)
          return { type: "found", pos, score: discount(m.score!, old_.length), runnerUp: runner(m, old_.length), matchedLen: old_.length }
      } else if (m.type === "ambiguous") {
        return {
          type: "ambiguous",
          best: { pos: m.best!.pos - head, score: discount(m.best!.score, old_.length) },
          rivals: m.rivals!.map((r) => ({ pos: r.pos - head, score: discount(r.score, old_.length) })),
          matchedLen: old_.length,
        }
      }
      if (!edgeFuzz) return { type: "missing" }
      // drop a boundary context line (present in both old and new) that may have drifted
      if (tail < 2 && old_.at(-1) === new_.at(-1)) {
        old_ = old_.slice(0, -1)
        new_ = new_.slice(0, -1)
        tail++
        continue
      }
      if (head < 2 && old_[0] === new_[0]) {
        old_ = old_.slice(1)
        new_ = new_.slice(1)
        head++
        continue
      }
      return { type: "missing" }
    }
    return { type: "missing" }
  }

  /** Last-resort match when the file gained/lost lines inside the region: split
   * the pattern at k, match the head, then require the tail at pos+k+s
   * (s>0 file grew, s<0 file shrank — skip |s| pattern lines). The insert keeps
   * foreign lines for growth and drops newLines whose old counterpart vanished.
   * newLines is split positionally — fine for 1:1 patches; a production version
   * should map the boundary via the chunk's per-line +/-/space markers. */
  const splitMatch = (
    lines: ReadonlyArray<string>,
    oldLines: ReadonlyArray<string>,
    newLines: ReadonlyArray<string>,
    lo: number,
    hi: number,
  ): Array<{ pos: number; removeLen: number; insert: string[]; score: number }> => {
    const len = oldLines.length
    const out: Array<{ pos: number; removeLen: number; insert: string[]; score: number }> = []
    for (let k = 1; k < len; k++) {
      const head = oldLines.slice(0, k)
      for (const hc of voteAll(lines, head, lo, Math.min(hi + 2, lines.length - k))) {
        for (const s of [-2, -1, 1, 2]) {
          const skip = Math.max(0, -s)
          const gap = Math.max(0, s)
          const tail = oldLines.slice(k + skip)
          // both sides need >=2 matched lines — a 1-line side is weak evidence
          if (tail.length < 2 || head.length < 2) continue
          const tpos = hc.pos + k + gap
          const tScore = wScore(lines, tail, tpos)
          if (tScore < 0.85) continue
          const score = (hc.score * k + tScore * tail.length) / (k + tail.length)
          if (score < TAU) continue
          const removeLen = k + gap + tail.length
          if (hc.pos + removeLen > lines.length) continue
          const newK = Math.min(Math.round((k * newLines.length) / len), newLines.length)
          const foreign = gap ? lines.slice(hc.pos + k, hc.pos + k + gap) : []
          const insert = [...newLines.slice(0, newK), ...foreign, ...newLines.slice(Math.min(newK + skip, newLines.length))]
          out.push({ pos: hc.pos, removeLen, insert, score })
        }
      }
    }
    return out
  }

  return (lines, chunks) => {
    const replacements: Replacement[] = []
    const consumed: Array<readonly [number, number]> = []
    let lineIndex = 0
    // A rival placement is consumable when a later chunk's pattern scores over it —
    // sequential chunks then disambiguate duplicates by order.
    const consumable = (pos: number, afterChunk: number) =>
      chunks.slice(afterChunk).some((c) => c.oldLines.length > 0 && wScore(lines, c.oldLines, pos) >= TAU)
    const overlapsConsumed = (pos: number, len: number) =>
      consumed.some(([s, e]) => pos < e && pos + len > s)

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!
      const ctxs = chunk.changeContext ? contextCandidates(lines, chunk.changeContext) : []
      if (chunk.changeContext && ctxs.length === 0)
        throw new Error(`Failed to find context '${chunk.changeContext}'`)
      const ctxPositions = multiContext ? ctxs : ctxs.slice(0, 1)
      const starts: number[] = ctxPositions.length ? ctxPositions.map((p) => p + 1) : [lineIndex]

      if (chunk.oldLines.length === 0) {
        if (ctxs.length > 1 && insertAfterContext)
          throw new Error(`Context '${chunk.changeContext}' matches multiple locations; add more context`)
        const at = ctxs.length && insertAfterContext ? starts[0]! : chunk.hint !== undefined ? chunk.hint + 1 : lines.length
        replacements.push([at, 0, chunk.newLines])
        lineIndex = at
        continue
      }

      // Collect scored placements across context candidates (or the one band).
      // Positions overlapping an earlier chunk's match are already consumed.
      const usable = (pos: number, span = chunk.oldLines.length) => !overlapsConsumed(pos, span)
      const keyOf = (pos: number, remove?: number, insert?: string[]) =>
        insert === undefined ? `${pos}` : `${pos}:${remove}:${insert.join("\x00")}`
      const cands: Array<{ pos: number; score: number; dist: number; remove?: number; insert?: string[]; full?: boolean }> = []
      const push = (pos: number, score: number, dist: number, remove?: number, insert?: string[], full = false) => {
        if (!usable(pos, remove)) return
        const key = keyOf(pos, remove, insert)
        const existing = cands.find((c) => keyOf(c.pos, c.remove, c.insert) === key)
        if (existing) {
          existing.score = Math.max(existing.score, score)
          existing.dist = Math.min(existing.dist, dist)
          existing.full = existing.full || full
        } else cands.push({ pos, score, dist, remove, insert, full })
      }
      const bands = [...starts.map((s) => [s, lines.length - chunk.oldLines.length] as const)]
      if (ctxs.length === 0) bands.push([0, Math.min(lineIndex - 1, lines.length - chunk.oldLines.length)])
      const searched: Array<readonly [number, number]> = []
      const scan = (input: ReadonlyArray<readonly [number, number]>) => {
        for (const [lo, hi] of input) {
          searched.push([lo, hi])
          const dist = (pos: number) => Math.abs(pos - lo)
          if (chunk.endOfFile) {
            const last = lines.length - chunk.oldLines.length
            if (last >= lo && usable(last) && wScore(lines, chunk.oldLines, last) >= TAU) {
              push(last, wScore(lines, chunk.oldLines, last), dist(last), undefined, undefined, true)
              continue
            }
          }
          const m = matchIn(lines, chunk.oldLines, chunk.newLines, lo, hi)
          const full = m.matchedLen === chunk.oldLines.length
          if (m.type === "found") {
            push(m.pos!, m.score!, dist(m.pos!), undefined, undefined, full)
            if (m.runnerUp) push(m.runnerUp.pos, m.runnerUp.score, dist(m.runnerUp.pos), undefined, undefined, full)
          } else if (m.type === "ambiguous") {
            push(m.best!.pos, m.best!.score, dist(m.best!.pos), undefined, undefined, full)
            for (const r of m.rivals ?? []) push(r.pos, r.score, dist(r.pos), undefined, undefined, full)
          }
        }
      }
      scan(bands)
      // `@@ ctx` anchors the block right after the context line — but models
      // also point at a line *inside* the block. When every direct anchor
      // missed, retry anchored at pos-j for each pattern line matching ctx.
      if (ctxs.length > 0 && cands.length === 0) {
        const interior = [
          ...new Set(
            ctxPositions.flatMap((pos) =>
              chunk.oldLines.flatMap((line, j) =>
                lineQuality(line, chunk.changeContext!) >= 0.85 && pos - j >= 0 ? [pos - j] : [],
              ),
            ),
          ),
        ]
        scan(interior.map((s) => [s, lines.length - chunk.oldLines.length] as const))
      }

      // Interior drift fallback: when no full-length window matched (drift inside
      // the region), compete split candidates against any trimmed-core hits.
      if (!cands.some((c) => c.full))
        for (const [lo] of searched)
          for (const s of splitMatch(lines, chunk.oldLines, chunk.newLines, lo, lines.length - chunk.oldLines.length))
            push(s.pos, s.score, Math.abs(s.pos - lo), s.removeLen, s.insert)

      // Line-number header prior: the model's stated position adds its
      // neighborhood as candidates — it may hold a strong window the text-only
      // bands missed (verbatim twin outscoring a drifted intent).
      if (chunk.hint !== undefined) {
        const radius = Math.max(15, chunk.oldLines.length * 3)
        for (const c of voteAll(
          lines,
          chunk.oldLines,
          Math.max(0, chunk.hint - radius),
          Math.min(lines.length - chunk.oldLines.length, chunk.hint + radius),
        ))
          push(c.pos, c.score, Math.abs(c.pos - chunk.hint))
      }

      if (cands.length === 0) throw new Error(`Failed to find expected lines:\n${chunk.oldLines.join("\n")}`)

      // Best score wins. Candidates within margin are rivals: resolve by context
      // proximity when anchored, else by later-chunk consumption (ordered dups),
      // else reject as ambiguous.
      cands.sort((a, b) => b.score - a.score || a.dist - b.dist || a.pos - b.pos)
      const best = cands[0]!
      const runnerUp = cands.find((c) => Math.abs(c.pos - best.pos) >= chunk.oldLines.length)
      if (gapRecording) gapEvents.push({ gap: best.score - (runnerUp?.score ?? 0), score: best.score, runnerScore: runnerUp?.score ?? 0 })
      if (process.env.DUMP)
        console.log(`  cands: ${cands.slice(0, 4).map((c) => `${c.pos + 1}@${c.score.toFixed(3)}d${c.dist}`).join(" ")}`)
      // Two candidates are rivals when they land on different spans, or on the
      // same span with different replacement text (ambiguous split point).
      const rivalOf = (c: (typeof cands)[number], b: (typeof cands)[number]) =>
        Math.abs(c.pos - b.pos) >= chunk.oldLines.length || keyOf(c.pos, c.remove, c.insert) !== keyOf(b.pos, b.remove, b.insert)
      const tieFloor = options.tieFloor ?? Infinity
      // An exact full-length best is challenged only by exact-score ties — a
      // verbatim placement is the natural reading of the patch, and fuzzy
      // lookalikes can't contest it. A fuzzy best (<1.0) is inherently weaker
      // evidence: any strong (>=0.8) rival makes the placement ambiguous.
      const bestExact = best.full && best.score >= 1
      const effMargin = chunks.length > 1 && bestExact ? 0 : margin
      const fuzzyFloor = bestExact ? Infinity : 0.8
      const tied = cands
        .slice(1)
        .filter(
          (c) =>
            rivalOf(c, best) &&
            (best.score - c.score <= effMargin ||
              // strong rival at a different location challenges a fuzzy best;
              // same-position variants only rival on a true near-tie
              (Math.abs(c.pos - best.pos) >= chunk.oldLines.length && c.score >= Math.min(tieFloor, fuzzyFloor))),
        )
      let pick: (typeof cands)[number] | undefined
      // The model's stated position singles out a unique strong window — real
      // evidence that outranks a higher-scoring distant lookalike.
      if (chunk.hint !== undefined) {
        const radius = Math.max(15, chunk.oldLines.length * 3)
        const strong = cands
          .filter((c) => Math.abs(c.pos - chunk.hint!) <= radius && c.score >= 0.8)
          .sort((a, b) => b.score - a.score || Math.abs(a.pos - chunk.hint!) - Math.abs(b.pos - chunk.hint!))
        const top = strong[0]
        if (top && !strong.every((c) => Math.abs(c.pos - top.pos) < chunk.oldLines.length))
          throw new Error(
            `Expected lines match multiple locations near line ${chunk.hint + 1} (lines ${top.pos + 1} and ${strong.find((c) => Math.abs(c.pos - top.pos) >= chunk.oldLines.length)!.pos + 1}); add more context`,
          )
        if (top) pick = top
      }
      pick ??= tied.length === 0 ? best : undefined
      if (!pick) {
        const all = [best, ...tied]
        if (ctxs.length > 0) {
          const nearest = Math.min(...all.map((c) => c.dist))
          const nearCands = all.filter((c) => c.dist === nearest)
          if (nearCands.length === 1) pick = nearCands[0]!
        }
        if (!pick) {
          // Order disambiguates duplicates: pick the earliest of the
          // *top-scoring* rivals when the rest are consumed by later chunks.
          const top = all.filter((c) => c.score === best.score)
          const ordered = [...top].sort((a, b) => a.pos - b.pos)
          const rest = all.filter((c) => c.score !== best.score)
          if (ordered.slice(1).concat(rest).every((c) => consumable(c.pos, ci + 1))) pick = ordered[0]!
        }
        if (!pick)
          throw new Error(
            `Expected lines match multiple locations (lines ${all[0]!.pos + 1} and ${all[1]!.pos + 1}); add more context`,
          )
      }
      const remove = pick.remove ?? chunk.oldLines.length
      if (process.env.DUMP)
        console.log(`  pick: ${pick.pos + 1}@${pick.score.toFixed(3)} remove=${remove} insert=${JSON.stringify((pick.insert ?? chunk.newLines).slice(0, 2))}`)
      replacements.push([pick.pos, remove, pick.insert ?? chunk.newLines])
      consumed.push([pick.pos, pick.pos + remove])
      lineIndex = pick.pos + remove
    }
    return replacements.toSorted((a, b) => a[0] - b[0])
  }
}

const withLev =
  (base: typeof lineQuality) =>
  (fileLine: string, patternLine: string): number => {
    const q = base(fileLine, patternLine)
    if (q > 0) return q
    const a = normalize(fileLine.trim())
    const b = normalize(patternLine.trim())
    const ratio = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1)
    return ratio >= 0.85 ? 0.7 : 0
  }

// ---------- LCS (rejected family, kept for comparison) ----------

const lcsAlign: Algo = (lines, chunks) => {
  const replacements: Replacement[] = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seekScored(lines, chunk.changeContext, lineIndex)
      if (context === -1) throw new Error(`Failed to find context '${chunk.changeContext}'`)
      lineIndex = context + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }
    const match = lcsWindow(lines, chunk.oldLines, lineIndex) ?? lcsWindow(lines, chunk.oldLines, 0)
    if (!match) throw new Error("Failed to find expected lines")
    replacements.push([match.start, match.end - match.start, chunk.newLines])
    lineIndex = match.end
  }
  return replacements.toSorted((a, b) => a[0] - b[0])
}

function lcsWindow(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, from: number, normalized = false) {
  const n = lines.length - from
  const m = pattern.length
  if (n <= 0 || m === 0) return undefined
  const eq = (a: string, b: string) => (normalized ? normalize(a.trim()) === normalize(b.trim()) : a === b)
  const dp = new Uint32Array(m + 1)
  const prev = new Uint32Array(m + 1)
  const back: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    prev.set(dp)
    const row = new Uint8Array(m + 1)
    for (let j = 1; j <= m; j++) {
      if (eq(lines[from + i]!, pattern[j - 1]!)) {
        dp[j] = prev[j - 1]! + 1
        row[j] = 2
      } else if (prev[j]! >= dp[j - 1]!) {
        dp[j] = prev[j]!
        row[j] = 1
      }
    }
    back.push(row)
  }
  const coverage = dp[m]! / m
  if (coverage < 0.6) {
    if (!normalized) return lcsWindow(lines, pattern, from, true)
    return undefined
  }
  let i = n - 1
  let j = m
  let first = -1
  let last = -1
  while (i >= 0 && j > 0) {
    const dir = back[i]![j]!
    if (dir === 2) {
      if (first === -1) first = from + i
      last = from + i
      i--
      j--
    } else if (dir === 1) i--
    else j--
  }
  if (first === -1) return undefined
  return { start: last, end: first + 1 }
}

// ---------- corpus ----------

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Case {
  readonly category: string
  readonly file: string
  readonly expect: "apply" | "reject"
  readonly original: string
  readonly chunks: Chunk[]
  readonly expected: string
  readonly diff?: string
  readonly at?: number
}

const spliceLines = (lines: string[], start: number, remove: number, insert: string[]) => {
  const next = [...lines]
  next.splice(start, remove, ...insert)
  return next
}

const join = (lines: string[]) => (lines.at(-1) === "" ? lines.join("\n") : [...lines, ""].join("\n"))

/** Exact contiguous occurrences of a line pattern inside a file's lines. */
const exactCount = (lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>) => {
  let count = 0
  for (let i = 0; i <= lines.length - pattern.length; i++)
    if (pattern.every((line, j) => lines[i + j] === line)) count++
  return count
}

function unifiedDiff(
  file: string,
  hunks: Array<{ start: number; oldLines: string[]; newLines: string[] }>,
  lines: string[],
) {
  const sorted = [...hunks].sort((a, b) => a.start - b.start)
  let out = `--- a/${file}\n+++ b/${file}\n`
  for (const hunk of sorted) {
    const before = lines.slice(Math.max(0, hunk.start - 3), hunk.start)
    const after = lines.slice(hunk.start + hunk.oldLines.length, hunk.start + hunk.oldLines.length + 3)
    const oldCount = before.length + hunk.oldLines.length + after.length
    const newCount = before.length + hunk.newLines.length + after.length
    out += `@@ -${hunk.start - before.length + 1},${oldCount} +${hunk.start - before.length + 1},${newCount} @@\n`
    for (const line of before) out += ` ${line}\n`
    for (const line of hunk.oldLines) out += `-${line}\n`
    for (const line of hunk.newLines) out += `+${line}\n`
    for (const line of after) out += ` ${line}\n`
  }
  return out
}

function* generate(file: string, content: string, rand: () => number): Generator<Case> {
  const lines = splitLines(content)
  if (lines.length < 80) return
  const pickRegion = (minLen = 4, maxLen = 9) => {
    const len = minLen + Math.floor(rand() * (maxLen - minLen))
    const start = 10 + Math.floor(rand() * Math.max(1, lines.length - len - 20))
    return { start, len }
  }
  const mutate = (region: string[]) => {
    const next = [...region]
    const idx = next.findIndex((line) => line.trim().length > 0)
    next[idx === -1 ? 0 : idx] = next[idx === -1 ? 0 : idx] + " // patched"
    return next
  }
  const simple = (
    category: string,
    mutated: string[],
    chunks: Chunk[],
    expected: string[],
    diffHunks?: Array<{ start: number; oldLines: string[]; newLines: string[] }>,
    expect: "apply" | "reject" = "apply",
    at?: number,
  ): Case => ({
    category,
    file,
    expect,
    original: join(mutated),
    chunks,
    expected: join(expected),
    diff: diffHunks && unifiedDiff(file, diffHunks, lines),
    at: at ?? diffHunks?.[0]?.start,
  })

  // clean
  {
    const { start, len } = pickRegion()
    const oldLines = lines.slice(start, start + len)
    if (exactCount(lines, oldLines) !== 1) return
    const newLines = mutate(oldLines)
    yield simple("clean", lines, [{ oldLines, newLines }], spliceLines(lines, start, len, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // stale-shift
  {
    const { start, len } = pickRegion()
    const oldLines = lines.slice(start, start + len)
    const newLines = mutate(oldLines)
    const drift = ["", "// drifted in", ""]
    const shifted = spliceLines(lines, Math.max(0, start - 5), 0, drift)
    if (exactCount(shifted, oldLines) > 1) return
    yield simple(
      "stale-shift",
      shifted,
      [{ oldLines, newLines }],
      spliceLines(shifted, start + drift.length, len, newLines),
      [{ start, oldLines, newLines }],
      "apply",
      start + drift.length,
    )
  }

  // trailing-ws
  {
    const { start, len } = pickRegion()
    const oldLines = lines.slice(start, start + len)
    if (!oldLines.some((line) => line.trim())) return
    const drifted = spliceLines(lines, start, len, oldLines.map((line) => line + "   "))
    if (exactCount(drifted, oldLines) > 1) return
    const newLines = mutate(oldLines)
    yield simple(
      "trailing-ws",
      drifted,
      [{ oldLines, newLines }],
      spliceLines(drifted, start, len, newLines),
      [{ start, oldLines, newLines }],
    )
  }

  // indent
  {
    const { start, len } = pickRegion()
    const oldLines = lines.slice(start, start + len)
    const drifted = spliceLines(lines, start, len, oldLines.map((line) => "  " + line))
    if (exactCount(drifted, oldLines) > 1) return
    const newLines = mutate(oldLines)
    yield simple(
      "indent",
      drifted,
      [{ oldLines, newLines }],
      spliceLines(drifted, start, len, newLines),
      [{ start, oldLines, newLines }],
    )
  }

  // unicode
  {
    const { start, len } = pickRegion()
    const oldLines = lines.slice(start, start + len)
    if (!oldLines.join("\n").match(/['"-]/)) return
    const drifted = spliceLines(
      lines,
      start,
      len,
      oldLines.map((line) => line.replace(/'/g, "’").replace(/"/g, "“").replace(/-/g, "—")),
    )
    if (exactCount(drifted, oldLines) > 1) return
    const newLines = mutate(oldLines)
    yield simple(
      "unicode",
      drifted,
      [{ oldLines, newLines }],
      spliceLines(drifted, start, len, newLines),
      [{ start, oldLines, newLines }],
    )
  }

  // partial-drift
  {
    const { start, len } = pickRegion(5, 9)
    const oldLines = lines.slice(start, start + len)
    const mid = Math.floor(len / 2)
    if (oldLines[mid]!.trim().length === 0) return
    const drifted = [...lines]
    drifted[start + mid] = `${oldLines[mid]!.split("//")[0]!.trimEnd()} // externally modified`
    if (exactCount(drifted, oldLines) > 1) return
    const newLines = mutate(oldLines)
    yield simple(
      "partial-drift",
      drifted,
      [{ oldLines, newLines }],
      spliceLines(drifted, start, len, newLines),
      [{ start, oldLines, newLines }],
    )
  }

  // drifted anchor: the rarest/distinctive line is the one that changed
  {
    const { start, len } = pickRegion(5, 9)
    const oldLines = lines.slice(start, start + len)
    const drifted = [...lines]
    drifted[start] = "const __anchorDrifted = true"
    if (exactCount(drifted, oldLines) > 1) return
    const newLines = mutate(oldLines)
    yield simple("anchor-drift", drifted, [{ oldLines, newLines }], spliceLines(drifted, start, len, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // ambiguous duplicate, no context — reject is the good outcome
  {
    const { start, len } = pickRegion(4, 7)
    const oldLines = lines.slice(start, start + len)
    if (oldLines.filter((line) => line.trim()).length < 3) return
    const dupAt = Math.max(0, start - 15 - Math.floor(rand() * 10))
    const dupped = spliceLines(lines, dupAt, 0, oldLines)
    const target = start + len
    const newLines = mutate(oldLines)
    yield simple(
      "ambig-dup",
      dupped,
      [{ oldLines, newLines }],
      spliceLines(dupped, target, len, newLines),
      [{ start, oldLines, newLines }],
      "reject",
    )
    const context = dupped[target - 1]!
    if (context.trim() && exactCount(dupped, [context]) === 1) {
      yield simple(
        "ambig-dup-ctx",
        dupped,
        [{ oldLines, newLines, changeContext: context.trim() }],
        spliceLines(dupped, target, len, newLines),
        [{ start, oldLines, newLines }],
        "apply",
        target,
      )
    }
  }

  // line-number hint resolves verbatim-twin ambiguity: the intended spot
  // drifted while a verbatim copy sits elsewhere — undecidable from text alone
  {
    const { start, len } = pickRegion(5, 9)
    const oldLines = lines.slice(start, start + len)
    if (oldLines.filter((line) => line.trim()).length < 3) return
    const dupAt = Math.min(lines.length - len, start + 40 + Math.floor(rand() * 30))
    if (dupAt <= start) return
    const dupped = spliceLines(lines, dupAt, 0, oldLines)
    const drifted = [...dupped]
    drifted[start] = "const __hintedAnchor = true"
    if (exactCount(drifted, oldLines) !== 1) return
    const newLines = mutate(oldLines)
    yield simple(
      "hinted-ambig",
      drifted,
      [{ oldLines, newLines, hint: start }],
      spliceLines(drifted, start, len, newLines),
      [{ start, oldLines, newLines }],
      "apply",
      start,
    )
    // a stale hint that lands nowhere keeps text evidence in charge
    const miss = drifted.length - 1
    const radius = Math.max(15, len * 3)
    let nearMiss = false
    for (let p = Math.max(0, miss - radius); p <= Math.min(drifted.length - len, miss + radius); p++)
      if (windowScore(drifted, oldLines, p) >= 0.7) nearMiss = true
    if (!nearMiss)
      yield simple(
        "hint-miss",
        drifted,
        [{ oldLines, newLines, hint: miss }],
        spliceLines(drifted, dupAt, len, newLines),
        undefined,
        "apply",
        dupAt,
      )
  }

  // pure insert positioned by a line-number header alone
  {
    const at = 15 + Math.floor(rand() * (lines.length - 30))
    yield simple(
      "hint-insert",
      lines,
      [{ oldLines: [], newLines: ["// inserted"], hint: at }],
      spliceLines(lines, at + 1, 0, ["// inserted"]),
      undefined,
      "apply",
      at + 1,
    )
  }

  // fuzzy duplicate earlier + exact match later — best-score must win
  {
    const { start, len } = pickRegion(5, 8)
    const oldLines = lines.slice(start, start + len)
    const fuzzy = [...oldLines]
    fuzzy[1] = "const __fuzzyTwin = true"
    const dupAt = Math.max(0, start - 12)
    const dupped = spliceLines(lines, dupAt, 0, fuzzy)
    if (exactCount(dupped, oldLines) !== 1) return
    const target = start + len
    const newLines = mutate(oldLines)
    yield simple("dup-fuzzy", dupped, [{ oldLines, newLines }], spliceLines(dupped, target, len, newLines), [
      { start, oldLines, newLines },
    ], "apply", target)
  }

  // ordered duplicates: two chunks consume the two occurrences in order
  {
    const { start, len } = pickRegion(3, 5)
    const oldLines = lines.slice(start, start + len)
    if (oldLines.filter((line) => line.trim()).length < 2) return
    const dupAt = Math.max(0, start - 10)
    const dupped = spliceLines(lines, dupAt, 0, oldLines)
    if (exactCount(dupped, oldLines) !== 2) return
    const target = start + len
    const newA = mutate(oldLines)
    const newB = mutate(oldLines).map((line) => line + "2")
    yield simple(
      "ordered-dup",
      dupped,
      [
        { oldLines, newLines: newA },
        { oldLines, newLines: newB },
      ],
      spliceLines(spliceLines(dupped, dupAt, len, newA), target, len, newB),
    )
  }

  // out-of-order chunks
  {
    const a = pickRegion()
    const b = pickRegion()
    const [first, second] = a.start < b.start ? [a, b] : [b, a]
    if (second.start - first.start < first.len + 4) return
    const oldA = lines.slice(first.start, first.start + first.len)
    const oldB = lines.slice(second.start, second.start + second.len)
    if (exactCount(lines, oldA) !== 1 || exactCount(lines, oldB) !== 1) return
    const newA = mutate(oldA)
    const newB = mutate(oldB)
    yield simple(
      "out-of-order",
      lines,
      [
        { oldLines: oldB, newLines: newB },
        { oldLines: oldA, newLines: newA },
      ],
      spliceLines(spliceLines(lines, second.start, second.len, newB), first.start, first.len, newA),
      [
        { start: first.start, oldLines: oldA, newLines: newA },
        { start: second.start, oldLines: oldB, newLines: newB },
      ],
    )
  }

  // eof
  {
    const len = 4
    const start = lines.length - len
    const oldLines = lines.slice(start)
    if (exactCount(lines, oldLines) !== 1) return
    const newLines = mutate(oldLines)
    yield simple("eof", lines, [{ oldLines, newLines, endOfFile: true }], spliceLines(lines, start, len, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // blank context lines inside the pattern
  {
    const { start, len } = pickRegion(5, 9)
    const oldLines = lines.slice(start, start + len)
    if (!oldLines.includes("") || exactCount(lines, oldLines) !== 1) return
    const newLines = mutate(oldLines)
    yield simple("blank-ctx", lines, [{ oldLines, newLines }], spliceLines(lines, start, len, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // single-line replace, unique line
  {
    const candidates = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.trim().length > 8)
    const unique = candidates.find(({ line }) => lines.indexOf(line) === lines.lastIndexOf(line))
    if (unique) {
      yield simple(
        "single-line",
        lines,
        [{ oldLines: [unique.line], newLines: [`${unique.line} // patched`] }],
        spliceLines(lines, unique.i, 1, [`${unique.line} // patched`]),
        [{ start: unique.i, oldLines: [unique.line], newLines: [`${unique.line} // patched`] }],
      )
    }
  }

  // single-line replace on a line that occurs 3+ times — reject
  {
    const counts = new Map<string, number>()
    for (const line of lines) if (line.trim()) counts.set(line, (counts.get(line) ?? 0) + 1)
    const dup = [...counts.entries()].find(([, count]) => count >= 3)
    if (dup) {
      yield simple("single-line-dup", lines, [{ oldLines: [dup[0]], newLines: ["// replaced"] }], lines, undefined, "reject")
    }
  }

  // edge fuzz: short pattern whose last context line drifted — score alone can't reach τ.
  // Locate via the surviving core; replacement still covers the full original span
  // (patch-wins semantics, same as interior drift).
  {
    const len = 3
    const { start } = pickRegion(len, len + 1)
    const oldLines = lines.slice(start, start + len)
    if (oldLines.some((line) => !line.trim()) || exactCount(lines, oldLines) !== 1) return
    const drifted = [...lines]
    drifted[start + len - 1] = "/* boundary line changed entirely */"
    const newLines = [...mutate(oldLines.slice(0, -1)), oldLines.at(-1)!] // last line stays context in both
    yield simple("fuzz-tail", drifted, [{ oldLines, newLines }], spliceLines(drifted, start, len, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // context line itself is ambiguous: context appears twice, block follows only one
  {
    const { start, len } = pickRegion(4, 6)
    const context = lines[start - 1]!
    if (context.trim() && lines.indexOf(context) !== lines.lastIndexOf(context)) {
      const oldLines = lines.slice(start, start + len)
      if (exactCount(lines, oldLines) !== 1) return
      const newLines = mutate(oldLines)
      yield simple(
        "ctx-ambiguous",
        lines,
        [{ oldLines, newLines, changeContext: context.trim() }],
        spliceLines(lines, start, len, newLines),
        [{ start, oldLines, newLines }],
      )
    }
  }

  // crlf endings in the region
  {
    const { start, len } = pickRegion(4, 7)
    const oldLines = lines.slice(start, start + len)
    const drifted = spliceLines(lines, start, len, oldLines.map((line) => line + "\r"))
    if (exactCount(drifted, oldLines) > 1) return
    const newLines = mutate(oldLines)
    yield simple("crlf", drifted, [{ oldLines, newLines }], spliceLines(drifted, start, len, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // long region with one drifted line
  {
    const len = 16
    if (lines.length > 60) {
      const start = 10 + Math.floor(rand() * (lines.length - len - 20))
      const oldLines = lines.slice(start, start + len)
      const drifted = [...lines]
      drifted[start + 7] = "const __longRegionDrift = true"
      if (exactCount(drifted, oldLines) > 1) return
      const newLines = mutate(oldLines)
      yield simple("long-region", drifted, [{ oldLines, newLines }], spliceLines(drifted, start, len, newLines), [
        { start, oldLines, newLines },
      ])
    }
  }

  // pure insert anchored by context — intent is "insert after the context line"
  {
    const at = 15 + Math.floor(rand() * (lines.length - 30))
    const context = lines[at]!
    if (context.trim() && exactCount(lines, [context]) === 1) {
      yield simple("insert-ctx", lines, [{ oldLines: [], newLines: ["// inserted"], changeContext: context.trim() }], spliceLines(lines, at + 1, 0, ["// inserted"]))
    }
  }

  // file gained a line inside the region — no contiguous window can match
  {
    const { start, len } = pickRegion(6, 10)
    const oldLines = lines.slice(start, start + len)
    if (oldLines.filter((line) => line.trim()).length < 4 || exactCount(lines, oldLines) !== 1) return
    const grown = spliceLines(lines, start + Math.floor(len / 2), 0, ["    // externally inserted line"])
    const newLines = mutate(oldLines)
    yield simple(
      "grown-region",
      grown,
      [{ oldLines, newLines }],
      spliceLines(spliceLines(grown, start, Math.floor(len / 2), newLines.slice(0, Math.floor(len / 2))), start + Math.floor(len / 2) + 1, len - Math.floor(len / 2), newLines.slice(Math.floor(len / 2))),
      [{ start, oldLines, newLines }],
    )
  }

  // file deleted a line inside the region — pattern is longer than the window
  {
    const { start, len } = pickRegion(6, 10)
    const oldLines = lines.slice(start, start + len)
    if (oldLines.filter((line) => line.trim()).length < 4 || exactCount(lines, oldLines) !== 1) return
    const cut = Math.floor(len / 2)
    const shrunk = spliceLines(lines, start + cut, 1, [])
    // patch still describes the pre-deletion block; expected = replace the surviving
    // prefix+suffix windows, i.e. apply patch over the original span minus the cut.
    const newLines = mutate(oldLines)
    yield simple(
      "shrunk-region",
      shrunk,
      [{ oldLines, newLines }],
      spliceLines(spliceLines(shrunk, start, cut, newLines.slice(0, cut)), start + cut, len - cut - 1, newLines.slice(cut + 1)),
      [{ start, oldLines, newLines }],
    )
  }

  // two-line pattern — weakest signal, most ambiguous-prone
  {
    const { start } = pickRegion(2, 3)
    const oldLines = lines.slice(start, start + 2)
    if (oldLines.some((line) => !line.trim()) || exactCount(lines, oldLines) !== 1) return
    const newLines = mutate(oldLines)
    yield simple("two-line", lines, [{ oldLines, newLines }], spliceLines(lines, start, 2, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // tabs vs spaces indent drift
  {
    const { start, len } = pickRegion(4, 7)
    const oldLines = lines.slice(start, start + len)
    if (!oldLines.every((line) => line.startsWith("  ")) || exactCount(lines, oldLines) !== 1) return
    const drifted = spliceLines(lines, start, len, oldLines.map((line) => line.replace(/^ +/, (m) => "\t".repeat(m.length / 2))))
    if (exactCount(drifted, oldLines) > 1) return
    const newLines = mutate(oldLines)
    yield simple("tab-indent", drifted, [{ oldLines, newLines }], spliceLines(drifted, start, len, newLines), [
      { start, oldLines, newLines },
    ])
  }

  // multi-chunk where the second chunk's first context line drifted
  {
    const a = pickRegion()
    const b = pickRegion()
    const [first, second] = a.start < b.start ? [a, b] : [b, a]
    if (second.start - first.start < first.len + 4) return
    const oldA = lines.slice(first.start, first.start + first.len)
    const oldB = lines.slice(second.start, second.start + second.len)
    if (exactCount(lines, oldA) !== 1 || exactCount(lines, oldB) !== 1) return
    const drifted = [...lines]
    drifted[second.start] = "const __chunkTwoAnchorDrift = true"
    if (exactCount(drifted, oldB) > 1) return
    const newA = mutate(oldA)
    const newB = mutate(oldB)
    yield simple(
      "chunk2-drift",
      drifted,
      [
        { oldLines: oldA, newLines: newA },
        { oldLines: oldB, newLines: newB },
      ],
      spliceLines(spliceLines(drifted, second.start, second.len, newB), first.start, first.len, newA),
      [
        { start: first.start, oldLines: oldA, newLines: newA },
        { start: second.start, oldLines: oldB, newLines: newB },
      ],
    )
  }
}

// ---------- git apply reference ----------

const tmp = mkdtempSync(path.join(tmpdir(), "patch-bench-"))

function gitApply(c: Case): "ok" | "wrong" | "fail" {
  if (!c.diff) return "fail"
  const target = path.join(tmp, c.file)
  try {
    writeFileSync(target, c.original)
    writeFileSync(path.join(tmp, "p.diff"), c.diff)
    execFileSync("git", ["apply", "--whitespace=nowarn", "p.diff"], { cwd: tmp, stdio: "pipe" })
    return readFileSync(target, "utf8") === c.expected ? "ok" : "wrong"
  } catch {
    return "fail"
  } finally {
    rmSync(target, { force: true })
  }
}

// ---------- runner ----------

const algos: Record<string, Algo> = {
  baseline,
  "v1(shipped)": scoredAnchor(0.7, true),
  v2: v2({ margin: 0.1 }),
  "v2-m15": v2({ margin: 0.15 }),
  "v2-m20": v2({ margin: 0.2 }),
  "v2-m01": v2({ margin: 0.01 }),
  lcs: lcsAlign,
}

const repoRoot = path.resolve(import.meta.dir, "../../..")
const glob = new Bun.Glob("packages/{core,forge}/src/**/*.ts")
const files: string[] = []
for await (const entry of glob.scan({ cwd: repoRoot, absolute: true })) {
  if (entry.includes("node_modules") || entry.includes("generated")) continue
  files.push(entry)
}
files.sort()

// Best match achievable at a fixed position when the file gained/lost interior
// lines: split the pattern at k, score head at pos and tail at pos+k+gap,
// skipping |s| pattern lines when the file shrank. Mirrors v2's splitMatch.
const splitScoreAt = (lines: ReadonlyArray<string>, oldLines: ReadonlyArray<string>, pos: number): number => {
  const len = oldLines.length
  let best = 0
  for (let k = 2; k <= len - 2; k++) {
    const hScore = windowScore(lines, oldLines.slice(0, k), pos)
    if (hScore < 0.85) continue
    for (const s of [-2, -1, 1, 2]) {
      const tail = oldLines.slice(k + Math.max(0, -s))
      if (tail.length < 2) continue
      const tScore = windowScore(lines, tail, pos + k + Math.max(0, s))
      if (tScore < 0.85) continue
      best = Math.max(best, (hScore * k + tScore * tail.length) / (k + tail.length))
    }
  }
  return best
}

// An apply-case is objectively ambiguous when the intended spot isn't the file's
// unique exact match AND another non-overlapping window is a defensible rival —
// either strong in absolute terms (>=0.8) or within 0.1 of what the intended
// spot itself can achieve. Both placements are defensible readings of the
// patch, so rejection is the correct outcome.
const relabel = (c: Case): Case => {
  if (c.expect !== "apply" || c.at === undefined || c.chunks.length !== 1) return c
  const chunk = c.chunks[0]!
  // a line-number hint is extra positional evidence — ambiguous only when two
  // disjoint strong windows sit inside the stated neighborhood
  if (chunk.hint !== undefined) {
    if (chunk.oldLines.length === 0) return c
    const mutated = splitLines(c.original)
    const radius = Math.max(15, chunk.oldLines.length * 3)
    const strong: number[] = []
    for (let p = Math.max(0, chunk.hint - radius); p <= Math.min(mutated.length - chunk.oldLines.length, chunk.hint + radius); p++)
      if (windowScore(mutated, chunk.oldLines, p) >= 0.8) strong.push(p)
    return strong.length > 0 && strong.at(-1)! - strong[0]! >= chunk.oldLines.length ? { ...c, expect: "reject" } : c
  }
  if (chunk.oldLines.length === 0) return c
  const mutated = splitLines(c.original)
  const len = chunk.oldLines.length
  // A context anchor only disambiguates when exactly one fuzzy occurrence of
  // it is followed by a plausible match — the generator checks exact
  // uniqueness, but matching accepts quality >=0.85 lines.
  if (chunk.changeContext) {
    const positions = mutated.map((line, i) => (lineQuality(line, chunk.changeContext!) >= 0.85 ? i : -1)).filter((i) => i >= 0)
    const direct = positions.filter((i) => windowScore(mutated, chunk.oldLines, i + 1) >= TAU)
    // interior anchoring only runs when every direct anchor missed
    const anchors =
      direct.length > 0
        ? direct
        : positions
            .flatMap((pos) =>
              chunk.oldLines.flatMap((line, j) =>
                lineQuality(line, chunk.changeContext!) >= 0.85 && pos - j >= 0 ? [pos - j] : [],
              ),
            )
            .filter((s) => windowScore(mutated, chunk.oldLines, s) >= TAU)
    return anchors.length > 1 ? { ...c, expect: "reject" } : c
  }
  const startIsExact = chunk.oldLines.every((l, i) => mutated[c.at! + i] === l)
  const exactTotal = exactCount(mutated, chunk.oldLines)
  if (startIsExact && exactTotal === 1) {
    if (process.env.RIVAL_COUNT) {
      const rivals = []
      for (let p = 0; p <= mutated.length - len; p++) {
        if (Math.abs(p - c.at!) < len) continue
        const s = windowScore(mutated, chunk.oldLines, p)
        if (s >= 0.8) rivals.push(s)
      }
      if (rivals.length) console.log(`exact-unique ${c.category} ${c.file} rivals>=0.8: ${rivals.map((s) => s.toFixed(2)).join(",")}`)
    }
    return c
  }
  // Discounted score achievable at pos via edge-fuzz trims of context lines —
  // the same visibility v2 has: a trimmed core is a candidate when its raw
  // window scores >=TAU, and it competes at score*(matchedLen/fullLen).
  const fuzzScores = (lines: ReadonlyArray<string>, at: number) => {
    const out: number[] = []
    let old_ = [...chunk.oldLines]
    let new_ = [...chunk.newLines]
    let head = 0
    let tail = 0
    while (old_.length > 0) {
      if (tail < 2 && old_.at(-1) === new_.at(-1)) {
        old_ = old_.slice(0, -1)
        new_ = new_.slice(0, -1)
        tail++
      } else if (head < 2 && old_[0] === new_[0]) {
        old_ = old_.slice(1)
        new_ = new_.slice(1)
        head++
      } else break
      const raw = windowScore(lines, old_, at + head)
      if (raw >= TAU) out.push((raw * old_.length) / len)
    }
    return out
  }
  const fuzzAt = (lines: ReadonlyArray<string>, at: number) => Math.max(0, ...fuzzScores(lines, at))

  const intended = Math.max(
    windowScore(mutated, chunk.oldLines, c.at),
    splitScoreAt(mutated, chunk.oldLines, c.at),
    fuzzAt(mutated, c.at),
  )
  let rival: { p: number; score: number } | undefined
  for (let p = 0; p <= mutated.length - len; p++) {
    if (Math.abs(p - c.at!) < len) continue
    const score = windowScore(mutated, chunk.oldLines, p)
    if (!rival || score > rival.score) rival = { p, score }
    // a defensible rival placement, or a near-tie with the drifted intent
    // (weak coincidental windows below 0.7 don't count as near-ties)
    if (score >= 0.8 || (score >= 0.7 && score >= intended - 0.1)) {
      if (process.env.RELABEL_DEBUG) console.log(`relabel->reject ${c.category} ${c.file} at=${c.at} intent=${intended.toFixed(3)} rival=${p}@${score.toFixed(3)}`)
      return { ...c, expect: "reject" }
    }
    // weak-evidence intent (<TAU direct) is also threatened by coincidental
    // trimmed cores that v2 would surface as discounted candidates
    if (intended < TAU && fuzzAt(mutated, p) >= intended - 0.1) {
      if (process.env.RELABEL_DEBUG) console.log(`relabel->reject ${c.category} ${c.file} at=${c.at} intent=${intended.toFixed(3)} fuzz-rival=${p}@${fuzzAt(mutated, p).toFixed(3)}`)
      return { ...c, expect: "reject" }
    }
  }
  if (process.env.RELABEL_DEBUG) console.log(`relabel->apply  ${c.category} ${c.file} at=${c.at} intent=${intended.toFixed(3)} exact=${startIsExact}/${exactTotal} best-rival=${rival ? `${rival.p}@${rival.score.toFixed(3)}` : "none"}`)
  return c
}

const rand = mulberry32(1337)
const cases: Case[] = []
for (const file of files) {
  if (cases.length >= 900) break
  const content = readFileSync(file, "utf8")
  for (const c of generate(path.basename(file), content, rand)) cases.push(relabel(c))
}

type Counts = { ok: number; wrong: number; fail: number; good: number; bad: number; ms: number }
const fresh = (): Counts => ({ ok: 0, wrong: 0, fail: 0, good: 0, bad: 0, ms: 0 })
const table = new Map<string, Map<string, Counts>>()
const verbose = process.argv.includes("--verbose")
const badCases: Array<{ category: string; file: string; algo: string; outcome: string }> = []
const record = (
  category: string,
  name: string,
  outcome: "ok" | "wrong" | "fail",
  expect: "apply" | "reject",
  ms = 0,
  detail = "",
) => {
  const row = table.get(category) ?? new Map<string, Counts>()
  const c = row.get(name) ?? fresh()
  c[outcome]++
  const good = expect === "apply" ? outcome === "ok" : outcome === "fail"
  if (good) c.good++
  else {
    c.bad++
    if (verbose) badCases.push({ category, file: detail, algo: name, outcome })
  }
  c.ms += ms
  row.set(name, c)
  table.set(category, row)
}

for (const c of cases) {
  const lines = splitLines(c.original)
  for (const [name, algo] of Object.entries(algos)) {
    const start = performance.now()
    let outcome: "ok" | "wrong" | "fail"
    let err = ""
    gapRecording = name === "v2"
    const gapBase = gapEvents.length
    if (process.env.DUMP && name === "v2") console.log(`\n>>> ${c.category} ${c.file} expect=${c.expect}`)
    try {
      const produced = applyReplacements(lines, algo(lines, c.chunks))
      outcome = produced === c.expected ? "ok" : "wrong"
      if (process.env.DUMP && name === "v2" && outcome === "wrong" && c.expect === "apply") {
        const got = splitLines(produced)
        const want = splitLines(c.expected)
        const diffAt = got.findIndex((l, i) => l !== want[i])
        console.log(`  produced!=expected first diff at line ${diffAt}: got=${JSON.stringify(got[diffAt])} want=${JSON.stringify(want[diffAt])}`)
      }
    } catch (e) {
      outcome = "fail"
      err = e instanceof Error ? e.message.split("\n")[0]! : String(e)
    }
    gapRecording = false
    if (name === "v2") for (let i = gapBase; i < gapEvents.length; i++) { gapEvents[i]!.outcome = outcome; gapEvents[i]!.category = c.category }
    record(c.category, name, outcome, c.expect, performance.now() - start, `${c.file} ${err}`)
    if (process.env.DUMP && name === "v2" && outcome !== "ok" && c.expect === "apply") {
      console.log(`\n### ${c.category} ${c.file} -> ${outcome} ${err}`)
      for (const ch of c.chunks) console.log(`chunk ctx=${ch.changeContext} eof=${ch.endOfFile} old=${JSON.stringify(ch.oldLines)}`)
    }
  }
  // shipped implementation end-to-end
  {
    const start = performance.now()
    try {
      const result = Patch.derive(c.file, c.chunks, c.original).content
      record(c.category, "shipped", result === c.expected ? "ok" : "wrong", c.expect, performance.now() - start)
    } catch {
      record(c.category, "shipped", "fail", c.expect, performance.now() - start)
    }
  }
  record(c.category, "git-apply", gitApply(c), c.expect)
}

rmSync(tmp, { recursive: true, force: true })

const algoNames = [...Object.keys(algos), "shipped", "git-apply"]
console.log(`\n${cases.length} cases  (reject-cases: ${cases.filter((c) => c.expect === "reject").length})\n`)
const header = ["category", ...algoNames.flatMap((n) => [`${n} ok`, "wrong", "fail"])]
console.log(header.join("\t"))
const totals = new Map<string, Counts>()
for (const [category, row] of [...table.entries()].sort()) {
  const cells = algoNames.flatMap((name) => {
    const c = row.get(name) ?? fresh()
    const t = totals.get(name) ?? fresh()
    for (const k of ["ok", "wrong", "fail", "good", "bad", "ms"] as const) t[k] += c[k]
    totals.set(name, t)
    return [c.ok, c.wrong, c.fail].map(String)
  })
  console.log([category, ...cells].join("\t"))
}
console.log(
  [
    "TOTAL ok/wrong/fail",
    ...algoNames.flatMap((n) => {
      const t = totals.get(n)!
      return [t.ok, t.wrong, t.fail].map(String)
    }),
  ].join("\t"),
)
console.log(["GOOD", ...algoNames.map((n) => String(totals.get(n)!.good))].join("\t"))
console.log(["BAD", ...algoNames.map((n) => String(totals.get(n)!.bad))].join("\t"))
console.log(["avg-ms", ...algoNames.map((n) => (totals.get(n)!.ms / cases.length).toFixed(2))].join("\t"))

if (verbose) {
  console.log("\n--- bad cases ---")
  for (const b of badCases) console.log(`${b.algo}\t${b.category}\t${b.outcome}\t${b.file}`)
}

if (process.env.GAPS) {
  console.log("\n--- v2 score-gap distribution (gap = best - best non-overlapping runner-up) ---")
  const buckets = [0, 0.01, 0.03, 0.05, 0.1, 0.2, 0.4, 1.01]
  for (const outcome of ["ok", "wrong", "fail"]) {
    const evts = gapEvents.filter((e) => e.outcome === outcome)
    const hist = buckets.slice(1).map((hi, i) => evts.filter((e) => e.gap > buckets[i]! && e.gap <= hi).length)
    console.log(`${outcome}\t${evts.length}\tbuckets [<.01,.03,.05,.1,.2,.4,> .4]: ${hist.join(" ")}`)
    const rs = [0.7, 0.8, 0.9, 0.95, 1.01]
    const rhist = rs.slice(1).map((hi, i) => evts.filter((e) => (e.runnerScore ?? 0) > rs[i]! && (e.runnerScore ?? 0) <= hi).length)
    console.log(`   runnerUp-score buckets [<.7,.8,.9,.95,> .95]: ${rhist.join(" ")}`)
    for (const e of evts.filter((e) => e.gap <= 0.1 && outcome !== "ok").slice(0, 20))
      console.log(`   ${outcome} gap=${e.gap.toFixed(3)} score=${e.score.toFixed(3)} ${e.category}`)
  }
}
