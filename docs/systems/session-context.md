# Session context and compaction

Session V2 manages the model context window through four services in `packages/core/src/session`: `SessionContextEpoch` for the system-prompt baseline, `SessionContextRequest` for the byte-stable rendered request frame, `SessionContextManagement` for agent-visible status and handoff checkpoints, and `SessionCompaction` for occupancy accounting, read-time tool-output pruning, and conversation summarization.

## Prompt-cache prefix and rendered request frame

Provider prompt caches match an exact prefix in the order: tool definitions, system prompt, then messages. Session V2 keeps each prefix segment stable across turns:

1. **System context epoch (`session_context_epoch`).** `SessionContextEpoch.prepare` (`packages/core/src/session/context-epoch.ts`) initializes a durable baseline from `SystemContextRegistry` and admits incremental changes (such as a local calendar date rollover) as chronological system messages instead of rewriting the baseline. When the update tail exceeds 4 entries (`MAX_SYSTEM_TAIL_UPDATES`) or 8,000 characters (`MAX_SYSTEM_TAIL_CHARS`), or after compaction or a completed reflection reset, the epoch folds the updates into a new baseline.
2. **Rendered request frame (`session_context_request`).** `SessionContextRequest.prepare` and `save` (`packages/core/src/session/context-request.ts`) persist the rendered `LLMRequest` messages and source message references per Session. On a normal follow-up turn, the runner reuses the saved frame prefix and appends only newly admitted messages.
   - Frame identity (`packages/core/src/session/runner/llm.ts`) hashes the catalog model reference, upstream model ID, route ID and defaults, compatibility flags, agent ID, base system prompt parts, and tool definitions, excluding the local-only `outputSchema`. Changing any of those starts a new frame generation with reason `"configuration"`.
   - Well-formed strings of at least 64 Ki characters (`BLOB_MIN_CHARS = 65_536`), such as base64 attachment payloads, are externalized once per Session into `session_context_blob` by SHA-256 and hydrated on load.
3. **One-turn runtime instructions.** Ephemeral per-turn guidance (`<todo_checkpoint>`, `<reflection_checkpoint>`, harness notices, and one-time context budget notes) is inserted after the cached historical prefix and before the newest user message.

## Occupancy accounting and budget thresholds

`SessionCompaction` targets keeping every Session under 40% of the model's context window (`CONTEXT_TARGET = 0.4`), with an absolute ceiling of 400,000 tokens (`CONTEXT_TARGET_TOKEN_CAP`) on windows larger than 1M tokens (`packages/core/src/session/compaction.ts`).

- **Provider-anchored occupancy (`reportedOccupancy`).** When a completed assistant turn exists after the latest compaction checkpoint and matches the active model, occupancy starts from that turn's provider-reported token total (`input + cache.read + cache.write + output + reasoning`), adds the wire estimate of local tool results settled on that baseline turn, and adds wire estimates for messages admitted after it.
- **Cold-request fallback (`estimateRequest`).** Before the first measured turn (or after a model switch or compaction), occupancy is estimated at 4 characters per token (`Token.estimate`) over `{ system, messages, tools }` omitting local-only tool output schemas, charging 1,600 tokens (`MEDIA_TOKENS`) per `data:` URI over 4,096 characters (`MEDIA_URI_MIN_CHARS`) instead of its base64 character length.
- **Output clamping (`clampOutput`).** The pre-flight gate caps the output reserve at 32,000 tokens (`OUTPUT_RESERVE_CAP`). When a request sits inside the band between `context - maxTokens` and `context - reserve`, `clampOutput` shrinks `generation.maxTokens` to `context - occupancy - 256` (`REQUEST_MARGIN_TOKENS`) so providers that validate `prompt + max_tokens <= context` do not reject the turn.
- **One-time budget nudges.** `SessionContextManagement` (`packages/core/src/session/context-management.ts`) injects at most one soft note at 30% occupancy (`SOFT_NUDGE = 0.3`) and one hard note at 40% occupancy (`BUDGET = 0.4`) per Session and context-window ordinal.

## Agent context tools

`ContextTools.node` (`packages/core/src/tool/context.ts`) and `RecallTool.node` (`packages/core/src/tool/recall.ts`) register three inline V2 tools:

