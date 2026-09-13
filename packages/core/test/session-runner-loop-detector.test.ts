import { describe, expect, test } from "bun:test"
import { SessionRunnerLoopDetector } from "@turenlabs/core/session/runner/loop-detector"

const feed = (text: string, chunk = 24) => {
  const detector = SessionRunnerLoopDetector.make()
  let tripped = false
  for (let i = 0; i < text.length; i += chunk) if (detector.observe(text.slice(i, i + chunk))) tripped = true
  return tripped
}

// Verbatim tail of a real degenerate turn: a handful of phrases cycling until the output budget ran
// out. Measured at 4% distinct words and 24% distinct trigrams.
const LOOP_PHRASES = [
  "The tests run.",
  "Running the sibling tests now.",
  "Run.",
  "Now.",
  "The sibling tests.",
  "Running.",
  "Run now.",
  "Run the tests.",
  "The sibling suite — run now.",
  "Run them.",
]

const looping = (lines: number) =>
  Array.from({ length: lines }, (_, i) => LOOP_PHRASES[i % LOOP_PHRASES.length]).join("\n")

// Ordinary explanatory output. Assembled from independent pools with coprime sizes so the phrasing
// keeps turning over across a window, which is the property real prose has and a loop does not.
const SUBJECT = [
  "the reviewer",
  "each proposal",
  "one snapshot",
  "the parent turn",
  "every directive",
  "this migration",
  "the confined runtime",
]
const VERB = ["reads", "replaces", "retains", "rejects", "records", "interrupts", "adopts", "skips"]
const OBJECT = [
  "whatever the session already settled",
  "the whole list of standing instructions",
  "every earlier version for rollback",
  "a tool whose source cannot parse",
  "the outcome the provider settled on",
  "a child that stopped making progress",
  "the newest existing reviewer",
  "a prompt unchanged since the last pass",
  "content beyond the byte ceiling",
]

const prose = (sentences: number) =>
  Array.from(
    { length: sentences },
    (_, i) => `${SUBJECT[i % SUBJECT.length]} ${VERB[i % VERB.length]} ${OBJECT[i % OBJECT.length]}.`,
  ).join(" ")

describe("session runner loop detector", () => {
  test("ends a turn that cycles a handful of phrases", () => {
    expect(feed(looping(300))).toBe(true)
  })

  test("leaves dense source code alone", () => {
    // Real parser output sits at 12-18% distinct words, close enough to a loop that a vocabulary
    // threshold alone would abort it. Its phrasing still varies, which is what keeps it safe here.
    const code = [
      "function readBack(code, dotIdx) {",
      "let i = dotIdx - 1;",
      "while (i >= 0 && WS.test(code[i])) i--;",
      "if (c === ')' || c === ']' || c === '}') depth--;",
      "else if (c === ',' && depth === 0) { parts.push(text.slice(last, i)); last = i + 1; }",
      "for (let j = 0; j < src.length; j++) if (src.charAt(j) === '\\n') arr.push(j + 1);",
      "function lineOf(arr, pos) { let lo = 0; let hi = arr.length - 1; }",
      "while (lo < hi) { const mid = (lo + hi + 1) >> 1; }",
      "if (arr[mid] <= pos) lo = mid; else hi = mid - 1;",
      "return lo + 1; }",
    ].join("\n")
    expect(feed([code, code.replace(/i/g, "k"), code.replace(/depth/g, "level")].join("\n"))).toBe(false)
  })

  test("leaves ordinary prose alone", () => {
    expect(feed(prose(60))).toBe(false)
  })

  test("leaves one intentionally repetitive delta alone", () => {
    expect(feed(`Answer 1. ${"prose reply segment. ".repeat(400)}`, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  test("accepts a multi-megabyte delta without exhausting the call stack", () => {
    expect(feed(`word ${"payload ".repeat(450_000)}`, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  test("judges a window rather than the whole message, so a late collapse still trips", () => {
    expect(feed(`${prose(40)}\n${looping(300)}`)).toBe(true)
  })

  test("reports once, so the turn is ended a single time", () => {
    const detector = SessionRunnerLoopDetector.make()
    const trips = looping(300)
      .split("\n")
      .filter((line) => detector.observe(`${line}\n`)).length
    expect(trips).toBe(1)
  })

  test("reaches the same verdict however the deltas are split", () => {
    const samples = [looping(300), prose(60), `${prose(40)}\n${looping(300)}`]
    for (const text of samples) {
      // A single giant delta yields at most one window check, which cannot
      // satisfy REQUIRED_COLLAPSED_DELTAS — invariance holds up to deltas that
      // still allow four checks.
      expect(feed(text, 1)).toBe(feed(text, 24))
      expect(feed(text, 1)).toBe(feed(text, 512))
    }
  })
})
