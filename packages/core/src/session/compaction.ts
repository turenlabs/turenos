export * as SessionCompaction from "./compaction"

import {
  GenerationOptions,
  LLM,
  LLMError,
  LLMEvent,
  LLMRequest,
  Message,
  isContextOverflowFailure,
  type Model,
} from "@turenlabs/llm"
import { DateTime, Deferred, Effect, Fiber, Schema, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"
import { toLLMMessages } from "./runner/to-llm-message"

const DEFAULT_BUFFER = 20_000
export const CONTEXT_TARGET = 0.75
// Measured against a real 24/7 corpus (533 sessions, 5.6 days): at 8k the median
// preserved tail was a single message — mean message is ~1.8k wire tokens — and
// tail-only fact recall was 5.9%. 16k keeps ~4 messages for 18.7% recall, the best
// recall-per-token of every budget swept (2k/4k/8k/16k/32k/64k).
const DEFAULT_KEEP_TOKENS = 16_000
/** How many keep-budgets an in-flight turn may occupy and still be preserved verbatim. */
const PRESERVE_CURRENT_TURN_BUDGET_MULTIPLE = 2
const DEFAULT_KEEP_TURNS = 2
const MAX_KEEP_TURNS = 50
const MAX_KEEP_TOKENS = 200_000
const MAX_BUFFER = 500_000
const SUMMARY_OUTPUT_TOKENS = 4_096
/**
 * Additional summary attempts after a provider failure that produced no summary.
 *
 * Manual compaction gets more of them on purpose. A user typing `/compact` on a session that can
 * no longer take a turn is explicitly trading fidelity for a working session, so it keeps halving
 * long after the automatic path has given up and fallen back.
 */
const SUMMARY_RETRIES = { auto: 2, manual: 4 } as const
/**
 * Hard character ceiling on a summarization prompt, independent of the token budget.
 *
 * `Token.estimate` counts four characters per token, which under-counts dense JSON and code, so a
 * "fitted" prompt is not a fitted prompt -- and on a million-token model the fitted size runs past
 * limits that are counted in characters rather than tokens. OpenAI's Responses API caps a single
 * input string at 1 048 576 characters and rejects anything longer as `string_above_max_length`
 * before it ever counts tokens; a real 1.05M-window session produced a 1 891 965-character prompt
 * and was permanently uncompactable. Staying under the smallest such cap costs nothing on models
 * whose token budget binds first, because the budget is the smaller of the two everywhere below
 * ~250k tokens of context.
 */
const SUMMARY_PROMPT_MAX_CHARS = 1_000_000
/**
 * Prompt size for the final retry, whatever the halving schedule would have produced.
 *
 * The point of the last attempt is that it fits *something*, so it stops following the geometry
 * and jumps straight to a size no frontier model can reject: ~6k tokens of elided head.
 */
const SUMMARY_FLOOR_CHARS = 24_000
/** Head excerpt preserved by a fallback checkpoint. Replayed every turn, so deliberately small. */
const FALLBACK_EXCERPT_CHARS = 12_000
/** Bound on the model's own partial output carried into a fallback checkpoint. */
const FALLBACK_PARTIAL_CHARS = 4_000
/**
 * Output allowance for one ledger extraction.
 *
 * The extractor is capped at `LEDGER_MAX_SEGMENT_LINES` one-line facts, so it needs a fraction of
 * the summary's budget. Keeping it small also keeps the added latency of the second call well
 * under the summary call it follows.
 */
const LEDGER_OUTPUT_TOKENS = 2_048
const CHARS_PER_TOKEN = 4
const REQUEST_MARGIN_TOKENS = 256
/** Summary budget when an overflowing model declares no window. See `run`. */
const FALLBACK_OVERFLOW_CONTEXT = 128_000
/**
 * Flat allowance for one media attachment in a request estimate.
 *
 * A provider prices an image by its dimensions, not its encoding, but a base64 `data:` URI
 * costs ~4x its raw bytes in characters: a resized 100KB image is ~135k base64 chars, which
 * char-based estimation reads as ~34k tokens against a real cost on the order of 1.5k. One
 * attached screenshot was enough to push every estimate over budget and compact the session
 * on each turn. 1,600 tokens is the ceiling most providers charge for a full-size image, so
 * this over-reserves slightly instead of overflowing.
 */
const MEDIA_TOKENS = 1_600
const MEDIA_URI_MIN_CHARS = MEDIA_TOKENS * CHARS_PER_TOKEN
/**
 * Cap on the output allowance the pre-flight gate reserves.
 *
 * Reserving the model's full theoretical output limit compacted a 200k/64k model at 68%
 * occupancy for turns that emit a few thousand tokens. The cap is safe only because
 * `clampOutput` pairs with it: providers that validate `prompt + max_tokens <= context`
 * would otherwise reject every request inside the un-reserved band.
 */
const OUTPUT_RESERVE_CAP = 32_000

/**
 * Tokens the prompt may occupy once `reserved` is set aside for the reply.
 *
 * `context` is the whole window, but some models additionally cap the prompt
 * itself below `context - output` and publish that as `limit.input`; where it
 * exists it is the binding constraint, so the smaller of the two wins. V1 has
 * always budgeted this way (`packages/forge/src/session/overflow.ts`), while V2
 * read only `context` and so let the prompt run past the real cap on every
 * model that publishes a distinct one.
 */
const usableBudget = (limits: { readonly context: number; readonly input?: number }, reserved: number) =>
  Math.min(limits.input ?? Number.POSITIVE_INFINITY, limits.context - reserved)
/**
 * Default per-tool budget for the summarization view of a tool result.
 *
 * A flat cap is wrong at both ends: a one-line `ls` never reaches it, while a subagent's whole
 * report -- the one artifact `wait_agents` deliberately hands over intact, having been bounded
 * once already by the durable layer (`tool/subagent.ts:36-42`) -- was guillotined at the same
 * 2k. Tools whose entire purpose is delivering a large, already-bounded payload get their own
 * budget; everything else keeps V1's cap.
 *
 * The numbers are set against what each tool actually writes, not against what it could
 * theoretically write. `wait_agents` is the only one whose observed payloads exceed its old
 * budget: the largest completed `wait_agents` state in the owner's dev database is 43 161 bytes
 * of structured JSON, because one call waits on up to 32 children and hands over each one's whole
 * durable result (100 000 chars apiece, `schema/session-task.ts:22`).
 */
const TOOL_OUTPUT_MAX_CHARS = 2_000
const TOOL_OUTPUT_BUDGETS: Readonly<Record<string, number>> = {
  wait_agents: 64_000,
  // V1 transcripts adopted into V2 carry the old single-shot subagent tool under this name.
  task: 64_000,
  // Acknowledgements, not reports: both carry a task view whose `result` is usually absent and
  // whose observed size is a couple of hundred bytes. `list_agents` previews at 4 096 chars per
  // task by design (`tool/subagent.ts:41`) and is re-callable, so it is deliberately cheap here.
  send_agent: 8_000,
  list_agents: 4_000,
  // Skill output is behavioural instruction, not data: losing its tail changes how the agent
  // works rather than what it knows.
  skill: 16_000,
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
/**
 * Tools whose output must survive verbatim. Never pruned, never charged to the protect budget.
 *
 * Two distinct reasons, both stronger than "this output is large":
 *
 * - `skill`: behavioural instruction rather than data. Clearing it changes how the agent works.
 * - `wait_agents` / `task`: a child's one and only report. Every other tool result is cheaply
 *   reproducible -- re-read the file, re-run the command -- and is at least partly reflected in
 *   the assistant text that followed it. A subagent report is neither: reproducing it means
 *   re-running an entire child session, and it is already a compression of that session's work,
 *   so it carries more knowledge per token than anything else in the transcript. Pruning it frees
 *   the fewest tokens per unit of knowledge destroyed, which is exactly backwards.
 *
 * Protection is bounded rather than permanent: `pruneEntries` stops at the newest compaction, so a
 * report stays protected only until it has been summarised, after which it sits behind the summary
 * and is never reconsidered. A session that accumulates more reports than the context can hold
 * therefore escalates to full compaction instead of silently shedding them -- the correct order.
 */
const PRUNE_PROTECTED_TOOLS: ReadonlySet<string> = new Set(["skill", "wait_agents", "task"])
/** Sentinel substituted for a pruned tool result. Matches V1's `message-v2.ts:316-319` wording exactly. */
export const PRUNED_TEXT = "[Old tool result content cleared]"
/** Replaces an older duplicate result. The identical bytes survive verbatim in a newer call. */
export const PRUNED_DUPLICATE_TEXT = "[Duplicate result cleared — identical content appears in a later call]"
/** Outputs below this serialized size are never worth a dedup cache break. */
const DEDUP_MIN_CHARS = 1_000
/** Sentinel substituted for a pruned tool-call input field. */
export const PRUNED_INPUT_TEXT = "[Old tool input cleared]"
/** Replaces a cleared media attachment. Names the file so the model can ask for it again. */
export const PRUNED_MEDIA_TEXT = (name: string | undefined) =>
  `[Attached image cleared${name ? `: ${name}` : ""} — ask the user to re-attach if needed]`
/**
 * Tools whose call inputs may be cleared once stale: the body a `write` carried is on disk,
 * an applied patch survives in the edit's structured diff. Nothing else ships inputs large
 * enough to matter, and un-listed tools must never lose input the model might re-reference.
 * `sim_huge` is the simulator's stand-in so the context bench can exercise this path.
 */
const INPUT_PRUNABLE_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "apply_patch", "sim_huge"])
/** Only string fields past this size are cleared; paths and flags always survive. */
const INPUT_PRUNE_FIELD_MIN_CHARS = 2_000
const ELISION = "\n[... omitted to fit the summarization budget ...]\n"
/**
 * Marker for a tool result that exceeded its budget.
 *
 * Tool output is dropped from the middle rather than the tail. A result's opening says what was
 * produced and its ending says how it finished -- the conclusion of a report, the last lines of a
 * build log, the error a long command died on. Head-only truncation reliably keeps the least
 * decision-relevant half: a 100 000-char subagent report at any budget below its own length lost
 * its findings and kept its preamble.
 */