| Tool | Behavior and limits |
| --- | --- |
| `session_context` | Calls `SessionContextManagement.status`. Reports `contextTokens` from the latest assistant message's single-request prompt occupancy (`input + cache.read + cache.write`, falling back to the newest `provider_usage` row, or `undefined` if a compaction checkpoint is newer), `window`, `usedPercent`, `budgetPercent` (`40`), `turns`, `compactions`, cumulative `cost`, `cacheHitPercent` across the last 8 provider turns (`RECENT_TURNS = 8`, computed as `cache_read / (input + cache_read + cache_write)`), `secondsSinceLastRequest`, and cache state against a 300-second lifetime (`warm` under 240 s, `expiring` at 240–299 s, `cold` at 300+ s). |
| `session_checkpoint` | Validates and renders an agent-written handoff (`objective`, `importantDetails`, `completed`, `active`, `blocked`, `nextMoves`, `relevantFiles`, `durableMemories`) into the required compaction summary template (`SessionContextManagement.renderHandoff`). Refuses when known occupancy is below 10% (`MIN_CHECKPOINT = 0.1`) or `nextMoves` has no non-empty step. The runner commits the checkpoint at the next provider-turn boundary via `SessionCompaction.compactWithHandoff` after applying `SecretOutput` disclosure protection, without making a summarizer model call. |
| `session_recall` | Searches the Session's full durable event history (including messages behind earlier compaction checkpoints) via `SessionReplay.searchSession` (`limit` 1–30, default 10) or reads a window of durable events around a sequence number via `SessionReplay.session` (`before` 0–50, default 5; `after` 0–50, default 15). Output is masked through `SecretOutput`. |

## Read-time pruning

When `SessionCompaction.needsPruning` (`occupancy >= contextTarget(context)`) holds before a provider turn, the runner calls `compaction.prune` (`packages/core/src/session/compaction.ts`) and saves a new rendered request frame with reason `"pressure"`:

- **Stale tool outputs.** Completed tool outputs older than the newest `keep.turns` user turns (default `2`, ignoring `subagent_board` and `shell_job` internal promotions) and older than the most recent 40,000 tokens of tool output (`PRUNE_PROTECT`) are replaced in the model view with `[Old tool result content cleared]` once total savings reach at least 20,000 tokens (`PRUNE_MINIMUM`). Newly cleared calls publish one `session.next.compaction.pruned` event so the transcript records the durable prune timestamp without deleting the stored output bytes.
- **Protected tools.** `skill`, `subagent`, `wait_agents`, and `tool_search` outputs are never pruned or deduplicated.
- **Duplicate outputs (`dedupOutputs`, default `true`).** Older byte-identical completed results for the same tool name and canonical input are replaced with `[Duplicate tool result cleared; identical output appears later in the conversation]` even inside the `PRUNE_PROTECT` window, without requiring `PRUNE_MINIMUM`.
- **Write inputs (`pruneInputs`, default `true`).** Completed `write`, `edit`, and `apply_patch` calls outside the protected turn window have their large body fields (`content`, `oldString`, `newString`, `patchText`) replaced in the model view with `[Old tool input content cleared]` while preserving file paths.
- **Image attachments (`pruneMedia`, default `true`).** Older user image attachments outside the protected turn window (excluding the newest image attachment in history) are replaced with `[Old attached image cleared: <name>]`.

## Compaction and fact ledger

If the pruned request still exceeds `contextTarget(context)` or the usable input budget (`usableBudget`), or when the provider returns a context-overflow failure, `SessionCompaction` summarizes older history into a `compaction` message (`packages/core/src/session/compaction.ts`):

