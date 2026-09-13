export * as Patch from "./patch"

export type Hunk =
  | { readonly type: "add"; readonly path: string; readonly contents: string }
  | { readonly type: "delete"; readonly path: string }
  | {
      readonly type: "update"
      readonly path: string
      readonly movePath?: string
      readonly chunks: ReadonlyArray<UpdateFileChunk>
    }

export interface UpdateFileChunk {
  readonly oldLines: ReadonlyArray<string>
  readonly newLines: ReadonlyArray<string>
  readonly changeContext?: string
  readonly endOfFile?: boolean
  /**
   * 0-based start line carried by unified-diff-style `@@ -start,count @@`
   * headers. A soft positional prior only: it never forces a placement the
   * text evidence rejects, but it can single out a strong window when the
   * textual score alone cannot.
   */
  readonly hint?: number
}

export interface FileUpdate {
  readonly content: string
  readonly bom: boolean
}

export function parse(patchText: string): ReadonlyArray<Hunk> {
  const lines = stripHeredoc(patchText.trim()).split("\n")
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const end = lines.findIndex((line) => line.trim() === "*** End Patch")
  if (begin === -1 || end === -1 || begin >= end) throw new Error("Invalid patch format: missing Begin/End markers")

  const hunks: Hunk[] = []
  let index = begin + 1
  while (index < end) {
    const line = lines[index]!
    if (line === "") {
      index++
      continue
    }
    if (line.startsWith("*** Add File:")) {
      const path = line.slice("*** Add File:".length).trim()
      if (!path) throw new Error("Invalid add file path")
      const parsed = parseAdd(lines, index + 1)
      hunks.push({ type: "add", path, contents: parsed.content })
      index = parsed.next
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      const path = line.slice("*** Delete File:".length).trim()
      if (!path) throw new Error("Invalid delete file path")
      hunks.push({ type: "delete", path })
      index++
      continue
    }
    if (line.startsWith("*** Update File:")) {
      const path = line.slice("*** Update File:".length).trim()
      if (!path) throw new Error("Invalid update file path")
      let next = index + 1
      let movePath: string | undefined
      if (lines[next]?.startsWith("*** Move to:")) {
        movePath = lines[next]!.slice("*** Move to:".length).trim()
        if (!movePath) throw new Error("Invalid move file path")
        next++
      }
      const parsed = parseUpdate(lines, next)
      if (parsed.chunks.length === 0 && !movePath)
        throw new Error(`Invalid update hunk for ${path}: expected at least one @@ chunk`)
      hunks.push({ type: "update", path, movePath, chunks: parsed.chunks })
      index = parsed.next
      continue
    }
    throw new Error(`Invalid patch line: ${line}`)
  }
  return hunks
}

export function derive(path: string, chunks: ReadonlyArray<UpdateFileChunk>, original: string): FileUpdate {
  const source = splitBom(original)
  // Preserve the file's dominant line ending so updates don't mix CRLF and LF.
  const crlf = (source.text.split("\r\n").length - 1) * 2 > source.text.split("\n").length - 1
  const lines = source.text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (crlf) for (let i = 0; i < lines.length; i++) lines[i] = lines[i]!.replace(/\r$/, "")
  const replacements = computeReplacements(lines, path, chunks)
  const updated = [...lines]
  for (const [start, remove, insert] of replacements.toReversed()) updated.splice(start, remove, ...insert)
  if (updated.at(-1) !== "") updated.push("")
  const next = splitBom(updated.join(crlf ? "\r\n" : "\n"))
  return { content: next.text, bom: source.bom || next.bom }
}

export function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function parseAdd(lines: ReadonlyArray<string>, start: number) {
  const content: string[] = []
  let index = start
  while (index < lines.length && !lines[index]!.startsWith("***")) {
    if (!lines[index]!.startsWith("+")) throw new Error(`Invalid add file line: ${lines[index]}`)
    content.push(lines[index]!.slice(1))
    index++
  }
  return { content: content.join("\n"), next: index }
}