const TOOL_ELISION = "\n[... tool output omitted from the middle ...]\n"

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]

## Durable Memories
- [up to five facts worth persisting beyond this session — stable decisions and their reasons, discovered constraints, diagnosed failure causes, user preferences; otherwise "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

//
// -- Anchored fact ledger ------------------------------------------------------------------
//
// The summary is a fixed-size container. Replayed over the owner's production corpus it stayed
// flat at ~4.5-5.5KB across nine compaction generations of a marathon session while the fact set
// it was compressing grew from 110 to 897 facts, so recall decayed generation over generation --
// the summary re-summarizes its own output, and every pass is lossy.
//
// The ledger is the growing half of the checkpoint. Each compaction extracts durable facts from
// the newly summarized segment ONLY and appends them verbatim; existing lines are never rewritten,
// re-summarized, or re-ranked. That is the whole mechanism: a line that entered the ledger at
// generation one is byte-identical at generation nine, so there is no compounding loss to decay.
// Growth is bounded by evicting the oldest lines (FIFO), which is a decision about which facts to
// keep rather than a lossy rewrite of the ones kept.
//
// Measured against four alternatives on the same corpus (the A/B harness lives in
// test/simulator/experiments/compaction-ab): 44.2% fact recall against 20.0% for the summary alone
// (+121%) for +44% context tokens -- the best recall-per-token of the five (0.045 vs 0.029), ahead
// on 49 of 55 paired checkpoints, and the only strategy whose recall curve stays flat-to-rising
// across nine generations (53.4% -> 59.3%) instead of decaying. Compounding (`previousSummary`
// feedback) was tested separately as the suspected root cause and REFUTED -- worth ~1pp -- so it
// stays exactly as it was.
//

/**
 * Ledger bound, in characters, measured as the joined ledger text.
 *
 * The value the experiment swept and adopted. It is the whole cost of the strategy: ~6k tokens of
 * checkpoint at steady state, which is what buys the +121% recall.
 */
export const LEDGER_MAX_CHARS = 24_000
/** Facts accepted from one extraction. Matches the instruction the extractor is given. */
const LEDGER_MAX_SEGMENT_LINES = 60
/**
 * Longest single ledger line kept.
 *
 * The extractor is told one fact per line; anything past this is prose it was not asked for, and
 * admitting it would let one line consume a meaningful share of the bound. Dropped rather than
 * truncated -- half of an error string or a path is a fact that is no longer true.
 */
const LEDGER_MAX_LINE_CHARS = 1_000

const LEDGER_SYSTEM =
  "You are a fact extractor, not an assistant. You never converse, never use tools, never comment. Your entire output is a flat bullet list, one fact per line starting with '- '. The first character of your output MUST be '-'. No headings, no preamble, no prose."

const LEDGER_PROMPT = `Extract every durable, checkable fact from the transcript below. Include, verbatim and exactly as written:
- absolute and relative file paths that were read, written, or discussed
- exact error strings and failing commands
- explicit user instructions, decisions, constraints and preferences
- decisions taken and the reason they were taken
- identifiers: function names, symbol names, session/task/message ids, config keys

One fact per line, prefixed with "- ". Preserve exact spelling of paths, symbols and identifiers. At most ${LEDGER_MAX_SEGMENT_LINES} lines. No duplicates. No prose.

<transcript>
`

const LEDGER_PROMPT_SUFFIX = "\n</transcript>"

/** Joined length of a ledger, as `toLLMMessage` renders it and as the bound is measured. */
const ledgerLength = (lines: readonly string[]) => lines.join("\n").length

/**
 * Ledger lines in one extraction response.
 *
 * Deliberately forgiving about everything except the shape: the extractor is a small model on a
 * best-effort path, so a response that leads with a stray sentence still yields its bullets rather
 * than costing the whole segment's facts.
 */
export const parseLedgerLines = (text: string): readonly string[] => {
  const lines: string[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    // `- ` plus at least four characters: shorter is a formatting artefact, not a fact.
    if (!line.startsWith("- ") || line.length <= 6 || line.length > LEDGER_MAX_LINE_CHARS) continue
    lines.push(line)
    if (lines.length >= LEDGER_MAX_SEGMENT_LINES) break
  }
  return lines
}

/**
 * Append one segment's facts to the carried ledger.
 *
 * Append-only by construction: `previous` is copied, never edited, so no existing line can be
 * reworded, merged, or re-ordered. Identical lines are dropped on append -- a path or an
 * instruction restated in a later segment is the same fact, and re-appending it would spend the
 * bound on duplicates and evict genuinely older facts to make room for them.
 *
 * Eviction is FIFO. The oldest lines are the ones the surviving summary and tail are least likely
 * to still mention, and dropping a whole line keeps every retained line exact -- the alternative,
 * compressing the ledger to fit, reintroduces the lossy rewrite the ledger exists to avoid.
 */
export const appendLedger = (
  previous: readonly string[],
  added: readonly string[],
  maxChars = LEDGER_MAX_CHARS,
): readonly string[] => {
  const result = [...previous]
  const seen = new Set(previous)
  for (const line of added) {
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
  }
  let length = ledgerLength(result)
  let dropped = 0
  for (const line of result) {
    if (!(length > maxChars)) break
    length -= line.length + (dropped < result.length - 1 ? 1 : 0)
    dropped++
  }
  return dropped === 0 ? result : result.slice(dropped)
}

// The aggregate sequence becomes the durable cutoff of a completed automatic checkpoint.
type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly prune: boolean
  readonly pruneInputs: boolean
  readonly pruneMedia: boolean
  readonly dedupOutputs: boolean
  readonly ledger: boolean
  readonly buffer: number
  readonly tokens: number
  readonly turns: number
}

/** Why a compaction was attempted. Manual compaction bypasses `auto` and the budget check. */
export type Reason = "auto" | "manual"

/**
 * Every way compaction can decline to produce a summary. The automatic paths collapse this to a
 * boolean, but a user-initiated compaction has to be able to say which one happened -- a manual
 * action that silently no-ops is indistinguishable from a broken one.
 */
export const FailureReason = Schema.Literals([
  "sessionBusy",
  "disabled",
  "notNeeded",
  "unknownContextWindow",
  "emptyConversation",
  "contextTooLarge",
  "providerFailed",
  "emptySummary",
  "invalidSummary",
])
export type FailureReason = typeof FailureReason.Type

const FAILURE_MESSAGE: Record<FailureReason, string> = {
  sessionBusy: "Session is busy. Interrupt the current turn before compacting.",
  disabled: "Automatic compaction is disabled by configuration",
  notNeeded: "Conversation is still within the model context budget",
  unknownContextWindow: "Model does not declare a context window, so there is no budget to compact against",
  emptyConversation: "There is nothing to compact yet",
  contextTooLarge: "Session is too large to compact - the history exceeds the model context limit even when summarised",
  providerFailed: "The model failed while writing the summary",
  emptySummary: "The model returned an empty summary",
  invalidSummary: "The model returned an incomplete or malformed summary",
}

export class FailedError extends Schema.TaggedErrorClass<FailedError>()("SessionCompaction.FailedError", {
  sessionID: SessionSchema.ID,
  reason: FailureReason,
}) {
  override get message() {
    return FAILURE_MESSAGE[this.reason]
  }
}

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: FailureReason }

const COMPACTED: Outcome = { ok: true }

/**
 * Resolution of the hidden `compaction` agent: its PROMPT_COMPACTION system prompt and its
 * `agents.compaction.model` override. Supplied by the runner, which owns the agent registry and
 * the model catalog. Both existed in the V2 registry (`plugin/agent.ts:284-289`) and nothing
 * ever selected them, so `agents.compaction.model` silently did nothing. Returning an empty
 * record degrades to the session's own model with no system prompt -- the previous behaviour.
 */
export type Summarizer = {
  readonly model?: Model
  readonly system?: string
}

type Dependencies = {
  readonly events: Pick<EventV2.Interface, "publish">
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  /**
   * Read per call, not captured at construction: the runner builds this service once per
   * Location layer, and a captured array froze compaction settings until restart — a user
   * editing `compaction` in forge.jsonc mid-session saw no effect, and the simulator's
   * per-scenario config overrides silently benchmarked the previous scenario's settings.
   */
  readonly config: Effect.Effect<readonly Config.Entry[]>
  /** Never fails: an unavailable override degrades to the session model rather than raising. */
  readonly summarizer?: (sessionID: SessionSchema.ID) => Effect.Effect<Summarizer>
}

/** One summarization attempt: what came back, and enough about the failure to act on it. */
type SummaryAttempt = {
  readonly completed: boolean
  readonly providerFailed: boolean
  readonly contextOverflow: boolean
  readonly failure: string | undefined
  readonly finishReason: string | undefined
  readonly summary: string
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  /** Omitted by the manual path, which compacts on demand rather than against a request budget. */
  readonly request?: LLMRequest
}

type BudgetInput = Input & {
  readonly request: LLMRequest
  /**
   * The pruned view the wire request was actually built from. `entries` stays unpruned because
   * summarization must never be built from sentinels, but occupancy is a question about the
   * request — measuring the unpruned history would re-count every byte prune just freed and
   * trigger compaction the request no longer needs.
   */
  readonly measured?: readonly Entry[]
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(value)))

export const toolOutputBudget = (tool: string) => TOOL_OUTPUT_BUDGETS[tool] ?? TOOL_OUTPUT_MAX_CHARS

