/**
 * Shared types for the token-efficiency benchmark.
 *
 * The whole point of this file is the normalisation contract in {@link Usage}.
 * The three harnesses report token usage in *different shapes*, and comparing
 * them naively produces nonsense. See `NORMALISATION` below.
 */

/**
 * NORMALISATION CONTRACT
 * ----------------------
 * Anthropic-shaped usage (Claude Code, and TurenOS when driving the
 * `claude-code` provider) reports `input_tokens` EXCLUDING anything served
 * from or written to the prompt cache. Total context read by the model is
 * therefore `input + cache_read + cache_creation`.
 *
 * OpenAI-shaped usage (Codex) reports `input_tokens` INCLUDING the cached
 * portion, with `cached_input_tokens` being a subset of it. Total context read
 * by the model is therefore just `input_tokens`.
 *
 * To make one number comparable we always populate:
 *   inputTokens      = uncached prompt tokens
 *   cacheReadTokens  = prompt tokens served from cache
 *   cacheWriteTokens = prompt tokens written into the cache (0 where the
 *                      harness does not distinguish them)
 *   contextTokens    = inputTokens + cacheReadTokens + cacheWriteTokens
 *
 * `contextTokens` is the headline metric: "how many prompt tokens did the
 * model have to be shown to do this task". It is provider-price-agnostic and
 * is the only figure that is apples-to-apples across all three harnesses.
 */
export interface Usage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  contextTokens: number
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    contextTokens: 0,
  }
}

/**
 * Difference between two usage snapshots, for harnesses that report a running
 * total per conversation rather than per turn. Clamped at zero: a negative
 * delta would mean the harness reset its counter, and inventing a negative
 * token count is worse than reporting nothing happened.
 */
export function subtractUsage(later: Usage, earlier: Usage): Usage {
  const clamp = (value: number) => (value > 0 ? value : 0)
  return {
    inputTokens: clamp(later.inputTokens - earlier.inputTokens),
    cacheReadTokens: clamp(later.cacheReadTokens - earlier.cacheReadTokens),
    cacheWriteTokens: clamp(later.cacheWriteTokens - earlier.cacheWriteTokens),
    outputTokens: clamp(later.outputTokens - earlier.outputTokens),
    reasoningTokens: clamp(later.reasoningTokens - earlier.reasoningTokens),
    contextTokens: clamp(later.contextTokens - earlier.contextTokens),
  }
}

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    contextTokens: left.contextTokens + right.contextTokens,
  }
}

/** Build a normalised Usage from Anthropic-shaped fields. */
export function usageFromAnthropic(raw: {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens?: number
}): Usage {
  const inputTokens = raw.input_tokens ?? 0
  const cacheReadTokens = raw.cache_read_input_tokens ?? 0
  const cacheWriteTokens = raw.cache_creation_input_tokens ?? 0
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: raw.output_tokens ?? 0,
    // Anthropic folds extended-thinking tokens into output_tokens and does not
    // break them out, so we cannot report them separately.
    reasoningTokens: 0,
    contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

/** Build a normalised Usage from OpenAI/Codex-shaped fields. */
export function usageFromCodex(raw: {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}): Usage {
  const total = raw.input_tokens ?? 0
  const cacheReadTokens = raw.cached_input_tokens ?? 0
  // `input_tokens` already includes the cached portion; subtract to get the
  // uncached remainder so the shared contextTokens formula stays valid.
  const inputTokens = Math.max(0, total - cacheReadTokens)
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens: raw.output_tokens ?? 0,
    reasoningTokens: raw.reasoning_output_tokens ?? 0,
    contextTokens: inputTokens + cacheReadTokens,
  }
}

/** One provider round-trip, where the harness exposes them individually. */
export interface RequestUsage {
  index: number
  usage: Usage
}

/** The outcome of sending a single prompt to a harness. */
export interface TurnOutcome {
  ok: boolean
  /** Populated when ok === false. Never inferred or estimated. */
  error: string | null
  /** Harness-native conversation handle, used to continue the conversation. */
  sessionId: string | null
  /** Final assistant text, used by verifiers. */
  text: string
  usage: Usage
  /** Per-provider-request usage where the harness exposes it, else empty. */
  requests: RequestUsage[]
  /** Number of provider round-trips. */
  providerRequests: number
  /** False when providerRequests is a documented approximation. */
  providerRequestsExact: boolean
  toolCalls: number
  wallMs: number
  /** Cost as self-reported by the harness, or null when it reports none. */
  reportedCostUsd: number | null
  exitCode: number | null
}

export interface TurnRecord extends TurnOutcome {
  turnIndex: number
  prompt: string
  verifierPass: boolean
  verifierDetail: string
  /**
   * Usage exactly as the harness reported it. For harnesses with
   * `usageIsCumulative`, this is the running conversation total, while `usage`
   * above holds the per-turn delta. Kept so every published number can be
   * traced back to a raw reading.
   */
  rawUsage: Usage
}

export interface RunRecord {
  harness: string
  harnessLabel: string
  pairing: string
  model: string
  underlyingModel: string
  pricingKey: string | null
  task: string
  taskLabel: string
  repetition: number
  status: "ok" | "harness_error" | "verifier_failed" | "blocked"
  /** Reason for `blocked` (e.g. missing credential) or the harness error. */
  statusDetail: string | null
  workspace: string
  startedAt: string
  wallMs: number
  usage: Usage
  providerRequests: number
  providerRequestsExact: boolean
  toolCalls: number
  reportedCostUsd: number | null
  modeledCostUsd: number | null
  turns: TurnRecord[]
}

export interface VerifierContext {
  /** Final assistant text for the turn. */
  text: string
  /** Absolute path to the per-run workspace copy of the fixture. */
  workspace: string
}

export interface VerifierResult {
  pass: boolean
  detail: string
}

export type Verifier = (ctx: VerifierContext) => VerifierResult

export interface TaskTurn {
  prompt: string
  verify: Verifier
}

export interface Task {
  id: string
  label: string
  /** What this task is designed to isolate. Printed in the report. */
  measures: string
  /** True when the harness must be allowed to modify the workspace. */
  needsWrite: boolean
  turns: TaskTurn[]
}

export interface HarnessRunArgs {
  workspace: string
  prompt: string
  /** Continue an existing conversation when set. */
  sessionId: string | null
  /** True when this task has more than one turn, so session state must persist. */
  multiTurn: boolean
  allowWrite: boolean
  /** Stable per-(harness,task,repetition) key, used for scratch state. */
  runKey: string
  /** Unique id for this whole benchmark invocation. */
  runId: string
  timeoutMs: number
}

export interface Harness {
  id: string
  label: string
  /** Which comparison arm this harness belongs to. */
  pairing: string
  /** Model identifier as passed to the harness. */
  model: string
  /** Canonical underlying model, used to pair harnesses fairly. */
  underlyingModel: string
  /** Pricing key into src/pricing.ts, or null when the model is unpriced. */
  pricingKey: string | null
  /**
   * True when the harness reports a running conversation total on every turn
   * instead of that turn's own usage. Codex does this: resuming a thread and
   * sending a two-word prompt reports exactly double the previous turn's cached
   * tokens. Summing those readings would triple-count a 5-turn run, so the
   * runner differences them instead.
   */
  usageIsCumulative: boolean
  /** Cheap precheck so we never spend money on an arm that cannot run. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>
  run(args: HarnessRunArgs): Promise<TurnOutcome>
}