function parseUpdate(lines: ReadonlyArray<string>, start: number) {
  const chunks: UpdateFileChunk[] = []
  let index = start
  while (index < lines.length && !lines[index]!.startsWith("***")) {
    if (lines[index] === "") {
      index++
      continue
    }
    if (!lines[index]!.startsWith("@@")) {
      throw new Error(`Invalid update file line: ${lines[index]}`)
    }
    const header = lines[index]!.slice(2).trim()
    // Unified-diff habit: models often emit `@@ -12,5 +12,6 @@` or
    // `@@ -12,5 +12,6 @@ function foo`. The numbers are unreliable as
    // coordinates but useful as a positional prior; text after the closing
    // @@ remains usable as a context line.
    const hintMatch = header.match(/^-(\d+)(?:,\d+)?(?:\s+\+\d+(?:,\d+)?)?(?:\s*@@(.*)|\s*@@?\s*(.*))?$/)
    const hint = hintMatch ? Math.max(0, Number.parseInt(hintMatch[1]!, 10) - 1) : undefined
    const changeContext =
      (hintMatch ? (hintMatch[2] ?? hintMatch[3] ?? "") : header).replace(/\s*@@+\s*$/, "").trim() || undefined
    const oldLines: string[] = []
    const newLines: string[] = []
    let endOfFile = false
    index++
    while (index < lines.length && !lines[index]!.startsWith("@@")) {
      const line = lines[index]!
      if (line === "*** End of File") {
        endOfFile = true
        index++
        break
      }
      if (line.startsWith("***")) break
      if (line === "") {
        oldLines.push("")
        newLines.push("")
      } else if (line.startsWith(" ")) {
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith("-")) oldLines.push(line.slice(1))
      else if (line.startsWith("+")) newLines.push(line.slice(1))
      else throw new Error(`Invalid update chunk line: ${line}`)
      index++
    }
    chunks.push({ oldLines, newLines, changeContext, endOfFile: endOfFile || undefined, hint })
  }
  return { chunks, next: index }
}

/**
 * Scored-window matching with ambiguity rejection.
 *
 * Every plausible window is scored by mean per-line match quality (exact >
 * trailing-ws > trimmed > normalized) instead of taking the first position
 * that satisfies a weak comparator. The best placement must clear
 * MATCH_THRESHOLD — so a drifted line or whitespace/unicode drift inside a
 * block still matches — and rivals are collected alongside it:
 *
 * - A disjoint window within AMBIGUITY_MARGIN of the top score is a rival.
 * - An exact full-length match is only rivalled by exact-score ties: a
 *   verbatim placement is the natural reading of the patch, and fuzzy
 *   lookalikes cannot contest it.
 * - A fuzzy best (<1.0) is weaker evidence: any disjoint window scoring
 *   STRONG_RIVAL or better makes the placement ambiguous.
 * - Boundary context lines that drifted are trimmed for *location* only
 *   (edge fuzz); the replacement still covers the full original span.
 * - When the file gained or lost interior lines, split candidates match the
 *   pattern head and tail around the drift (each side needs SPLIT_MIN lines)
 *   and carry their own remove/insert spans.
 * - Chunk order disambiguates duplicates: when every rival of a tied set is
 *   matched by a later chunk, the earliest top-scoring candidate wins, and
 *   spans consumed by earlier chunks are excluded.
 *
 * Unresolved rivals reject the patch so the caller can add context instead of
 * silently editing the wrong location.
 */
const MATCH_THRESHOLD = 0.7
const AMBIGUITY_MARGIN = 0.1
const STRONG_RIVAL = 0.8
const SPLIT_MIN = 2
const SPLIT_MIN_SCORE = 0.85

type WindowMatch =
  | {
      readonly type: "found"
      readonly pos: number
      readonly score: number
      readonly runnerUp?: { readonly pos: number; readonly score: number }
    }
  | {
      readonly type: "ambiguous"
      readonly best: { readonly pos: number; readonly score: number }
      readonly rivals: ReadonlyArray<{ readonly pos: number; readonly score: number }>
      readonly runnerUp?: { readonly pos: number; readonly score: number }
    }
  | { readonly type: "missing" }

interface Candidate {
  readonly pos: number
  score: number
  dist: number
  readonly remove?: number
  readonly insert?: ReadonlyArray<string>
  /** matched the full untrimmed pattern — discounted edge-fuzz hits are not full */
  full: boolean
}