/** Drop the middle, not the tail: the oldest context states the objective, the newest states where the work is. */
const elide = (value: string, maxChars: number, marker = ELISION) => {
  if (value.length <= maxChars) return value
  if (maxChars <= marker.length) return marker.trim()
  const keep = maxChars - marker.length
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`
}

const isEmptyRecord = (value: Record<string, unknown> | undefined) =>
  value === undefined || Object.keys(value).length === 0

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

/**
 * The tool output the provider actually received.
 *
 * `ToolOutput.toResultValue` (`llm/src/schema/messages.ts:104-108`) sends `content` when it is
 * non-empty and falls back to `structured` otherwise, and `Tool.settle` (`tool/tool.ts:113-126`)
 * only fills `content` for a tool that declares `toModelOutput` or returns a bare string. Reading
 * `content` alone is therefore blind to every structured-only tool -- which is not an exotic
 * minority: in the owner's dev database every one of 186 `read` results, all 11 `wait_agents`
 * results, and every `spawn_agent` / `send_agent` result has `content: []` with the entire payload
 * in `structured`. Serializing only `content` emitted a bare `[Tool result]: ` for all of them, so
 * the summarizer never saw a single file the agent read or a single report its children returned,
 * and every per-tool budget keyed on such a tool was a silent no-op.
 */
export const serializeToolOutput = (state: SessionMessage.ToolStateCompleted) =>
  state.content.length > 0
    ? serializeToolContent(state.content)
    : isEmptyRecord(state.structured)
      ? ""
      : JSON.stringify(state.structured)

export const serializeMessage = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    const agents = message.agents?.map((agent) => `[Agent: ${agent.name}]`) ?? []
    const text =
      message.parts === undefined
        ? message.text
        : message.parts
            .filter((part) => !part.ignored)
            .map((part) => part.text)
            .filter(Boolean)
            .join("\n")
    return [...(text ? [`[User]: ${text}`] : []), ...files, ...agents].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed") {
          const output =
            part.provider?.executed === true && part.state.result !== undefined
              ? JSON.stringify(part.state.result)
              : serializeToolOutput(part.state)
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${elide(output, toolOutputBudget(part.name), TOOL_ELISION)}`,
          ]
        }
        if (part.state.status === "error") {
          const evidence =
            part.provider?.executed === true && part.state.result !== undefined
              ? JSON.stringify(part.state.result)
              : part.state.content.length > 0
                ? serializeToolContent(part.state.content)
                : isEmptyRecord(part.state.structured)
                  ? ""
                  : JSON.stringify(part.state.structured)
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool error]: ${part.state.error.message}${evidence ? `\n${elide(evidence, toolOutputBudget(part.name), TOOL_ELISION)}` : ""}`,
          ]
        }
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell")
    return `[Shell]: ${message.command}\n[Status]: ${message.status ?? "unknown"}${message.exitCode === undefined ? "" : ` (exit ${message.exitCode})`}${message.error ? `\n[Error]: ${message.error}` : ""}\n${elide(message.output, TOOL_OUTPUT_MAX_CHARS, TOOL_ELISION)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  const folded = configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      prune: current.prune ?? result.prune,
      pruneInputs: current.pruneInputs ?? result.pruneInputs,
      pruneMedia: current.pruneMedia ?? result.pruneMedia,
      dedupOutputs: current.dedupOutputs ?? result.dedupOutputs,
      ledger: current.ledger ?? result.ledger,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      turns: current.keep?.turns ?? result.turns,
    }),
    // Prune defaults on. With protected tools, provider-executed exemptions, and durable marks
    // all in place, leaving it off meant a default install replayed every stale tool result and
    // shell dump on every turn until a full LLM compaction — the expensive path prune exists to
    // make rare.
    // dedupOutputs adopted by the context-bench A/B: −53% wire, −23% billed, −33% peak request
    // on re-read-heavy sessions; exactly neutral where no byte-identical results exist. Safe by
    // construction — the cleared bytes survive verbatim in the newer copy.
    // pruneInputs (−64% wire, −72% peak on edit-heavy, exemption-only) and pruneMedia (−64%
    // wire, −73% peak on screenshot-heavy, wire-priced protect budget) were adopted by the
    // context-bench A/B; see the verdict history in test/simulator/context-bench.test.ts.
    {
      auto: true,
      prune: true,
      pruneInputs: true,
      pruneMedia: true,
      dedupOutputs: true,
      // Adopted by the compaction A/B: +121% fact recall for +44% context tokens, the best
      // recall-per-token of five strategies, and the only one that does not decay across
      // generations. See the ledger section above.
      ledger: true,
      buffer: DEFAULT_BUFFER,
      tokens: DEFAULT_KEEP_TOKENS,
      turns: DEFAULT_KEEP_TURNS,
    },
  )
  // Clamp here, never in the schema. `Config.loadFile` drops any document it cannot decode, so a
  // bounded `Schema` range on a user-facing value silently deletes the rest of their config.
  return {
    ...folded,
    buffer: clamp(folded.buffer, 0, MAX_BUFFER),
    tokens: clamp(folded.tokens, 0, MAX_KEEP_TOKENS),
    turns: clamp(folded.turns, 0, MAX_KEEP_TURNS),
  } satisfies Settings
}

//
// -- Tool-output pruning -------------------------------------------------------------------
//
// V1 pruned by writing `state.time.compacted` onto the stored part and substituting a sentinel at
// read time (`forge/session/message-v2.ts:316-319`); the raw output stayed in the database
// forever. V2's messages are a projection of an append-only event log, so there is nothing to
// mutate in place -- the equivalent durable mark is `SessionEvent.Compaction.Pruned`, published by
// `prune` below and projected onto `time.pruned` by `message-updater.ts`.
//
// `pruneEntries` itself is the read-time half, applied to the entries the runner is about to lower
// into a provider request. That keeps V1's single most important property -- prune destroys
// nothing -- and strengthens it: the desktop transcript still renders every byte, because the
// desktop reads its own projection and never sees this view. The durable mark is exactly that, a
// mark: it labels the divergence for the reader and never clears the stored content.
//
// It also honours an existing `time.pruned` mark unconditionally. That mark is written today only
// by V1 transcript adoption (`transcript-adoption.ts:672-673`) and nothing on the V2 model path
// reads it, so an adopted session the user pruned in V1 currently re-sends its full tool output
// to the provider. Honouring the mark here fixes that regardless of whether prune is enabled.
//

/**
 * Tokens a completed tool state actually contributes to a provider request.
 *
 * Shares `serializeToolOutput` with the summarization view on purpose. The two used to disagree --
 * the pruner measured structured payloads while the summarizer could not see them -- and a
 * divergence in that direction is invisible: pruning still looks correct while the summary quietly
 * loses whatever the pruner was measuring.
 */
const completedOutputTokens = (state: SessionMessage.ToolStateCompleted) => Token.estimate(serializeToolOutput(state))

const prunedState = (
  state: SessionMessage.ToolStateCompleted,
  sentinel: string = PRUNED_TEXT,
): SessionMessage.ToolStateCompleted => ({
  status: "completed",
  input: state.input,
  // `content` must stay non-empty: an empty one makes `toResultValue` fall back to `structured`
  // and ship the entire payload that was just cleared.
  content: [{ type: "text", text: sentinel }],
  structured: {},
  // `attachments` and `result` are the other two carriers of the same bytes and are dropped with
  // it; `outputPaths` are paths, not content, and other readers still resolve them.
  ...(state.outputPaths === undefined ? {} : { outputPaths: state.outputPaths }),
})

/** Oversized string fields become the sentinel; paths, flags, and small values survive. */
const prunedInput = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input).map(([field, value]) => [
      field,
      typeof value === "string" && value.length > INPUT_PRUNE_FIELD_MIN_CHARS ? PRUNED_INPUT_TEXT : value,
    ]),
  )

/**
 * Whether a completed tool call may be pruned.
 *
 * Provider-executed results are echoed back to the provider verbatim and are usually shape-checked
 * there, so substituting a sentinel risks a provider-side rejection for a comparatively small
 * saving. They are skipped entirely and -- like V1's protected tools -- are not charged to the
 * protect budget either, so they never crowd out real candidates.
 */
const isPrunable = (tool: SessionMessage.AssistantTool) =>
  tool.state.status === "completed" && tool.provider?.executed !== true && !PRUNE_PROTECTED_TOOLS.has(tool.name)

/** One tool result this pass cleared, addressed exactly as the durable mark needs it. */
export type PrunedEntry = {
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
}

export type PruneResult<T> = {
  readonly entries: readonly T[]
  /** Estimated tokens this pass removed from the provider request. */
  readonly freed: number
  /** Tool results replaced by the sentinel, including those honouring an existing durable mark. */
  readonly count: number
  /**
   * Identities of the results this pass newly cleared, for the durable `Compaction.Pruned` mark.
   *
   * Newly cleared only: entries that already carry `time.pruned` are honoured at read time but are
   * deliberately absent, because re-publishing a mark they already have would append an event per
   * turn for the rest of the session's life.
   */
  readonly cleared: readonly PrunedEntry[]
}

/**
 * Deterministic, LLM-free reclamation of stale tool output.
 *
 * Walks newest to oldest, exempting the turns `select` preserves verbatim, stopping at the newest
 * compaction, and protecting the most recent `PRUNE_PROTECT` tokens of tool output. Anything older
 * is cleared only when the total reclaimed exceeds `PRUNE_MINIMUM`, so a pass either frees a
 * worthwhile amount or changes nothing at all.
 *
 * `turns` must track `compaction.keep.turns`. It was hardcoded at V1's 2 while `select` honoured
 * the configured value, so "keep my last 5 turns verbatim" was satisfied with sentinels: prune
 * cleared turns 3 and 4 and `select` then dutifully preserved the cleared version.
 *
 * The boundary is monotone -- the turn exemption, the compaction stop and the protect window only
 * ever slide forward as history grows -- so the cleared prefix only grows and provider
 * prompt-cache prefixes stay stable across turns. That monotonicity is what makes it safe to
 * recompute on every turn instead of persisting the decision as V1 did.
 */
