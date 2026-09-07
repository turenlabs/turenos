/**
 * Provider-side prompt-cache emulation for cache benchmarking.
 *
 * Runs each captured `LLMRequest` through the REAL request path — route swap,
 * `applyCachePolicy`, and the real protocol body builder — then emulates what
 * the provider would report as usage:
 *
 * - Anthropic: explicit `cache_control` breakpoints on the wire body. The body
 *   is split into ordered segments (tools, then system, then message content
 *   blocks). Each breakpoint on a request caches the prefix through it; a
 *   later request reads the longest previously-cached span its own prefix
 *   still matches (spans under the minimum are never cached). Only the
 *   immediate predecessor's spans are consulted — enough for the extension
 *   chains the runner produces, and a slight undercount after back-to-back
 *   invalidations. Newly breakpointed content past the read counts as cache
 *   creation, the remainder as fresh input.
 * - OpenAI: implicit prefix caching. Longest common prefix (chars) with the
 *   previous wire body counts as cached tokens above a minimum length.
 *
 * What is MODELED (do not read absolute numbers as provider truth):
 * - Token counts use `Token.estimate` (bytes/4), not provider tokenizers.
 * - Anthropic minimum cacheable prefix (1024) and 5-minute rate multipliers
 *   (read 0.1x, creation 1.25x) are approximations of documented pricing.
 * - OpenAI's cached discount (0.5x) likewise; per-model variance is ignored.
 * - Cache TTL never expires in-simulation (turns are ms apart on the live
 *   clock), and per-organization cache sharding (`promptCacheKey`) is ignored.
 *
 * Variant deltas are the decision signal, same as `context-bench.test.ts`.
 * Absolute p50/p99 describe the emulated provider, not a real invoice.
 */
import { LLMRequest, Model, Usage } from "@turenlabs/llm"
import { applyCachePolicy } from "@turenlabs/llm/cache-policy"
import * as AnthropicMessages from "@turenlabs/llm/protocols/anthropic-messages"
import * as OpenAIChat from "@turenlabs/llm/protocols/openai-chat"
import { Effect } from "effect"
import { Token } from "../../src/util/token"

export type CacheProviderKind = "anthropic" | "openai"

export type BreakCause =
  | "cold"
  | "extension"
  | "prune"
  | "compaction"
  | "tools-changed"
  | "system-changed"
  | "content-changed"

export interface CacheRecord {
  readonly label: string | undefined
  readonly conversation: string
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly hitRatio: number
  /** Modeled prompt-side billed tokens in token units (rate multipliers applied, output excluded). */
  readonly billed: number
  /** Previous request was an exact prefix of this one (no invalidation). */
  readonly extension: boolean
  readonly breakCause: BreakCause
  /** Anthropic wire breakpoints declared on this request (0 for OpenAI). */
  readonly breakpoints: number
  /** Overlay messages (`metadata.forge.internalContext`) carried on this request. */
  readonly overlays: number
  /** Tool-definition tokens (always-fresh ballast under JSON-order matching). */
  readonly toolsTokens: number
}

export interface UsageEmulator {
  /**
   * Compute emulated provider usage for a finished request. Called when the
   * terminal `step-finish` event flows, with output chars observed from the
   * streamed deltas. Returns undefined when the request cannot be compiled
   * (no record is kept and no usage is attached).
   */
  readonly observe: (
    request: LLMRequest,
    label: string | undefined,
    outputChars: number,
  ) => Effect.Effect<Usage | undefined>
  readonly records: () => ReadonlyArray<CacheRecord>
}

/** Below this the emulated provider serves no cache read (Anthropic/OpenAI minimums). */
const MIN_CACHED_PREFIX_TOKENS = 1024

const estimateChars = (chars: number) => Math.max(0, Math.round(chars / 4))

export const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
}

interface Segment {
  /** Serialized block minus `cache_control` (markers declare boundaries, not identity). */
  readonly identity: string
  readonly tokens: number
  readonly breakpoint: boolean
  readonly region: "tools" | "system" | "messages"
}

interface Chain {
  segments: Segment[]
  bodyText: string
  checkpointExcerpt: string | undefined
  sentinelCount: number
  seen: boolean
}

