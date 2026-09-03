/**
 * A/B experiment harness for compaction strategies. EXPERIMENT ONLY — imports production
 * serialization/prompt code read-only and never mutates it.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import {
  buildPrompt,
  serializeMessage as serializeDecodedMessage,
  serializeToolOutput,
  validSummary,
} from "../../../../src/session/compaction"
import type { SessionMessage } from "../../../../src/session/message"
import { Token } from "../../../../src/util/token"

export const SCRATCH =
  "/private/tmp/claude-501/-Users-tom-turen-Code-forge/7ce3569e-ae23-40c1-b51d-c8f9bbf53b19/scratchpad"
export const DATA = `${SCRATCH}/data`
export const CACHE = `${SCRATCH}/llmcache`

export type Msg = Record<string, any> & { readonly id: string; readonly type: string }
export type Entry = { readonly seq: number; readonly message: Msg }

/**
 * Production `serializeMessage` over the experiment's replay rows.
 *
 * `Msg` is a JSONL row read straight off disk: structurally the durable encoding of a
 * `SessionMessage.Message`, but never run through the schema decoder, so TypeScript cannot relate
 * the two. The experiment measures what production *would* serialize byte for byte, so the row is
 * handed to the production serializer unchanged — this wrapper is the single adapter boundary
 * where that reinterpretation happens, instead of a cast at each of the (many) call sites.
 */
export const serializeMessage = (message: Msg): string =>
  serializeDecodedMessage(message as unknown as SessionMessage.Message)