export const pruneEntries = <T extends { readonly message: SessionMessage.Message }>(
  entries: readonly T[],
  options?: {
    readonly enabled?: boolean
    readonly dedup?: boolean
    readonly inputs?: boolean
    readonly media?: boolean
    readonly turns?: number
  },
): PruneResult<T> => {
  // V1's floor. `keep.turns: 0` disables turn *alignment* in `select`; it is not a request to prune
  // the turn the model is answering right now.
  const exempt = Math.max(DEFAULT_KEEP_TURNS, options?.turns ?? DEFAULT_KEEP_TURNS)
  const key = (messageID: string, callID: string) => `${messageID} ${callID}`
  // Keyed by the same string the membership tests use, but carrying the identity rather than
  // discarding it: the durable mark needs to name the exact parts, and re-deriving them from a
  // packed key would mean parsing message IDs back out of a string.
  const targets = new Map<string, PrunedEntry>()
  const adopted = new Set<string>()
  // Shell surface messages are the one payload prune could not reach: up to 1MB apiece, never
  // part of an assistant message, and never behind a provider-measured turn. Cleared read-time
  // only — the Shell schema has no durable pruned mark yet, so the desktop keeps rendering the
  // full output while the model sees the sentinel. The boundary is monotone like tool pruning.
  const shells = new Set<string>()
  // Dedup: an older result byte-identical to a newer one is cleared even inside the protect
  // window — nothing is destroyed, the newer copy carries every byte. Unlike prune it is not
  // gated on PRUNE_MINIMUM for the same reason. Monotone: the newer copy persists in history,
  // so a duplicate stays a duplicate on every later turn and the cache prefix stays stable.
  // Read-time only, like shells: no durable mark names a duplicate clearing.
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  let dupFreed = 0
  // Input clearing is exemption-only — not protect-gated, not minimum-gated — because like
  // dedup it destroys nothing: the body is on disk and in the edit's structured diff. Charging
  // it to the shared protect window benchmarked at +38% billed tokens (each deep-prefix
  // clearing breaks the cache for the whole suffix) while exemption-only clearing transitions
  // each body once, near the tail, where the break is cheap. Read-time only: inputs have no
  // durable pruned mark, so `cleared` never names them.
  const inputs = new Set<string>()
  let inputFreed = 0
  // Media clearing: user-message attachments with media mimes, past the protect window.
  // Priced at wire cost, not the gate's flat MEDIA_TOKENS: the clearing decision is about the
  // base64 bytes replayed every turn, and at 1,600 flat eight screenshots could never cross
  // the window. `source.text` attachments are content, never media, and are never touched.
  const media = new Set<string>()
  let total = 0
  let freed = 0
  let turns = 0

  scan: for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]!.message
    // Everything at or before the newest compaction already sits behind a summary.
    if (message.type === "compaction") break scan
    if (message.type === "user" && message.source !== "subagent_board") turns++
    // Exempt exactly what `select` preserves verbatim: `turns < N` leaves the newest N-1 complete
    // turns and the turn in progress untouched, which is the region `tailStart` keeps whole.
    if (turns < exempt) {
      // Exempt-window unique outputs are never cleared, but dedup still applies: the newest copy
      // survives and any older byte-identical copy is redundant even within the current turn.
      // Gated on `enabled` like every clearing: `compaction.prune: false` means "do not touch my
      // replay", and dedup is a replay reduction however safe its semantics are.
      if (message.type === "assistant")
        for (const item of message.content) {
          if (item.type !== "tool") continue
          // Previously written marks remain authoritative even when the exemption grows.
          if (item.time.pruned !== undefined) {
            adopted.add(key(message.id, item.id))
            continue
          }
          if (options?.enabled !== true || options?.dedup !== true) continue
          if (!isPrunable(item) || item.state.status !== "completed") continue
          const serialized = serializeToolOutput(item.state)
          if (serialized.length < DEDUP_MIN_CHARS) continue
          if (seen.has(serialized)) {
            duplicates.add(key(message.id, item.id))
            dupFreed += Token.estimate(serialized)
            continue
          }
          seen.add(serialized)
        }
      continue
    }
    if (options?.enabled === true && options?.media === true && message.type === "user" && message.files?.length) {
      const mediaFiles = message.files.filter(
        (file) => file.source?.text === undefined && !file.uri.startsWith("cleared:"),
      )
      if (mediaFiles.length > 0) {
        const tokens = mediaFiles.reduce((sum, file) => sum + Token.estimate(file.uri), 0)
        total += tokens
        if (total > PRUNE_PROTECT) {
          freed += tokens
          media.add(message.id)
        }
      }
    }
    if (message.type === "shell") {
      if (message.output.length === 0 || message.output === PRUNED_TEXT) continue
      const tokens = Token.estimate(message.output)
      total += tokens
      if (total <= PRUNE_PROTECT) continue
      freed += tokens
      shells.add(message.id)
      continue
    }
    if (message.type !== "assistant") continue
    for (let position = message.content.length - 1; position >= 0; position--) {
      const item = message.content[position]!
      if (item.type !== "tool") continue
      if (
        options?.enabled === true &&
        options?.inputs === true &&
        item.provider?.executed !== true &&
        INPUT_PRUNABLE_TOOLS.has(item.name) &&
        item.state.status !== "pending"
      ) {
        const oversized = Object.values(item.state.input).reduce(
          (sum: number, value) =>
            typeof value === "string" && value.length > INPUT_PRUNE_FIELD_MIN_CHARS ? sum + value.length : sum,
          0,
        )
        if (oversized > 0) {
          inputFreed += Math.round(oversized / CHARS_PER_TOKEN)
          inputs.add(key(message.id, item.id))
        }
      }
      if (item.time.pruned !== undefined) {
        adopted.add(key(message.id, item.id))
        continue
      }
      if (!isPrunable(item) || item.state.status !== "completed") continue
      if (options?.enabled === true && options?.dedup === true) {
        const serialized = serializeToolOutput(item.state)
        if (serialized.length >= DEDUP_MIN_CHARS) {
          if (seen.has(serialized)) {
            duplicates.add(key(message.id, item.id))
            dupFreed += Token.estimate(serialized)
            // Not charged to the protect budget: the budget protects unique recent content,
            // and these bytes still exist verbatim in the newer copy.
            continue
          }
          seen.add(serialized)
        }
      }
      const tokens = completedOutputTokens(item.state)
      total += tokens
      if (total <= PRUNE_PROTECT) continue
      freed += tokens
      targets.set(key(message.id, item.id), { assistantMessageID: message.id, callID: item.id })
    }
  }

  const active = options?.enabled === true && freed > PRUNE_MINIMUM ? targets : new Map<string, PrunedEntry>()
  const activeShells = options?.enabled === true && freed > PRUNE_MINIMUM ? shells : new Set<string>()
  const activeInputs = options?.enabled === true ? inputs : new Set<string>()
  const activeMedia = options?.enabled === true && freed > PRUNE_MINIMUM ? media : new Set<string>()
  if (
    active.size === 0 &&
    adopted.size === 0 &&
    activeShells.size === 0 &&
    duplicates.size === 0 &&
    activeInputs.size === 0 &&
    activeMedia.size === 0
  )
    return { entries, freed: 0, count: 0, cleared: [] }
  const isCleared = (messageID: string, callID: string) =>
    active.has(key(messageID, callID)) || adopted.has(key(messageID, callID))

  const replaced = entries.map((entry) => {
    const message = entry.message
    if (message.type === "shell" && activeShells.has(message.id))
      return { ...entry, message: { ...message, output: PRUNED_TEXT } }
    if (message.type === "user" && activeMedia.has(message.id))
      return {
        ...entry,
        message: {
          ...message,
          files: message.files?.map((file) =>
            file.source?.text === undefined && !file.uri.startsWith("cleared:")
              ? {
                  ...file,
                  uri: `cleared:${file.name ?? "image"}`,
                  mime: "text/plain",
                  // Source spans are byte offsets into composer text; a synthesized note has none.
                  source: { text: PRUNED_MEDIA_TEXT(file.name), start: 0, end: 0 },
                }
              : file,
          ),
        },
      }
    if (message.type !== "assistant") return entry
    if (
      !message.content.some(
        (item) =>
          item.type === "tool" &&
          (isCleared(message.id, item.id) ||
            duplicates.has(key(message.id, item.id)) ||
            activeInputs.has(key(message.id, item.id))),
      )
    )
      return entry
    return {
      ...entry,
      message: {
        ...message,
        content: message.content.map((item) => {
          if (item.type !== "tool") return item
          const clearInput = activeInputs.has(key(message.id, item.id)) && item.state.status !== "pending"
          const outputState =
            item.state.status !== "completed"
              ? item.state
              : duplicates.has(key(message.id, item.id))
                ? prunedState(item.state, PRUNED_DUPLICATE_TEXT)
                : isCleared(message.id, item.id)
                  ? prunedState(item.state)
                  : item.state
          if (!clearInput) return outputState === item.state ? item : { ...item, state: outputState }
          if (outputState.status === "pending") return item
          return { ...item, state: { ...outputState, input: prunedInput(outputState.input) } }
        }),
      },
    }
  })

  return {
    entries: replaced,
    // `freed` carries the protect-gated clearings (outputs, shells, media); inputs and dedup
    // report separately because they are never gated on the shared minimum.
    freed:
      (active.size === 0 && activeShells.size === 0 && activeMedia.size === 0 ? 0 : freed) +
      dupFreed +
      (activeInputs.size === 0 ? 0 : inputFreed),
    count: active.size + adopted.size + activeShells.size + duplicates.size + activeInputs.size + activeMedia.size,
    // Oldest first: the scan runs newest to oldest, and an event whose entries read backwards
    // against the transcript is needlessly hard to match up in a log or a test.
    cleared: [...active.values()].reverse(),
  }
}

type Item = {
  readonly text: string
  readonly tokens: number
  readonly seq: number
  /** True for a real user message, which is where a conversational turn starts. */
  readonly start: boolean
}