function computeReplacements(lines: ReadonlyArray<string>, path: string, chunks: ReadonlyArray<UpdateFileChunk>) {
  const replacements: Array<readonly [start: number, remove: number, insert: ReadonlyArray<string>]> = []
  const consumed: Array<readonly [number, number]> = []
  let lineIndex = 0
  const overlapsConsumed = (pos: number, len: number) => consumed.some(([s, e]) => pos < e && pos + len > s)
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!
    const contexts = chunk.changeContext ? contextCandidates(lines, chunk.changeContext) : []
    if (chunk.changeContext && contexts.length === 0)
      throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`)
    const starts: ReadonlyArray<number> = contexts.length ? contexts.map((pos) => pos + 1) : [lineIndex]

    if (chunk.oldLines.length === 0) {
      if (contexts.length > 1)
        throw new Error(`Context '${chunk.changeContext}' matches multiple locations in ${path}; add more context`)
      const at = contexts.length ? starts[0]! : chunk.hint !== undefined ? chunk.hint + 1 : lines.length
      replacements.push([at, 0, chunk.newLines])
      lineIndex = at
      continue
    }

    const len = chunk.oldLines.length
    const cands: Candidate[] = []
    const push = (
      pos: number,
      score: number,
      dist: number,
      remove?: number,
      insert?: ReadonlyArray<string>,
      full = false,
    ) => {
      if (overlapsConsumed(pos, remove ?? len)) return
      const existing = cands.find((c) => sameCandidate(c, pos, remove, insert))
      if (!existing) {
        cands.push({ pos, score, dist, remove, insert, full })
        return
      }
      existing.score = Math.max(existing.score, score)
      existing.dist = Math.min(existing.dist, dist)
      existing.full = existing.full || full
    }
    const bands = [...starts.map((s) => [s, lines.length - len] as const)]
    if (contexts.length === 0) bands.push([0, Math.min(lineIndex - 1, lines.length - len)])
    const searched: Array<readonly [number, number]> = []
    const scan = (input: ReadonlyArray<readonly [number, number]>) => {
      for (const [lo, hi] of input) {
        searched.push([lo, hi])
        if (chunk.endOfFile) {
          const last = lines.length - len
          if (last >= lo && !overlapsConsumed(last, len) && windowScore(lines, chunk.oldLines, last) >= MATCH_THRESHOLD) {
            push(last, windowScore(lines, chunk.oldLines, last), Math.abs(last - lo), undefined, undefined, true)
            continue
          }
        }
        const match = matchIn(lines, chunk.oldLines, chunk.newLines, lo, hi)
        const full = match.matchedLen === len
        const dist = (pos: number) => Math.abs(pos - lo)
        if (match.type === "found") {
          push(match.pos, match.score, dist(match.pos), undefined, undefined, full)
          if (match.runnerUp) push(match.runnerUp.pos, match.runnerUp.score, dist(match.runnerUp.pos), undefined, undefined, full)
        } else if (match.type === "ambiguous") {
          push(match.pos, match.score, dist(match.pos), undefined, undefined, full)
          for (const rival of match.rivals ?? []) push(rival.pos, rival.score, dist(rival.pos), undefined, undefined, full)
        }
      }
    }
    scan(bands)
    // `@@ ctx` anchors the block right after the context line — but models
    // also point at a line *inside* the block. When every direct anchor
    // missed, retry anchored at pos-j for each pattern line matching ctx.
    if (contexts.length > 0 && cands.length === 0) {
      const interior = [
        ...new Set(
          contexts.flatMap((pos) =>
            chunk.oldLines.flatMap((line, j) =>
              lineQuality(line, chunk.changeContext!) >= 0.85 && pos - j >= 0 ? [pos - j] : [],
            ),
          ),
        ),
      ]
      scan(interior.map((s) => [s, lines.length - len] as const))
    }

    // Interior drift fallback: only when no full-length window matched.
    if (!cands.some((c) => c.full))
      for (const [lo] of searched)
        for (const split of splitMatch(lines, chunk.oldLines, chunk.newLines, lo, lines.length - len))
          push(split.pos, split.score, Math.abs(split.pos - lo), split.remove, split.insert)

    // A line-number header from the model adds its neighborhood as candidates:
    // the stated position may hold a strong window the text-only bands missed
    // (e.g. a verbatim twin elsewhere outscores a drifted intent).
    if (chunk.hint !== undefined) {
      const radius = Math.max(15, len * 3)
      for (const c of voteAll(lines, chunk.oldLines, Math.max(0, chunk.hint - radius), Math.min(lines.length - len, chunk.hint + radius)))
        push(c.pos, c.score, Math.abs(c.pos - chunk.hint))
    }

    if (cands.length === 0) {
      const nearest = nearestWindow(lines, chunk.oldLines)
      const clue = nearest
        ? (() => {
            const idx = chunk.oldLines.findIndex(
              (line, i) => nearest.pos + i >= lines.length || lineQuality(lines[nearest.pos + i]!, line) < 0.85,
            )
            const diff =
              idx === -1
                ? ""
                : nearest.pos + idx >= lines.length
                  ? `; file ends before expected line \`${chunk.oldLines[idx]!.trim()}\``
                  : `; first difference at line ${nearest.pos + idx + 1}: expected \`${chunk.oldLines[idx]!.trim()}\` but found \`${lines[nearest.pos + idx]!.trim()}\``
            return `\nClosest match (score ${nearest.score.toFixed(2)}) starts at line ${nearest.pos + 1}${diff}`
          })()
        : ""
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}${clue}`)
    }

    cands.sort((a, b) => b.score - a.score || a.dist - b.dist || a.pos - b.pos)
    const best = cands[0]!
    const bestExact = best.full && best.score >= 1
    const margin = chunks.length > 1 && bestExact ? 0 : AMBIGUITY_MARGIN
    const tied = cands.slice(1).filter((c) => {
      if (!isRival(c, best, len)) return false
      if (best.score - c.score <= margin) return true
      return Math.abs(c.pos - best.pos) >= len && !bestExact && c.score >= STRONG_RIVAL
    })
    // The model's stated position identifies a unique strong window: prefer it
    // even over a higher-scoring distant candidate — the line number is real
    // evidence the text score lacks. Two disjoint strong windows inside the
    // stated neighborhood are still ambiguous and reject.
    let pick: Candidate | undefined
    if (chunk.hint !== undefined) {
      const radius = Math.max(15, len * 3)
      const strong = cands
        .filter((c) => Math.abs(c.pos - chunk.hint!) <= radius && c.score >= STRONG_RIVAL)
        .sort((a, b) => b.score - a.score || Math.abs(a.pos - chunk.hint!) - Math.abs(b.pos - chunk.hint!))
      const top = strong[0]
      if (top && !strong.every((c) => Math.abs(c.pos - top.pos) < len))
        throw new Error(
          `Expected lines match multiple locations near line ${chunk.hint + 1} in ${path} (lines ${top.pos + 1} and ${strong.find((c) => Math.abs(c.pos - top.pos) >= len)!.pos + 1}); add more context lines or an @@ marker`,
        )
      if (top) pick = top
    }
    pick ??= tied.length === 0 ? best : undefined
    if (!pick) {
      const all = [best, ...tied]
      if (contexts.length > 0) {
        const nearest = Math.min(...all.map((c) => c.dist))
        const near = all.filter((c) => c.dist === nearest)
        if (near.length === 1) pick = near[0]!
      }
      if (!pick) {
        // order disambiguates duplicates: pick the earliest of the top-scoring
        // rivals when the rest are consumed by later chunks
        const top = all.filter((c) => c.score === best.score).sort((a, b) => a.pos - b.pos)
        const rest = all.filter((c) => c.score !== best.score)
        const consumable = (pos: number) =>
          chunks.slice(ci + 1).some((c) => c.oldLines.length > 0 && windowScore(lines, c.oldLines, pos) >= MATCH_THRESHOLD)
        if (top.slice(1).concat(rest).every((c) => consumable(c.pos))) pick = top[0]!
      }
      if (!pick)
        throw new Error(
          `Expected lines match multiple locations in ${path} (lines ${all[0]!.pos + 1} and ${all[1]!.pos + 1}); add more context lines or an @@ marker`,
        )
    }
    const remove = pick.remove ?? len
    replacements.push([pick.pos, remove, pick.insert ?? chunk.newLines])
    consumed.push([pick.pos, pick.pos + remove])
    lineIndex = pick.pos + remove
  }
  return replacements.toSorted((left, right) => left[0] - right[0])
}

/** Two candidates rival each other on different spans, or on the same span
 * with different replacement text (an ambiguous split point). */
const isRival = (c: Candidate, best: Candidate, len: number) =>
  Math.abs(c.pos - best.pos) >= len || !sameCandidate(c, best.pos, best.remove, best.insert)

const sameCandidate = (c: Candidate, pos: number, remove?: number, insert?: ReadonlyArray<string>) =>
  c.pos === pos &&
  c.remove === remove &&
  (c.insert === insert ||
    (!!c.insert && !!insert && c.insert.length === insert.length && c.insert.every((line, i) => line === insert[i])))

/** Best line-by-line match quality between a file line and a pattern line, 0..1. */
function lineQuality(fileLine: string, patternLine: string) {
  if (fileLine === patternLine) return 1
  if (fileLine.trimEnd() === patternLine.trimEnd()) return 0.95
  if (fileLine.trim() === patternLine.trim()) return 0.9
  if (normalize(fileLine.trim()) === normalize(patternLine.trim())) return 0.85
  return 0
}

function windowScore(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, offset: number) {
  if (offset + pattern.length > lines.length) return 0
  let score = 0
  for (let index = 0; index < pattern.length; index++) score += lineQuality(lines[offset + index]!, pattern[index]!)
  return score / pattern.length
}

/** Best-scoring window anywhere in the file — diagnostics only, computed on
 * the failure path so the model sees where the patch nearly matched. */
function nearestWindow(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>) {
  let best: { pos: number; score: number } | undefined
  for (let pos = 0; pos <= lines.length - pattern.length; pos++) {
    const score = windowScore(lines, pattern, pos)
    if (!best || score > best.score) best = { pos, score }
  }
  return best && best.score > 0 ? best : undefined
}

/** All positions where the context line plausibly matches, best quality first. */
function contextCandidates(lines: ReadonlyArray<string>, context: string) {
  const found: Array<{ pos: number; q: number }> = []
  for (let i = 0; i < lines.length; i++) {
    const q = lineQuality(lines[i]!, context)
    if (q >= 0.85) found.push({ pos: i, q })
  }
  return found.sort((a, b) => b.q - a.q || a.pos - b.pos).map((c) => c.pos)
}

/** Every window in [lo, hi] whose pattern lines vote for it, scored. */
function voteAll(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, lo: number, hi: number) {
  if (hi < lo || pattern.length === 0) return []
  const votes = new Map<number, number>()
  for (let i = 0; i < pattern.length; i++)
    for (let pos = lo + i; pos <= hi + i; pos++)
      if (lineQuality(lines[pos]!, pattern[i]!) >= 0.85) votes.set(pos - i, (votes.get(pos - i) ?? 0) + 1)
  const need = Math.max(1, Math.ceil(pattern.length * 0.5))
  const scored: Array<{ pos: number; score: number }> = []
  for (const [pos, count] of votes) {
    if (count < need) continue
    const score = windowScore(lines, pattern, pos)
    if (score >= MATCH_THRESHOLD) scored.push({ pos, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.pos - b.pos)
}

const vote = (lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, lo: number, hi: number): WindowMatch => {
  const scored = voteAll(lines, pattern, lo, hi)
  if (scored.length === 0) return { type: "missing" }
  const best = scored[0]!
  const runnerUp = scored.find((c) => Math.abs(c.pos - best.pos) >= pattern.length)
  const rivals = scored.filter((c) => Math.abs(c.pos - best.pos) >= pattern.length && best.score - c.score <= AMBIGUITY_MARGIN)
  if (rivals.length > 0) return { type: "ambiguous", best, rivals, runnerUp }
  return { type: "found", pos: best.pos, score: best.score, runnerUp }
}

interface Ranked {
  readonly type: "found" | "ambiguous" | "missing"
  readonly pos: number
  readonly score: number
  readonly matchedLen: number
  readonly rivals?: ReadonlyArray<{ readonly pos: number; readonly score: number }>
  readonly runnerUp?: { readonly pos: number; readonly score: number }
}

/** Full-pattern match inside [lo, hi], then edge-fuzz retries that drop drifted
 * boundary context lines (present in both old and new) for *location* only —
 * the replacement always covers the full original span. Scores are discounted
 * by matchedLen/fullLen so a trimmed-core hit never ties an exact one. */
const matchIn = (
  lines: ReadonlyArray<string>,
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
  lo: number,
  hi: number,
): Ranked => {
  const fullLen = oldLines.length
  const discount = (score: number, matchedLen: number) => score * (matchedLen / fullLen)
  let old_ = [...oldLines]
  let new_ = [...newLines]
  let head = 0
  let tail = 0
  const rank = (m: WindowMatch, matchedLen: number): Ranked => {
    if (m.type === "missing") return { type: "missing", pos: -1, score: 0, matchedLen }
    const shift = (pos: number) => {
      const p = pos - head
      return p >= lo && p + fullLen <= lines.length ? p : -1
    }
    const runner =
      m.runnerUp && shift(m.runnerUp.pos) >= 0
        ? { pos: shift(m.runnerUp.pos), score: discount(m.runnerUp.score, matchedLen) }
        : undefined
    if (m.type === "found") {
      const pos = shift(m.pos)
      return pos >= 0
        ? { type: "found", pos, score: discount(m.score, matchedLen), matchedLen, runnerUp: runner }
        : { type: "missing", pos: -1, score: 0, matchedLen }
    }
    const best = { pos: shift(m.best.pos), score: discount(m.best.score, matchedLen) }
    const rivals = m.rivals
      .map((r) => ({ pos: shift(r.pos), score: discount(r.score, matchedLen) }))
      .filter((r) => r.pos >= 0)
    return best.pos >= 0
      ? { type: "ambiguous", pos: best.pos, score: best.score, matchedLen, rivals, runnerUp: runner }
      : { type: "missing", pos: -1, score: 0, matchedLen }
  }
  while (old_.length > 0) {
    const m = vote(lines, old_, lo + head, Math.min(hi, lines.length - fullLen + head))
    const ranked = rank(m, old_.length)
    if (ranked.type !== "missing") return ranked
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
    return ranked
  }
  return { type: "missing", pos: -1, score: 0, matchedLen: 0 }
}

/** Last-resort match when the file gained/lost lines inside the region: split
 * the pattern at k, match the head, then require the tail at pos+k+s
 * (s>0 file grew, s<0 file shrank — skip |s| pattern lines). The insert keeps
 * foreign lines for growth and drops newLines whose old counterpart vanished.
 * newLines is split positionally — fine for 1:1 patches. */
const splitMatch = (
  lines: ReadonlyArray<string>,
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
  lo: number,
  hi: number,
): Array<{ pos: number; remove: number; insert: string[]; score: number }> => {
  const len = oldLines.length
  const out: Array<{ pos: number; remove: number; insert: string[]; score: number }> = []
  for (let k = SPLIT_MIN; k <= len - SPLIT_MIN; k++) {
    const head = oldLines.slice(0, k)
    // the file can shrink by up to 2 lines, so allow heads 2 past the
    // full-window band end; the per-candidate remove bound still applies
    for (const hc of voteAll(lines, head, lo, Math.min(hi + 2, lines.length - k))) {
      for (const s of [-2, -1, 1, 2]) {
        const tail = oldLines.slice(k + Math.max(0, -s))
        if (tail.length < SPLIT_MIN) continue
        const tpos = hc.pos + k + Math.max(0, s)
        const tScore = windowScore(lines, tail, tpos)
        if (tScore < SPLIT_MIN_SCORE) continue
        const score = (hc.score * k + tScore * tail.length) / (k + tail.length)
        if (score < MATCH_THRESHOLD) continue
        const remove = k + Math.max(0, s) + tail.length
        if (hc.pos + remove > lines.length) continue
        const newK = Math.min(Math.round((k * newLines.length) / len), newLines.length)
        const foreign = s > 0 ? lines.slice(hc.pos + k, hc.pos + k + s) : []
        const insert = [...newLines.slice(0, newK), ...foreign, ...newLines.slice(Math.min(newK + Math.max(0, -s), newLines.length))]
        out.push({ pos: hc.pos, remove, insert, score })
      }
    }
  }
  return out
}
const normalize = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const stripHeredoc = (input: string) =>
  input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)?.[2] ?? input