// Literals mirror SessionCompaction sentinels and the checkpoint wrapper;
// kept literal so the emulator stays light (no src/session import graph).
const SENTINEL_MARKERS = [
  "[Old tool result content cleared]",
  "[Duplicate result cleared",
  "[Old tool input cleared]",
  "cleared:",
  "[Attached image cleared",
]
const CHECKPOINT_MARKER = "<conversation-checkpoint>"

const countOccurrences = (texts: string, marker: string) => texts.split(marker).length - 1

const scanTexts = (texts: string) => {
  const at = texts.indexOf(CHECKPOINT_MARKER)
  return {
    checkpointExcerpt: at === -1 ? undefined : texts.slice(at, at + 500),
    sentinelCount: SENTINEL_MARKERS.reduce((total, marker) => total + countOccurrences(texts, marker), 0),
  }
}

type Marks = ReturnType<typeof scanTexts>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const segmentOf = (block: unknown, region: Segment["region"]): Segment => {
  const identity = JSON.stringify(block, (key, value: unknown) => (key === "cache_control" ? undefined : value))
  return {
    identity,
    tokens: Token.estimate(identity),
    breakpoint: isRecord(block) && block.cache_control !== undefined && block.cache_control !== null,
    region,
  }
}

/**
 * Wire blocks in Anthropic cache-hierarchy order (tools, system, messages),
 * matching the breakpoint allocation order in `fromRequest`.
 */
const anthropicSegments = (body: unknown): Segment[] => {
  if (!isRecord(body)) return []
  const segments: Segment[] = []
  if (Array.isArray(body.tools)) for (const tool of body.tools) segments.push(segmentOf(tool, "tools"))
  if (Array.isArray(body.system)) for (const part of body.system) segments.push(segmentOf(part, "system"))
  if (Array.isArray(body.messages))
    for (const message of body.messages) {
      if (!isRecord(message)) continue
      const content = message.content
      if (typeof content === "string") {
        segments.push({
          identity: JSON.stringify(content),
          tokens: Token.estimate(content),
          breakpoint: false,
          region: "messages",
        })
        continue
      }
      if (Array.isArray(content)) for (const block of content) segments.push(segmentOf(block, "messages"))
    }
  return segments
}