/**
 * Index at which the preserved tail begins.
 *
 * Two independent caps, as in V1: `tokens` bounds how much is kept, `turns` bounds how many whole
 * turns are kept, and whichever binds first wins. Unlike V1 the tail is still prose rather than
 * real messages, but the boundary is now message-aligned and, where the budget allows,
 * turn-aligned -- so it can no longer land in the middle of a serialized message and hand the
 * summarizer one severed half while handing the model the other.
 */
const tailStart = (items: readonly Item[], options: { readonly tokens: number; readonly turns: number }) => {
  if (options.tokens <= 0) return items.length
  let total = 0
  let greedy = items.length
  for (let index = items.length - 1; index >= 0; index--) {
    const next = total + items[index]!.tokens
    if (next > options.tokens) break
    total = next
    greedy = index
  }
  if (options.turns <= 0) return greedy
  const starts = items.flatMap((item, index) => (item.start ? [index] : []))
  if (starts.length === 0) return greedy
  // Turn cap: never reach back past the Nth most recent turn.
  const floor = starts.length > options.turns ? starts[starts.length - options.turns]! : 0
  // Token cap: snap forward to the nearest whole turn the budget can afford. When no whole turn
  // fits, the greedy message boundary stands -- V1's partial-turn fallback, which never includes
  // the turn's own user message because that message is itself a turn start.
  const aligned = starts.find((index) => index >= greedy) ?? greedy
  return Math.max(aligned, floor)
}

export const select = (
  entries: readonly Entry[],
  options: { readonly tokens: number; readonly turns: number; readonly preserveCurrentTurn?: boolean },
): { readonly head: string; readonly recent: string; readonly throughSeq?: number } | undefined => {
  const items: Item[] = []
  for (const entry of entries) {
    if (entry.message.type === "compaction") continue
    const text = serializeMessage(entry.message)
    if (!text) continue
    // Wire cost, not the bounded summarization view. `tailStart` decides what stays OUT of the
    // summary, and everything it keeps is replayed whole by `toLLMMessage` — so measuring the
    // kept tail with the 2k-capped view let `keep.tokens: 8k` preserve megabytes: a 1MB shell
    // dump "cost" ~500 tokens here while shipping ~260k on the wire, and a checkpoint that kept
    // it cleared nothing. The head still summarizes from the bounded `text`, so the summary
    // prompt itself stays small; only the keep/cut decision prices real bytes.
    items.push({
      text,
      tokens: wireTokens(entry.message),
      seq: entry.seq,
      start: entry.message.type === "user" && entry.message.source !== "subagent_board",
    })
  }
  if (items.length === 0) return
  const selectedSplit = tailStart(items, options)
  const currentTurn = options.preserveCurrentTurn ? items.findLastIndex((item) => item.start) : -1
  // Preserving the in-flight turn verbatim is right until the turn itself is the
  // bulk of the session: on the measured corpus this clamp fired on 156/275
  // compactions and forced a median 33.5k extra tokens (max 308k) into the tail,
  // so compaction ran and freed almost nothing — which is why marathon sessions
  // compacted nine times. Honour the clamp only while the turn it rescues fits a
  // bounded multiple of the keep budget; past that the turn is summarized like
  // any other history and the boundary falls back to the token-aligned split.
  const currentTurnTokens =
    currentTurn === -1 ? 0 : items.slice(currentTurn).reduce((total, item) => total + item.tokens, 0)
  // Floor at the default keep budget, not at 1: on a tiny-context model
  // `retainedBudget` collapses to 0, and scaling 0 gave a 2-token allowance that no
  // in-flight turn could ever fit — summarizing away the very instruction the clamp
  // exists to protect. On real models `options.tokens` is already >= the default, so
  // the floor never binds and the measured behaviour is unchanged.
  const clampBudget = Math.max(options.tokens, DEFAULT_KEEP_TOKENS) * PRESERVE_CURRENT_TURN_BUDGET_MULTIPLE
  const preservable = currentTurn !== -1 && currentTurnTokens <= clampBudget
  const split = !preservable ? selectedSplit : selectedSplit <= 0 ? currentTurn : Math.min(selectedSplit, currentTurn)
  const join = (values: readonly Item[]) => values.map((item) => item.text).join("\n\n")
  // A tail that would swallow the whole history leaves nothing to summarize. If `preserveCurrentTurn`
  // is set, the current turn becomes a structured row, not prose in the summary. Declining here
  // prevents discarding it without summarizing.
  if (split <= 0) {
    if (preservable) return
    return { head: join(items), recent: "" }
  }
  const tail = items.slice(split)
  // The partial-turn fallback can open the tail past the turn's own [User]
  // line — the common shape when a single in-flight turn outgrows the token
  // budget on tool output. The literal instruction must survive compaction
  // verbatim, not merely as the summarizer's paraphrase of it, so when the
  // tail carries no user line of its own the newest one is prepended (bounded:
  // instructions front-load their intent).
  const newestUser = tail.some((item) => item.start) ? undefined : items.slice(0, split).findLast((item) => item.start)
  const bounded =
    newestUser && newestUser.text.length > PRESERVED_USER_CHARACTERS
      ? `${newestUser.text.slice(0, PRESERVED_USER_CHARACTERS)}\n[instruction truncated]`
      : newestUser?.text
  return {
    head: join(items.slice(0, split)),
    // Automatic compaction retains the tail as its original structured message rows. This keeps
    // attachments, provider-native tool results, ignored-part semantics, and messages committed
    // while the summary is streaming. `recent` remains for manual and legacy checkpoints.
    recent:
      options.preserveCurrentTurn === true
        ? ""
        : bounded === undefined
          ? join(tail)
          : [bounded, join(tail)].join("\n\n"),
    ...(options.preserveCurrentTurn === true && items[split - 1] ? { throughSeq: items[split - 1].seq } : {}),
  }
}

/** Cap for the force-preserved user instruction inside `recent`. */
const PRESERVED_USER_CHARACTERS = 4_000

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

const SUMMARY_HEADINGS = [
  "## Objective",
  "## Important Details",
  "## Work State",
  "### Completed",
  "### Active",
  "### Blocked",
  "## Next Move",
  "## Relevant Files",
  "## Durable Memories",
] as const

/**
 * A checkpoint TurenOS writes itself when the model cannot write one.
 *
 * The floor under summarization. Every provider failure used to end the same way -- no checkpoint,
 * the head still in context, and the next turn overflowing again -- which is how a real session
 * became permanently uncompactable: five consecutive failures, no path back, and the manual
 * escape hatch failing identically. An aggressively elided excerpt is a bad summary and a working
 * session; no checkpoint at all is a dead one.
 *
 * It is deliberately honest rather than plausible: it says who wrote it and why, and it presents
 * its contents as raw history rather than as established fact, so the model does not mistake a
 * mechanical excerpt for a considered summary. It satisfies `validSummary` so every consumer of a
 * checkpoint keeps its structural guarantee -- including the next compaction, which anchors on it.
 */
export const fallbackSummary = (input: {
  readonly head: string
  readonly partial?: string | undefined
  readonly detail?: string | undefined
}) => {
  // Excerpts carry old checkpoints and markdown from the conversation, and a stray `## Objective`
  // in the body would break the "each heading exactly once" invariant this text has to satisfy.
  const neutralize = (value: string) =>
    value
      .split("\n")
      .map((line) => (line.trimStart().startsWith("#") ? `> ${line.trim()}` : line))
      .join("\n")
  const partial = input.partial?.trim() ? neutralize(elide(input.partial.trim(), FALLBACK_PARTIAL_CHARS)) : undefined
  const excerpt = neutralize(elide(input.head, FALLBACK_EXCERPT_CHARS))
  const cause = input.detail?.trim() ? `: ${elide(input.detail.trim(), 300, " … ")}` : ""
  return [
    "## Objective",
    `- Recover the objective from the preserved excerpt under "Durable Memories" below, and confirm it before acting.`,
    "",
    "## Important Details",
    `- This checkpoint was written by TurenOS, not by a model. Summarization failed${cause}, so the history was replaced with a bounded excerpt rather than a summary.`,
    "- Treat everything below as raw, partial history: it is quoted transcript, not established fact.",
    ...(partial === undefined ? [] : ["- The model produced this much before it failed:", "", partial, ""]),
    "",
    "## Work State",
    "",
    "### Completed",
    "- Unknown. The excerpt below is the only surviving record of what was already done.",
    "",
    "### Active",
    "- Unknown. Re-read the excerpt below before continuing the work.",
    "",
    "### Blocked",
    `- Summarization of this session failed${cause}.`,
    "",
    "## Next Move",
    "1. Read the excerpt below, state what you believe the current task is, and confirm it before making changes.",
    "",
    "## Relevant Files",
    "- Unknown. Any paths mentioned in the excerpt below are the best available record.",
    "",
    "## Durable Memories",
    "- Preserved excerpt of the summarized history (middle elided):",
    "",
    excerpt,
  ].join("\n")
}

export const validSummary = (summary: string) => {
  const lines = summary.trim().split("\n")
  if (lines.length === 0) return false

  // First line must be the first heading exactly
  if (lines[0]?.trim() !== SUMMARY_HEADINGS[0]) return false

  // Find each required heading as a line-leading heading (not substring)
  const positions = SUMMARY_HEADINGS.map((heading) =>
    lines.flatMap((line, index) => (line.trim() === heading ? [index] : [])),
  )

  // Each heading must appear exactly once
  if (positions.some((matches) => matches.length !== 1)) return false

  const indexes = positions.map((matches) => matches[0] ?? -1)

  // Headings must appear in order (monotonically increasing)
  if (indexes.some((index, position) => position > 0 && index <= (indexes[position - 1] ?? -1))) return false

  // Every mandatory section must have content (non-empty, non-whitespace)
  for (const position of [0, 1, 3, 4, 5, 6, 7, 8]) {
    const content = lines
      .slice((indexes[position] ?? -1) + 1, indexes[position + 1] ?? lines.length)
      .filter((line) => line.trim().length > 0)

    if (content.length === 0) return false

    if (position === 6) {
      // Next Move section must start with "1. "
      if (!content.some((line) => /^1\.\s+\S/.test(line))) return false
      continue
    }
    if (!content.some((line) => /^-\s+\S/.test(line))) return false
  }
  return true
}