export const load = (id: string): Entry[] =>
  readFileSync(`${DATA}/${id}.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as any
      return { seq: row.seq as number, message: { id: row.id, type: row.type, ...row.data } as Msg }
    })
    // The replay derives its own checkpoints; stored ones would double-count.
    .filter((entry) => entry.message.type !== "compaction")

/** Copy of the private `wireTokens` in compaction.ts (what a message costs on the wire). */
export const wireTokens = (message: Msg): number => {
  if (message.type === "shell") return Token.estimate(message.command ?? "") + Token.estimate(message.output ?? "")
  if (message.type === "assistant")
    return (message.content as any[]).reduce((total: number, part: any) => {
      if (part.type === "text" || part.type === "reasoning") return total + Token.estimate(part.text ?? "")
      if (part.type !== "tool") return total
      const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
      const output = part.state.status === "completed" ? serializeToolOutput(part.state) : ""
      return total + Token.estimate(input) + Token.estimate(output)
    }, 0)
  return Token.estimate(serializeMessage(message))
}

/** Strategy E's view: tool payloads become a one-line reference (name + args + result size). */
export const serializeElided = (message: Msg): string => {
  if (message.type !== "assistant") {
    if (message.type === "shell")
      return `[Shell]: ${message.command}\n[Status]: ${message.status ?? "unknown"}\n[Output]: ${(message.output ?? "").length} bytes`
    return serializeMessage(message)
  }
  return (message.content as any[])
    .flatMap((part: any) => {
      if (part.type === "text") return [`[Assistant]: ${part.text}`]
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
      const args = input.length > 400 ? `${input.slice(0, 400)}…` : input
      if (part.state.status === "completed") {
        const size = serializeToolOutput(part.state).length
        return [`[Assistant tool call]: ${part.name}(${args})`, `[Tool result]: ${part.name} ok, ${size} bytes`]
      }
      if (part.state.status === "error")
        return [
          `[Assistant tool call]: ${part.name}(${args})`,
          `[Tool error]: ${part.name}: ${part.state.error?.message ?? "error"}`,
        ]
      return [`[Assistant tool call]: ${part.name}(${args})`]
    })
    .join("\n")
}

export type Item = { readonly text: string; readonly tokens: number; readonly index: number; readonly start: boolean }

export const items = (entries: readonly Entry[], serializer: (m: Msg) => string): Item[] => {
  const result: Item[] = []
  entries.forEach((entry, index) => {
    const text = serializer(entry.message)
    if (!text) return
    result.push({ text, tokens: wireTokens(entry.message), index, start: entry.message.type === "user" })
  })
  return result
}

/** Verbatim copy of the private `tailStart` in compaction.ts. */
export const tailStart = (list: readonly Item[], options: { tokens: number; turns: number }) => {
  if (options.tokens <= 0) return list.length
  let total = 0
  let greedy = list.length
  for (let index = list.length - 1; index >= 0; index--) {
    const next = total + list[index]!.tokens
    if (next > options.tokens) break
    total = next
    greedy = index
  }
  if (options.turns <= 0) return greedy
  const starts = list.flatMap((item, index) => (item.start ? [index] : []))
  if (starts.length === 0) return greedy
  const floor = starts.length > options.turns ? starts[starts.length - options.turns]! : 0
  const aligned = starts.find((index) => index >= greedy) ?? greedy
  return Math.max(aligned, floor)
}

/**
 * Split point for the preserved tail.
 *
 * The experiment uses production's `tailStart` (the `keep.tokens` / `keep.turns` split) as the
 * boundary for every strategy, because that split is what the strategies differ about. It
 * deliberately does NOT apply `select`'s `preserveCurrentTurn` clamp
 * (`Math.min(greedy, lastUserIndex)`), which on these sessions forces the tail to start at the
 * newest user message and so preserves the entire in-flight agentic turn verbatim. That clamp
 * is measured separately and reported as its own finding: applied here it would swamp every
 * strategy's tail with the same tens of thousands of tokens and destroy the comparison.
 */
export const splitIndex = (list: readonly Item[], options: { tokens: number; turns: number }) => {
  const greedy = tailStart(list, options)
  const currentTurn = list.findLastIndex((item) => item.start)
  const clamped = currentTurn === -1 ? greedy : greedy <= 0 ? currentTurn : Math.min(greedy, currentTurn)
  // Tokens the `preserveCurrentTurn` clamp would force into the tail on top of `keep.tokens`.
  const forced = list.slice(Math.max(0, clamped), greedy).reduce((sum, item) => sum + item.tokens, 0)
  // Production's `split <= 0` branch: a tail that would swallow the whole window is
  // abandoned and everything is summarized instead.
  return { split: greedy > 0 ? greedy : list.length, degenerate: clamped <= 0, forcedByCurrentTurn: forced }
}

// -- ground truth facts --------------------------------------------------------------------

export type Facts = {
  readonly paths: ReadonlySet<string>
  readonly errors: ReadonlySet<string>
  readonly instructions: ReadonlySet<string>
  readonly identifiers: ReadonlySet<string>
}

const PATH = /(?:\/[A-Za-z0-9._-]+){2,}|(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+\.[A-Za-z]{1,6}/g
const IDENT =
  /`([^`\n]{3,80})`|\b([a-z][a-zA-Z0-9]{5,}[A-Z][a-zA-Z0-9]*)\b|\b([a-z]+_[a-z0-9_]{3,})\b|\b((?:ses|msg|prt|call|drw|wng|rom|tsk|lrn)_[A-Za-z0-9]{6,})\b/g
const ERROR_LINE =
  /^.*?\b(?:Error|error|ERROR|Exception|FAILED|failed|panic:|Traceback|TypeError|ReferenceError|assert)\b.*$/gm

const STOP = new Set(["package_json", "node_modules", "true_false", "read_only", "type_error", "to_string", "for_each"])

const norm = (value: string) => value.trim().toLowerCase()

const collect = (
  text: string,
  into: { paths: Map<string, number>; errors: Map<string, number>; identifiers: Map<string, number> },
) => {
  for (const match of text.matchAll(PATH)) {
    const value = match[0]!
    if (value.length < 8 || value.length > 160) continue
    if (/^[0-9./]+$/.test(value)) continue
    into.paths.set(value, (into.paths.get(value) ?? 0) + 1)
  }
  for (const match of text.matchAll(IDENT)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim()
    if (value.length < 6 || value.length > 80) continue
    if (STOP.has(value)) continue
    if (/^\d+$/.test(value)) continue
    into.identifiers.set(value, (into.identifiers.get(value) ?? 0) + 1)
  }
  for (const match of text.matchAll(ERROR_LINE)) {
    // A 60-char signature starting at the error keyword: stable enough to string-match, long
    // enough that a hit is not an accident.
    const line = match[0]!.trim()
    const at = line.search(
      /\b(?:Error|error|ERROR|Exception|FAILED|failed|panic:|Traceback|TypeError|ReferenceError|assert)\b/,
    )
    const signature = line.slice(Math.max(0, at), Math.max(0, at) + 60).trim()
    if (signature.length < 20) continue
    into.errors.set(signature, (into.errors.get(signature) ?? 0) + 1)
  }
}

/**
 * Salient facts in a slice of original history.
 *
 * The salience filter is what makes recall meaningful: raw extraction over a 400k-token history
 * yields tens of thousands of one-off tokens from tool output that no summary could or should
 * keep. A fact counts only when it recurs (>= `repeats`) or is stated by the user.
 */
export const extractFacts = (entries: readonly Entry[], repeats = 3): Facts => {
  const all = {
    paths: new Map<string, number>(),
    errors: new Map<string, number>(),
    identifiers: new Map<string, number>(),
  }
  const user = {
    paths: new Map<string, number>(),
    errors: new Map<string, number>(),
    identifiers: new Map<string, number>(),
  }
  const instructions = new Set<string>()
  for (const entry of entries) {
    const text = serializeMessage(entry.message)
    if (!text) continue
    collect(text, all)
    if (entry.message.type === "user") {
      collect(text, user)
      for (const match of text.matchAll(/`([^`\n]{4,60})`|"([^"\n]{4,60})"/g)) {
        const value = (match[1] ?? match[2] ?? "").trim()
        if (value.length >= 4) instructions.add(value)
      }
    }
  }
  const keep = (map: Map<string, number>, userMap: Map<string, number>) =>
    new Set([...map.entries()].filter(([key, count]) => count >= repeats || userMap.has(key)).map(([key]) => key))
  return {
    paths: keep(all.paths, user.paths),
    errors: keep(all.errors, user.errors),
    identifiers: keep(all.identifiers, user.identifiers),
    instructions,
  }
}

export const recall = (facts: Facts, context: string) => {
  const haystack = norm(context)
  const score = (set: ReadonlySet<string>) => {
    let hit = 0
    for (const fact of set) if (haystack.includes(norm(fact))) hit++
    return { hit, total: set.size }
  }
  const paths = score(facts.paths)
  const errors = score(facts.errors)
  const instructions = score(facts.instructions)
  const identifiers = score(facts.identifiers)
  const hit = paths.hit + errors.hit + instructions.hit + identifiers.hit
  const total = paths.total + errors.total + instructions.total + identifiers.total
  return { paths, errors, instructions, identifiers, hit, total, pct: total === 0 ? 1 : hit / total }
}

export const subtract = (later: Facts, earlier: Facts): Facts => ({
  paths: new Set([...later.paths].filter((value) => !earlier.paths.has(value))),
  errors: new Set([...later.errors].filter((value) => !earlier.errors.has(value))),
  instructions: new Set([...later.instructions].filter((value) => !earlier.instructions.has(value))),
  identifiers: new Set([...later.identifiers].filter((value) => !earlier.identifiers.has(value))),
})

export const factCount = (facts: Facts) =>
  facts.paths.size + facts.errors.size + facts.instructions.size + facts.identifiers.size

// -- LLM ------------------------------------------------------------------------------------

export const MODEL = "claude-haiku-4-5-20251001"
let calls = 0
let cached = 0
export const llmStats = () => ({ calls, cached })

const run = (system: string, prompt: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model",
        MODEL,
        "--system-prompt",
        system,
        "--allowedTools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ],
      // Nested Claude Code sessions inherit env that redirects the CLI at a different endpoint.
      // `provider/claude-code.ts:39-62` strips the same set for the same reason.
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !key.startsWith("ANTHROPIC_") &&
              !key.startsWith("CLAUDE_CODE_") &&
              key !== "CLAUDECODE" &&
              key !== "CLAUDE_CODE_ENTRYPOINT",
          ),
        ) as NodeJS.ProcessEnv,
      },
    )
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`claude exit ${code}: ${(err + out).slice(0, 600)}`)),
    )
    child.stdin.write(prompt)
    child.stdin.end()
  })

/** Deterministic stand-in used to validate harness mechanics without spending tokens. */
const DRY = process.env["FORGE_EXP_DRY"] === "1"

export const complete = async (system: string, prompt: string): Promise<string> => {
  if (DRY) {
    calls++
    return `## Objective\n- dry\n\n## Important Details\n- dry\n\n## Work State\n### Completed\n- dry\n\n### Active\n- dry\n\n### Blocked\n- dry\n\n## Next Move\n1. dry\n\n## Relevant Files\n- dry\n\n## Durable Memories\n- dry\n[prompt ${prompt.length} chars]`
  }
  mkdirSync(CACHE, { recursive: true })
  const key = createHash("sha256").update(`${MODEL} ${system} ${prompt}`).digest("hex")
  const file = `${CACHE}/${key}.txt`
  if (existsSync(file)) {
    cached++
    return readFileSync(file, "utf8")
  }
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value = await run(system, prompt)
      calls++
      writeFileSync(file, value)
      return value
    } catch (error) {
      last = error
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  throw last
}

export const pool = async <T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
) => {
  const results = new Array<R>(values.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= values.length) return
        results[index] = await worker(values[index]!, index)
      }
    }),
  )
  return results
}

export { buildPrompt, validSummary }