1. **Tail selection (`select`).** Keeps up to `compaction.keep.tokens` (default `16,000`, clamped to `1..200,000` and bounded by `retainedBudget` and half the context window) and `compaction.keep.turns` (default `2`, clamped to `0..50`), pricing the kept tail at wire token size (`wireTokens`). On automatic compaction (`preserveCurrentTurn: true`), an in-flight turn is kept as structured message rows behind `throughSeq` while its wire tokens fit within `2 * max(keep.tokens, 16,000)` (`PRESERVE_CURRENT_TURN_BUDGET_MULTIPLE`). In a first turn with assistant work, a split can occur above `max(keep.tokens, 16,000)`. Oversized in-flight turns fall back to a token-aligned split and preserve the bounded user prompt (up to 4,000 characters, `PRESERVED_USER_CHARACTERS`) in `recent`.
2. **Serialization and retained-result preservation (`serializeMessage`).** Tool outputs in the summarized head are protected with `SecretOutput` and elided to per-tool character budgets (`TOOL_OUTPUT_BUDGETS`, default 2,000 characters; 8,000 for `wait_agents`; 6,000 for `read`; 4,000 for `bash`, `grep`, `webfetch`, `websearch`, `code_search`). When elision removes the middle notice of a [retained tool result](./retained-results.md), `serializeMessage` appends `[Retained result: <id> (<tool>)]` from `state.structured.retainedResult`.
3. **Prompt fitting and retries (`fitPrompt`).** The summarization prompt is bounded by both the summarizer model's token budget and a 1,000,000-character ceiling (`SUMMARY_PROMPT_MAX_CHARS`). If a provider call fails without a valid summary, compaction halves the prompt budget and retries (`2` retries for automatic compaction, `4` for manual `/compact`, jumping to `SUMMARY_FLOOR_CHARS = 24,000` on the final retry). Every valid summary must contain all 9 `SUMMARY_HEADINGS` with non-empty bullets.
4. **Anchored fact ledger (`extract`, `appendLedger`).** While a valid summary is streaming (once `## Objective` arrives), `SessionCompaction` runs a concurrent extraction call (`LEDGER_OUTPUT_TOKENS = 2_048`) unless `compaction.ledger` is `false`. Extracted bullets (up to 60 lines per segment, `LEDGER_MAX_SEGMENT_LINES`, each up to 240 characters) are deduplicated and appended FIFO to the previous checkpoint's ledger inside a 24,000-character cap (`LEDGER_MAX_CHARS`).
5. **Background preparation (`prepareInBackground`).** When `compaction.background` is `true` (the default) and occupancy reaches 80% of `contextTarget` (`BACKGROUND_TRIGGER`, 32% of a normal window), the runner forks one silent summarization per checkpoint generation. When occupancy later crosses `contextTarget`, `commitBackground` verifies `usable` and commits the prepared checkpoint immediately without blocking on a model call.
6. **Mechanical fallback (`fallbackSummary`).** If all retry attempts fail on an automatic or overflow compaction (or on manual compaction when the history already exceeds the usable budget), compaction commits a structurally valid fallback checkpoint containing a 12,000-character protected head excerpt (`FALLBACK_EXCERPT_CHARS`) and any partial model output (up to 4,000 characters, `FALLBACK_PARTIAL_CHARS`) so the Session can continue.

## Configuration

Configured under `compaction` in `forge.json` / `forge.jsonc` (`packages/core/src/config/compaction.ts`, `packages/core/src/session/compaction.ts`):

| Key | Default | Bounds / effect |
| --- | --- | --- |
| `compaction.auto` | `true` | Run automatic pre-flight compaction; also disabled when `FORGE_DISABLE_AUTOCOMPACT` is truthy. Overflow recovery still runs. |
| `compaction.prune` | `true` | Enable read-time stale tool-output pruning; also disabled when `FORGE_DISABLE_PRUNE` is truthy. |
| `compaction.dedupOutputs` | `true` | Clear older byte-identical tool results for the same tool and input. |
| `compaction.pruneInputs` | `true` | Clear older `write`, `edit`, and `apply_patch` body inputs outside the protected turn window. |
| `compaction.pruneMedia` | `true` | Clear older user image attachments outside the protected turn window. |
| `compaction.ledger` | `true` | Extract and carry the append-only fact ledger on each compaction checkpoint. |
| `compaction.background` | `true` | Prepare silent background checkpoints at 80% of the compaction target. |
| `compaction.buffer` | `20,000` | Reserved output/headroom token buffer, clamped to `1,000..500,000`. |
| `compaction.keep.tokens` | `16,000` | Preserved tail token budget, clamped to `1..200,000` (`compaction.keepTokens` legacy alias). |
| `compaction.keep.turns` | `2` | Maximum whole user turns kept in the tail and protected from pruning, clamped to `0..50`. |

## Verification

Run from `packages/core`:

```sh
bun test test/session-compaction.test.ts test/session-context-management.test.ts test/session-context-request.test.ts test/simulator/context-accounting.test.ts
```

## Source

- [`packages/core/src/session/compaction.ts`](../../packages/core/src/session/compaction.ts)
- [`packages/core/src/session/context-management.ts`](../../packages/core/src/session/context-management.ts)
- [`packages/core/src/session/context-request.ts`](../../packages/core/src/session/context-request.ts)
- [`packages/core/src/session/context-epoch.ts`](../../packages/core/src/session/context-epoch.ts)
- [`packages/core/src/tool/context.ts`](../../packages/core/src/tool/context.ts)
- [`packages/core/src/tool/recall.ts`](../../packages/core/src/tool/recall.ts)
- [`packages/core/src/session/runner/llm.ts`](../../packages/core/src/session/runner/llm.ts)
- Contract: [`specs/v2/session.md`](../../specs/v2/session.md)