const lcp = (a: string, b: string) => {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

/**
 * OpenAI bodies are JSON objects, so "previous text is a string prefix" can
 * never hold once messages grow (new content lands mid-object). Segments in
 * stable hierarchy order exist only for extension/cause detection: tools sit
 * before messages so appended messages read as growth, not divergence. Token
 * math stays on wire-text LCP, which follows the body's own key order.
 */
const openaiSegments = (body: unknown): Segment[] => {
  if (!isRecord(body)) return []
  const segments: Segment[] = []
  if (body.system !== undefined)
    segments.push({
      identity: JSON.stringify(body.system),
      tokens: 0,
      breakpoint: false,
      region: "system",
    })
  if (body.tools !== undefined)
    segments.push({
      identity: JSON.stringify(body.tools),
      tokens: Token.estimate(JSON.stringify(body.tools)),
      breakpoint: false,
      region: "tools",
    })
  const messages = body.messages
  if (Array.isArray(messages))
    for (const message of messages)
      segments.push({ identity: JSON.stringify(message), tokens: 0, breakpoint: false, region: "messages" })
  return segments
}

export const makeCacheEmulator = (provider: CacheProviderKind): UsageEmulator => {
  const chains = new Map<string, Chain>()
  const records: CacheRecord[] = []

  const chainFor = (conversation: string): Chain => {
    const chain = chains.get(conversation)
    if (chain) return chain
    const fresh: Chain = { segments: [], bodyText: "", checkpointExcerpt: undefined, sentinelCount: 0, seen: false }
    chains.set(conversation, fresh)
    return fresh
  }

  const observe = (
    request: LLMRequest,
    label: string | undefined,
    outputChars: number,
  ): Effect.Effect<Usage | undefined> =>
    Effect.gen(function* () {
      // Summarizer and ledger requests are separate cache conversations:
      // chaining them with turn requests would nuke the turn prefix.
      const conversation = label === "summarizer" ? "summary" : label === "ledger" ? "ledger" : "turn"
      const route = provider === "anthropic" ? AnthropicMessages.route : OpenAIChat.route
      const rerouted = LLMRequest.update(request, { model: Model.update(request.model, { route }) })
      const resolved = applyCachePolicy(rerouted)
      // Branched (not a protocol union): each `from` keeps its own body type.
      const compiled =
        provider === "anthropic"
          ? yield* AnthropicMessages.protocol.body.from(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))
          : yield* OpenAIChat.protocol.body.from(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (compiled === undefined) return undefined
      const body: unknown = compiled

      const chain = chainFor(conversation)
      const output = estimateChars(outputChars)
      const requestText = JSON.stringify({ system: resolved.system, messages: resolved.messages })
      const marks = scanTexts(requestText)
      const overlays = resolved.messages.filter((message) => {
        const forge = message.metadata?.["forge"]
        return isRecord(forge) && "internalContext" in forge
      }).length
      const usage =
        provider === "anthropic"
          ? anthropicUsage(chain, body, output, marks, overlays, label)
          : openaiUsage(chain, body, output, marks, overlays)
      chains.set(conversation, usage.chain)
      records.push({ label, conversation, ...usage.record })
      const r = usage.record
      const input = r.input
      return new Usage({
        inputTokens: input,
        outputTokens: output,
        nonCachedInputTokens: Math.max(0, input - r.cacheRead - r.cacheWrite),
        cacheReadInputTokens: r.cacheRead,
        cacheWriteInputTokens: r.cacheWrite,
        totalTokens: input + output,
        providerMetadata: { emulated: { provider, conversation } },
      })
    })

  return {
    observe,
    records: () => [...records],
  }
}

const anthropicUsage = (
  chain: Chain,
  body: unknown,
  output: number,
  marks: Marks,
  overlays: number,
  label: string | undefined,
) => {
  const segments = anthropicSegments(body)
  const total = segments.reduce((sum, segment) => sum + segment.tokens, 0)
  let matched = 0
  while (
    matched < segments.length &&
    matched < chain.segments.length &&
    segments[matched]!.identity === chain.segments[matched]!.identity
  )
    matched++
  const extension = chain.seen && matched === chain.segments.length
  // Reads match spans the PREVIOUS request cached (breakpoints it declared),
  // not spans the current request declares: the rolling tail breakpoint only
  // makes sense because older spans keep hitting after it advances.
  let readEnd = -1
  let cacheRead = 0
  {
    // Matched segments are identical, so offsets accumulate on either side.
    let offset = 0
    for (let i = 0; i < matched; i++) {
      offset += segments[i]!.tokens
      if (chain.segments[i]!.breakpoint && offset >= MIN_CACHED_PREFIX_TOKENS && offset > cacheRead) {
        cacheRead = offset
        readEnd = i
      }
    }
  }
  let lastBreakpoint = -1
  for (let i = 0; i < segments.length; i++) if (segments[i]!.breakpoint) lastBreakpoint = i
  const lastBreakpointOffset =
    lastBreakpoint < 0 ? 0 : segments.slice(0, lastBreakpoint + 1).reduce((sum, segment) => sum + segment.tokens, 0)
  const cacheWrite = Math.max(0, lastBreakpointOffset - cacheRead)
  const breakpoints = segments.filter((segment) => segment.breakpoint).length
  if (process.env.BENCH_TRACE)
    console.log(
      `[trace] anthropic req: input=${total} read=${cacheRead} write=${cacheWrite} segs=${segments.length} matched=${matched} readEnd=${readEnd} lastBp=${lastBreakpoint} bps=${breakpoints} ext=${chain.seen && matched === chain.segments.length} bpAt=${segments
        .map((segment, i) => (segment.breakpoint ? `${i}:${segment.region}:${segment.identity.slice(0, 72)}` : ""))
        .filter(Boolean)
        .join(" | ")}`,
    )
  const trace = process.env.BENCH_TRACE ? label : undefined
  if (trace !== undefined && chain.seen && !extension)
    console.log(
      `[trace] ${trace}: anthropic break matched=${matched}/${chain.segments.length} region=${matched < segments.length ? segments[matched]!.region : "shorter"} prev=${JSON.stringify(chain.segments[matched]?.identity.slice(0, 200))} cur=${JSON.stringify(segments[matched]?.identity.slice(0, 200))}`,
    )
  const breakCause = classifyBreak({
    seen: chain.seen,
    extension,
    divergeRegion: matched < segments.length ? segments[matched]!.region : undefined,
    checkpoint: marks.checkpointExcerpt !== undefined && marks.checkpointExcerpt !== chain.checkpointExcerpt,
    sentinel: marks.sentinelCount > chain.sentinelCount,
  })
  const record = {
    input: total,
    cacheRead,
    cacheWrite,
    output,
    hitRatio: total > 0 ? cacheRead / total : 0,
    billed: cacheRead * 0.1 + cacheWrite * 1.25 + Math.max(0, total - cacheRead - cacheWrite),
    extension,
    breakCause,
    breakpoints,
    overlays,
    toolsTokens: segments
      .filter((segment) => segment.region === "tools")
      .reduce((sum, segment) => sum + segment.tokens, 0),
  }
  return {
    chain: {
      segments,
      bodyText: "",
      checkpointExcerpt: marks.checkpointExcerpt,
      sentinelCount: marks.sentinelCount,
      seen: true,
    },
    record,
  }
}

const openaiUsage = (chain: Chain, body: unknown, output: number, marks: Marks, overlays: number) => {
  const text = JSON.stringify(body)
  const total = Token.estimate(text)
  const prefix = !chain.seen ? 0 : lcp(text, chain.bodyText)
  const segments = openaiSegments(body)
  let matched = 0
  while (
    matched < segments.length &&
    matched < chain.segments.length &&
    segments[matched]!.identity === chain.segments[matched]!.identity
  )
    matched++
  const extension = chain.seen && matched === chain.segments.length
  const cached = prefix >= MIN_CACHED_PREFIX_TOKENS * 4 ? Token.estimate(text.slice(0, prefix)) : 0
  if (process.env.BENCH_TRACE && chain.seen && !extension)
    console.log(
      `[trace] openai break matched=${matched}/${chain.segments.length} region=${matched < segments.length ? segments[matched]!.region : "shorter"} prevlen=${chain.bodyText.length} curlen=${text.length} lcp=${prefix} prev=${JSON.stringify(chain.segments[matched]?.identity.slice(0, 160))} cur=${JSON.stringify(segments[matched]?.identity.slice(0, 160))}`,
    )
  const breakCause = classifyBreak({
    seen: chain.seen,
    extension,
    divergeRegion: matched < segments.length ? segments[matched]!.region : undefined,
    checkpoint: marks.checkpointExcerpt !== undefined && marks.checkpointExcerpt !== chain.checkpointExcerpt,
    sentinel: marks.sentinelCount > chain.sentinelCount,
  })
  const record = {
    input: total,
    cacheRead: cached,
    cacheWrite: 0,
    output,
    hitRatio: total > 0 ? cached / total : 0,
    billed: cached * 0.5 + Math.max(0, total - cached),
    extension,
    breakCause,
    breakpoints: 0,
    overlays,
    toolsTokens: segments
      .filter((segment) => segment.region === "tools")
      .reduce((sum, segment) => sum + segment.tokens, 0),
  }
  return {
    chain: {
      segments,
      bodyText: text,
      checkpointExcerpt: marks.checkpointExcerpt,
      sentinelCount: marks.sentinelCount,
      seen: true,
    },
    record,
  }
}

const classifyBreak = (input: {
  seen: boolean
  extension: boolean
  divergeRegion: Segment["region"] | undefined
  checkpoint: boolean
  sentinel: boolean
}): BreakCause => {
  if (!input.seen) return "cold"
  if (input.extension) return "extension"
  if (input.checkpoint) return "compaction"
  if (input.sentinel) return "prune"
  if (input.divergeRegion === "tools") return "tools-changed"
  if (input.divergeRegion === "system") return "system-changed"
  return "content-changed"
}