const effectiveOutput = (request: LLMRequest) =>
  request.generation?.maxTokens ??
  request.model.defaults?.generation?.maxTokens ??
  request.model.route.defaults.generation?.maxTokens ??
  request.model.route.defaults.limits?.output ??
  0

/** Char-based request estimate, with media charged at provider prices rather than base64 length. */
export const estimateRequest = (request: LLMRequest) => {
  let media = 0
  const json = JSON.stringify(
    { system: request.system, messages: request.messages, tools: request.tools },
    (_key, value: unknown) => {
      if (typeof value === "string" && value.startsWith("data:") && value.length > MEDIA_URI_MIN_CHARS) {
        media += 1
        return "[media]"
      }
      return value
    },
  )
  return Token.estimate(json) + media * MEDIA_TOKENS
}

/** The same window total the context panel shows (`app/.../session-context-metrics.ts`). */
const contextTotal = (tokens: NonNullable<SessionMessage.Assistant["tokens"]>) =>
  tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning

/**
 * What one delta message costs on the wire, not in the summarization view.
 *
 * `serializeMessage` deliberately bounds tool results (2k default) and shell output (2k) —
 * right for building a summary prompt, catastrophically wrong for occupancy: `toLLMMessage`
 * ships both whole. Shell surface messages are the worst case on both axes: up to
 * `SessionShell.MAX_OUTPUT_BYTES` (1MB ≈ 260k tokens, counted as ~500) *and* they never
 * produce a provider-measured turn, so the baseline never advances past them — repeated
 * terminal commands accumulated gate-invisible megabytes until the provider overflowed.
 * That is precisely how a 1.05M-window gpt-5.6-luna session died at ~79k reported tokens.
 */
const wireTokens = (message: SessionMessage.Message) => {
  if (message.type === "shell") return Token.estimate(message.command) + Token.estimate(message.output)
  if (message.type === "assistant")
    return message.content.reduce((total, part) => {
      if (part.type === "text" || part.type === "reasoning") return total + Token.estimate(part.text)
      if (part.type !== "tool") return total
      const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
      const output = part.state.status === "completed" ? serializeToolOutput(part.state) : ""
      return total + Token.estimate(input) + Token.estimate(output)
    }, 0)
  return Token.estimate(serializeMessage(message))
}

/**
 * Context occupancy anchored to the provider's own token accounting.
 *
 * The newest completed assistant turn already carries the exact prompt+response token count
 * the provider charged for, so the whole history up to that turn needs no estimation at all —
 * only the messages admitted since. That makes the gate agree with the context panel (which
 * reads the same numbers) and immune to the estimator's two systematic errors: JSON/encoding
 * overhead inflating dense histories, and 4-chars-per-token undercounting dense tokenizers.
 *
 * The baseline must postdate the newest checkpoint: a preserved-tail turn measured its
 * occupancy against the pre-compaction window, so trusting it would report the freed context
 * as still occupied. It must also match the current model — another model's tokenizer priced
 * a different request. Either miss falls back to `estimateRequest`.
 */
export const reportedOccupancy = (entries: readonly Entry[], model: Model) => {
  const checkpoint = entries.findLast((entry) => entry.message.type === "compaction")?.message
  const checkpointMillis = checkpoint === undefined ? undefined : DateTime.toEpochMillis(checkpoint.time.created)
  const index = entries.findLastIndex((entry) => {
    const message = entry.message
    if (message.type !== "assistant" || message.tokens === undefined) return false
    if (String(message.model.providerID) !== String(model.provider)) return false
    if (String(message.model.id) !== String(model.id)) return false
    if (checkpointMillis !== undefined && DateTime.toEpochMillis(message.time.created) <= checkpointMillis) return false
    return contextTotal(message.tokens) > 0
  })
  if (index === -1) return
  const baseline = entries[index]!.message
  if (baseline.type !== "assistant" || baseline.tokens === undefined) return
  // The baseline's own locally executed tool results settled after its usage was measured, so
  // they are in neither the reported count nor the entries that follow it. Without them the
  // gate lags one step's tool output behind reality.
  // Lower the actual results, including failures and media, rather than the
  // summarizer's text view. Failed tools and attached source files cost tokens too.
  const results = toLLMMessages([baseline], model).filter((message) => message.role === "tool")
  const settledAfterBaseline = results.length === 0 ? 0 : estimateRequest(LLM.request({ model, messages: results }))
  return entries
    .slice(index + 1)
    .reduce(
      (total, entry) =>
        total + estimateRequest(LLM.request({ model, messages: toLLMMessages([entry.message], model) })),
      contextTotal(baseline.tokens) + settledAfterBaseline,
    )
}

/** Soft context pressure, independent of hard input/output reserves and request margins. */
export const needsPruning = (input: {
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}) => {
  const context = input.model.route.defaults.limits?.context
  if (context === undefined || !Number.isFinite(context) || context <= 0) return false
  const occupancy = reportedOccupancy(input.entries, input.model) ?? estimateRequest(input.request)
  return occupancy >= Math.floor(context * CONTEXT_TARGET)
}

/**
 * Shrink the request's output allowance to what the window can still hold.
 *
 * Anthropic-style providers validate `prompt + max_tokens <= context` and reject the whole
 * request when the sum exceeds it, even though the model would have stopped long before the
 * cap. The gate deliberately reserves less than the full output limit (`OUTPUT_RESERVE_CAP`),
 * so inside that band the configured allowance no longer fits and must shrink with it. A
 * healthy request — occupancy below `context - allowance` — is returned untouched, so this
 * never truncates thinking or long outputs in normal operation.
 */
export const clampOutput = (input: {
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}) => {
  const context = input.model.route.defaults.limits?.context
  if (context === undefined || context <= 0) return input.request
  const output = effectiveOutput(input.request)
  if (output <= 0) return input.request
  const occupancy = reportedOccupancy(input.entries, input.model) ?? estimateRequest(input.request)
  const available = context - occupancy - REQUEST_MARGIN_TOKENS
  if (available >= output) return input.request
  // Nothing fits: an unclamped request draws the provider's real overflow error, which the
  // recovery path understands. A max_tokens of 1 would "succeed" with a useless reply instead.
  if (available <= 0) return input.request
  return LLMRequest.update(input.request, {
    generation: GenerationOptions.make({ ...input.request.generation, maxTokens: available }),
  })
}

/**
 * Shrink the summarization prompt until it fits the model.
 *
 * A single enormous message -- one huge tool result, one pasted file -- used to make a session
 * permanently uncompactable: the prompt exceeded the context, the guard bailed, and it bailed
 * identically on every subsequent turn. V1's escape hatch was to strip media and then report a
 * distinguishable error; V2 already serializes media as `[Attached ...]`, so there is nothing left
 * to strip and the error would be all that remained. Eliding instead means a summary is always
 * producible. Degradation order is deliberate: the serialized head first (largest, and most
 * redundant in the middle), then the carried-over recent context, then the anchored summary, and
 * only as a last resort the template itself.
 */
export const fitPrompt = (
  input: {
    readonly previousSummary: string | undefined
    readonly priorRecent: string | undefined
    readonly head: string
  },
  maxChars: number,
) => {
  const build = (head: string, priorRecent: string | undefined, previousSummary: string | undefined) =>
    buildPrompt({
      previousSummary,
      context: [priorRecent, head].filter((value): value is string => Boolean(value)),
    })
  const full = build(input.head, input.priorRecent, input.previousSummary)
  if (full.length <= maxChars) return { prompt: full, elided: false }
  const present = [input.previousSummary, input.priorRecent, input.head].filter(
    (value): value is string => value !== undefined && value.length > 0,
  )
  const fixed =
    build(input.head ? "x" : "", input.priorRecent ? "x" : undefined, input.previousSummary ? "x" : undefined).length -
    present.length
  const available = maxChars - fixed
  if (present.length > 0 && available >= present.length * ELISION.length) {
    const share = Math.floor(available / present.length)
    const previousSummary = input.previousSummary ? elide(input.previousSummary, share) : undefined
    const priorRecent = input.priorRecent ? elide(input.priorRecent, share) : undefined
    const used = (previousSummary?.length ?? 0) + (priorRecent?.length ?? 0)
    return {
      prompt: build(elide(input.head, Math.max(ELISION.length, available - used)), priorRecent, previousSummary),
      elided: true,
    }
  }
  return { prompt: elide(full, maxChars), elided: true }
}

export const make = (dependencies: Dependencies) => {
  const loadSettings = Effect.map(dependencies.config, settings)

  // Every declined compaction used to be an unlogged `return false`. `run` is only reached once a
  // compaction has actually been attempted (over budget, provider overflow, or a user asking for
  // it), so logging here is rare rather than per-turn noise.
  const decline = Effect.fnUntraced(function* (input: Input, reason: FailureReason, mode: Reason) {
    yield* Effect.logWarning("Compaction did not produce a summary").pipe(
      Effect.annotateLogs({ sessionID: input.sessionID, reason, mode, detail: FAILURE_MESSAGE[reason] }),
    )
    return { ok: false, reason } as const satisfies Outcome
  })

  /**
   * Durable facts in the segment this compaction just summarized.
   *
   * Best-effort by design. The ledger is an enrichment of a checkpoint that is already complete
   * and correct, so every failure mode -- provider error, a defect in the client, a response with
   * no bullets in it -- degrades to "this segment contributed no facts" rather than to a failed
   * compaction. The one thing deliberately NOT caught is interruption: an interrupted compaction
   * must stay interrupted, and `run`'s own handler publishes the durable `Failed` breadcrumb.
   *
   * It streams like the summary but publishes no `Delta`: the checkpoint the desktop renders is
   * the summary, and interleaving a bullet list into that stream would corrupt it. `run` starts it
   * once the summary's required opening heading arrives, overlapping the remaining generations
   * without spending a second request on an obviously malformed summary. The child stays
   * supervised so a later truncation or interruption cancels provider work before `run` settles.
   */
  const extract = Effect.fn("SessionCompaction.extract")(function* (
    sessionID: SessionSchema.ID,
    head: string,
    model: Model,
    context: number,
  ) {
    const output = Math.min(
      model.defaults?.generation?.maxTokens ??
        model.route.defaults.generation?.maxTokens ??
        model.route.defaults.limits?.output ??
        LEDGER_OUTPUT_TOKENS,
      LEDGER_OUTPUT_TOKENS,
    )
    const budget =
      usableBudget({ context, input: model.route.defaults.limits?.input }, output) -
      Token.estimate(LEDGER_SYSTEM) -
      Token.estimate(LEDGER_PROMPT) -
      REQUEST_MARGIN_TOKENS
    // A model with no room for the extractor's own prompt still gets a summary; it just gets no
    // ledger. Never a reason to decline the compaction.
    if (budget <= 0) return []
    const chunks: string[] = []
    let failed = false
    const completed = yield* dependencies.llm
      .stream(
        LLM.request({
          model,
          // The extractor's own system prompt replaces the summarizer's: the compaction agent's
          // prompt describes writing a structured summary, which is the wrong instruction here.
          system: LEDGER_SYSTEM,
          messages: [Message.user(`${LEDGER_PROMPT}${elide(head, budget * CHARS_PER_TOKEN)}${LEDGER_PROMPT_SUFFIX}`)],
          tools: [],
          generation: { maxTokens: output },
        }),
      )
      .pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (LLMEvent.is.providerError(event)) failed = true
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          }),
        ),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        Effect.catchDefect(() => Effect.succeed(false)),
      )
    if (!completed || failed) {
      yield* Effect.logDebug("Compaction could not extract durable facts for the ledger").pipe(
        Effect.annotateLogs({ sessionID }),
      )
      return []
    }
    return parseLedgerLines(chunks.join(""))
  })

  /**
   * Read-time tool-output pruning for one provider turn.
   *
   * New reductions are pressure-gated by the caller. Rebuild-only calls pass `reduce: false`
   * to honour durable marks without changing any other historical content. Only new clearings
   * publish events; rebuilding an already-pruned view is a pure in-memory pass.
   */
  const prune = Effect.fn("SessionCompaction.prune")(function* <T extends { readonly message: SessionMessage.Message }>(
    sessionID: SessionSchema.ID,
    entries: readonly T[],
    reduce = true,
  ) {
    const config = yield* loadSettings
    const result = pruneEntries(entries, {
      enabled: reduce && config.prune,
      dedup: reduce && config.dedupOutputs,
      inputs: reduce && config.pruneInputs,
      media: reduce && config.pruneMedia,
      turns: config.turns,
    })
    if (result.count > 0)
      yield* Effect.logDebug("Compaction cleared stale tool output").pipe(
        Effect.annotateLogs({ sessionID, cleared: result.count, freed: result.freed }),
      )
    // The one durable write on this path, and only for results this pass newly cleared. It marks
    // rather than deletes: the transcript keeps every byte, so the desktop can say the model no
    // longer sees this output instead of silently rendering a result the model lost. An already
    // marked entry is re-honoured at read time and republishes nothing, so a session that keeps
    // pruning the same prefix appends one event per newly cleared result and no more.
    if (result.cleared.length > 0)
      yield* dependencies.events.publish(SessionEvent.Compaction.Pruned, {
        sessionID,
        timestamp: yield* DateTime.now,
        entries: result.cleared,
        freed: Math.max(0, Math.round(result.freed)),
      })
    return result.entries
  })

  const run = Effect.fn("SessionCompaction.run")(function* (input: Input, mode: Reason) {
    const config = yield* loadSettings
    const declaredContext = input.model.route.defaults.limits?.context
    // Overflow recovery reaches here without a gate check: the provider itself just said the
    // window overflowed, so a catalog entry with no declared window must not make recovery
    // impossible — that silent double-skip (gate at debug, decline at warn) is exactly how the
    // Luna overflow surfaced as a bare terminal error. 128k is the floor of current frontier
    // windows, so budgeting the summary against it is conservative. Manual compaction keeps
    // the explicit refusal: the user asked a question the catalog cannot answer.
    const context =
      declaredContext !== undefined && declaredContext > 0
        ? declaredContext
        : mode === "auto"
          ? FALLBACK_OVERFLOW_CONTEXT
          : undefined
    if (context === undefined) return yield* decline(input, "unknownContextWindow", mode)
    const retainedBudget = input.request
      ? Math.max(
          0,
          usableBudget(
            { context, input: input.model.route.defaults.limits?.input },
            Math.max(effectiveOutput(input.request), Math.min(config.buffer, Math.floor(context / 2))),
          ) -
            estimate({ system: input.request.system, tools: input.request.tools }) -
            SUMMARY_OUTPUT_TOKENS -
            REQUEST_MARGIN_TOKENS,
        )
      : config.tokens
    const selected = select(input.entries, {
      // A keep budget at or above the context would leave nothing to summarize.
      tokens: Math.min(config.tokens, Math.floor(context / 2), retainedBudget),
      turns: config.turns,
      preserveCurrentTurn: mode === "auto",
    })
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || selected.head.length === 0) return yield* decline(input, "emptyConversation", mode)
    // Resolve before fitting: the hidden compaction agent may use a much smaller model than the
    // Session. Fitting against the Session model and then sending to the override made the
    // summarizer itself overflow. Its system prompt consumes the same input budget too.
    const summarizer = dependencies.summarizer ? yield* dependencies.summarizer(input.sessionID) : {}
    const summaryModel = summarizer.model ?? input.model
    const declaredSummaryContext = summaryModel.route.defaults.limits?.context
    const summaryContext =
      declaredSummaryContext !== undefined && declaredSummaryContext > 0
        ? declaredSummaryContext
        : mode === "auto"
          ? FALLBACK_OVERFLOW_CONTEXT
          : undefined
    if (summaryContext === undefined) return yield* decline(input, "unknownContextWindow", mode)
    const summaryOutput = Math.min(
      summaryModel.defaults?.generation?.maxTokens ??
        summaryModel.route.defaults.generation?.maxTokens ??
        summaryModel.route.defaults.limits?.output ??
        SUMMARY_OUTPUT_TOKENS,
      SUMMARY_OUTPUT_TOKENS,
    )
    const promptBudget =
      usableBudget(
        { context: summaryContext, input: summaryModel.route.defaults.limits?.input },
        Math.max(summaryOutput, Math.min(config.buffer, Math.floor(summaryContext / 2))),
      ) -
      Token.estimate(summarizer.system ?? "") -
      REQUEST_MARGIN_TOKENS
    // Only a model whose whole context is smaller than one summary is genuinely uncompactable;
    // everything else is made to fit below.
    if (promptBudget <= 0) return yield* decline(input, "contextTooLarge", mode)
    // The character ceiling is not a restatement of the token budget: `Token.estimate` under-counts
    // dense JSON, and providers that cap an input *string* reject the request before counting
    // tokens at all. Whichever binds first wins.
    const promptChars = Math.min(promptBudget * CHARS_PER_TOKEN, SUMMARY_PROMPT_MAX_CHARS)
    const fitTo = (maxChars: number) =>
      fitPrompt(
        {
          previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
          priorRecent: previousSummary?.type === "compaction" ? previousSummary.recent : undefined,
          head: selected.head,
        },
        maxChars,
      )
    const fitted = fitTo(promptChars)
    const summaryPrompt = fitted.prompt
    if (fitted.elided)
      yield* Effect.logWarning("Compaction elided history to fit the summarization budget").pipe(
        Effect.annotateLogs({
          sessionID: input.sessionID,
          mode,
          head: selected.head.length,
          budget: promptChars,
        }),
      )
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason: mode,
    })
    const publishInterrupted = () =>
      Effect.gen(function* () {
        yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
          sessionID: input.sessionID,
          messageID,
          timestamp: yield* DateTime.now,
          mode,
          reason: "interrupted",
        })
      })

    const extractionReady = yield* Deferred.make<void>()
    const summarize = Effect.fn("SessionCompaction.summarize")(function* (prompt: string) {
      const chunks: string[] = []
      let providerFailed = false
      let contextOverflow = false
      // Why the provider failed, kept for the log line and for the fallback checkpoint's own text.
      // Its absence is what made this class of failure take a database forensics session to
      // diagnose: `providerFailed` alone says nothing about whether shrinking would have helped.
      let failure: string | undefined
      let finishReason: string | undefined
      let summaryFirstLine = ""
      let summaryOpeningChecked = false
      const completed = yield* dependencies.llm
        .stream(
          LLM.request({
            model: summaryModel,
            system: summarizer.system,
            messages: [Message.user(prompt)],
            tools: [],
            generation: { maxTokens: summaryOutput },
          }),
        )
        .pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (LLMEvent.is.providerError(event)) {
                providerFailed = true
                contextOverflow ||= isContextOverflowFailure(event)
                failure ??= event.message
              }
              if (LLMEvent.is.finish(event)) finishReason = event.reason
              if (!LLMEvent.is.textDelta(event)) return
              chunks.push(event.text)
              if (!summaryOpeningChecked) {
                summaryFirstLine += event.text
                const opening = /^\s*([^\r\n]+)\r?\n/.exec(summaryFirstLine)
                if (opening !== null) summaryOpeningChecked = true
                if (opening?.[1]?.trim() === SUMMARY_HEADINGS[0]) yield* Deferred.succeed(extractionReady, undefined)
              }
              // Defined since the V2 substrate landed and never published, so a compaction was a
              // silent multi-second stall with no stream to render.
              yield* dependencies.events.publish(SessionEvent.Compaction.Delta, {
                sessionID: input.sessionID,
                messageID,
                timestamp: yield* DateTime.now,
                text: event.text,
              })
            }),
          ),
          Effect.as(true),
          Effect.catchTag("LLM.Error", (error) => {
            providerFailed = true
            contextOverflow ||= isContextOverflowFailure(error)
            failure ??= error.message
            return Effect.succeed(false)
          }),
          Effect.catchDefect((defect) =>
            Effect.gen(function* () {
              yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
                sessionID: input.sessionID,
                messageID,
                timestamp: yield* DateTime.now,
                mode,
                reason: "providerFailed",
              })
              return yield* Effect.die(defect)
            }),
          ),
          Effect.onInterrupt(publishInterrupted),
        )
      return { completed, providerFailed, contextOverflow, failure, finishReason, summary: chunks.join("") }
    })
    /**
     * A failure the next attempt could plausibly fix by sending less.
     *
     * Deliberately not "was this classified as an overflow". Classification is a guess about a
     * provider's error text, and the guess that mattered -- OpenAI rejecting a 1.9M-character
     * summarization prompt as `string_above_max_length` -- was wrong, so the shrink-and-retry loop
     * sat behind a condition that never became true and the session had no way out. Any provider
     * failure that produced no summary earns a smaller prompt: the retry is cheap, bounded, and
     * strictly better than the alternative of giving up on the first try.
     */
    const shouldShrink = (result: SummaryAttempt) =>
      result.summary.trim().length === 0 && (result.providerFailed || !result.completed)
    const extraction = config.ledger
      ? yield* Deferred.await(extractionReady).pipe(
          Effect.andThen(extract(input.sessionID, selected.head, summaryModel, summaryContext)),
          Effect.forkChild({ startImmediately: true }),
        )
      : undefined
    let summarized = yield* summarize(summaryPrompt)
    const retries = SUMMARY_RETRIES[mode]
    for (let attempt = 1; attempt <= retries && shouldShrink(summarized); attempt += 1) {
      const halved = Math.max(1, Math.floor(promptChars / Math.pow(2, attempt)))
      // The last attempt abandons the geometry for a size nothing can reject. Halving alone is not
      // a floor: from a million characters it is still 62 500 on the fourth attempt, and a provider
      // that rejected the request for a reason unrelated to size would burn every attempt.
      const retryChars = attempt === retries ? Math.min(halved, SUMMARY_FLOOR_CHARS) : halved
      yield* Effect.logWarning("Compaction summary failed; retrying with a smaller prompt").pipe(
        Effect.annotateLogs({
          sessionID: input.sessionID,
          mode,
          attempt,
          budget: retryChars,
          overflow: summarized.contextOverflow,
          error: summarized.failure,
        }),
      )
      summarized = yield* summarize(fitTo(retryChars).prompt)
    }
    const summary = summarized.summary
    const failed = Effect.fnUntraced(function* (reason: FailureReason) {
      yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        mode,
        reason,
        ...(summarized.failure === undefined ? {} : { detail: elide(summarized.failure, 500, " … ") }),
      })
      return yield* decline(input, reason, mode)
    })
    const rejection: FailureReason | undefined =
      !summarized.completed || summarized.providerFailed
        ? "providerFailed"
        : !summary.trim()
          ? "emptySummary"
          : summarized.finishReason !== "stop" || !validSummary(summary)
            ? "invalidSummary"
            : undefined
    /**
     * Whether failing here would leave the session stuck.
     *
     * Measured against the keep budget rather than a flat size, because "large" is a statement
     * about this session's own configuration: a head at least as big as the tail compaction
     * preserves is a head whose loss is the difference between a session that can take a turn and
     * one that cannot. Below it nothing is rescued by a mechanical checkpoint -- a small session
     * that overflowed did not overflow because of its history -- so the real failure is reported
     * instead, and a healthy transcript is never traded for an excerpt.
     */
    const loadBearing = Token.estimate(selected.head) >= config.tokens
    if (rejection !== undefined && !loadBearing) return yield* failed(rejection)
    if (rejection !== undefined)
      yield* Effect.logWarning("Compaction fell back to a mechanical checkpoint").pipe(
        Effect.annotateLogs({
          sessionID: input.sessionID,
          mode,
          reason: rejection,
          attempts: retries + 1,
          head: selected.head.length,
          error: summarized.failure,
        }),
      )
    // The floor under the whole path: past this point a started compaction always ends in a
    // checkpoint. `text` is either the model's summary or one TurenOS wrote from the head itself.
    const checkpoint =
      rejection === undefined
        ? summary
        : fallbackSummary({ head: selected.head, partial: summary, detail: summarized.failure })
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const carried = previousSummary?.type === "compaction" ? (previousSummary.ledger ?? []) : []
        // A fallback checkpoint never waits for the extractor. Extraction only starts once the
        // summary opens with its first required heading, so on this path that signal will never
        // arrive -- joining it would hang the compaction that exists to keep the session alive --
        // and the extractor would be asking the same provider that just failed. The carried ledger
        // survives untouched, which is the point: it is the fact record the checkpoint anchors.
        const ledger =
          extraction === undefined
            ? carried
            : rejection !== undefined
              ? yield* Fiber.interrupt(extraction).pipe(Effect.as(carried))
              : appendLedger(
                  carried,
                  yield* restore(Fiber.join(extraction)).pipe(Effect.onInterrupt(publishInterrupted)),
                )
        // Once extraction completes, commit the one successful terminal event atomically with
        // respect to cancellation. Otherwise an interrupt racing this transaction can append a
        // Failed event after Ended durably committed for the same message ID.
        yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
          sessionID: input.sessionID,
          messageID,
          timestamp: yield* DateTime.now,
          reason: mode,
          text: checkpoint,
          recent: selected.recent,
          // Absent rather than empty when nothing has ever been extracted, so a checkpoint written
          // with the ledger disabled is indistinguishable from one written before it existed.
          ...(ledger.length === 0 ? {} : { ledger }),
          ...(selected.throughSeq === undefined ? {} : { throughSeq: selected.throughSeq }),
        })
        return COMPACTED
      }),
    )
  })

  /**
   * User-initiated compaction. Unlike the automatic paths it ignores `compaction.auto` and the
   * context budget entirely, and it reports why it declined instead of collapsing to `false`.
   */
  const compact = Effect.fn("SessionCompaction.compact")(function* (input: Input) {
    const outcome = yield* run(input, "manual")
    // A manual decline reached the user as an HTTP error and nothing else -- no event, so no
    // transcript, and a `/compact` that refused before it started looked exactly like one that was
    // never received. The automatic path has published this breadcrumb since the Luna overflow;
    // the path a user actually triggers deserves it more.
    if (
      !outcome.ok &&
      (outcome.reason === "unknownContextWindow" ||
        outcome.reason === "emptyConversation" ||
        outcome.reason === "contextTooLarge")
    )
      yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
        sessionID: input.sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        mode: "manual",
        reason: outcome.reason,
        detail: FAILURE_MESSAGE[outcome.reason],
      })
    return outcome
  })

  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const outcome = yield* run(input, "auto")
    // Pre-`Started` declines log a warning and nothing else, so a provider overflow whose
    // recovery declined was indistinguishable from one whose recovery never ran — diagnosing
    // the Luna overflow took grepping forge.log. Attempt failures already publish `Failed`
    // inside `run`; this covers only the declines that happen before `Started` exists.
    if (
      !outcome.ok &&
      (outcome.reason === "unknownContextWindow" ||
        outcome.reason === "emptyConversation" ||
        outcome.reason === "contextTooLarge")
    )
      yield* dependencies.events.publish(SessionEvent.Compaction.Failed, {
        sessionID: input.sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        mode: "auto",
        reason: outcome.reason,
      })
    return outcome.ok
  })

  // The pre-flight gate runs on literally every turn, so its two expected exits are logged at
  // debug rather than through `decline`. They stay distinguishable without becoming per-turn noise.
  const skip = (input: Input, reason: FailureReason) =>
    Effect.logDebug("Compaction not attempted").pipe(
      Effect.annotateLogs({ sessionID: input.sessionID, reason, detail: FAILURE_MESSAGE[reason] }),
      Effect.as(false),
    )

  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: BudgetInput) {
    const config = yield* loadSettings
    if (!config.auto) return yield* skip(input, "disabled")
    const context = input.model.route.defaults.limits?.context
    // Debug, not a warning: a model with no declared context window is a catalog fact, and this
    // gate runs on every turn. `run` still warns when a compaction is genuinely attempted.
    if (context === undefined || !Number.isFinite(context) || context <= 0)
      return yield* skip(input, "unknownContextWindow")
    const output = effectiveOutput(input.request)
    // A buffer at or above the context would put every turn permanently over budget.
    const buffer = Math.min(config.buffer, Math.floor(context / 2))
    // Provider-reported occupancy when a completed turn on this model exists past the newest
    // checkpoint; the media-aware character estimate only until then.
    const occupancy = reportedOccupancy(input.measured ?? input.entries, input.model) ?? estimateRequest(input.request)
    if (
      occupancy < Math.floor(context * CONTEXT_TARGET) &&
      occupancy + REQUEST_MARGIN_TOKENS <=
        usableBudget(
          { context, input: input.model.route.defaults.limits?.input },
          Math.max(Math.min(output, OUTPUT_RESERVE_CAP), buffer),
        )
    )
      return yield* skip(input, "notNeeded")
    return yield* compactAfterOverflow(input)
  })
  return {
    compact,
    compactIfNeeded,
    compactAfterOverflow,
    prune,
    /** Effective settings after folding and clamping, as of this read. For diagnostics and tests. */
    settings: loadSettings,
  }
}
