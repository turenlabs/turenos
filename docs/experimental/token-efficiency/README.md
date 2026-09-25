# Token efficiency

Status: benchmark, as of 2026-08-02 (the measurement date below).

In one 2026-08-02 benchmark run, TurenOS's Claude Code provider used fewer
context tokens than Claude Code on four small fixture tasks with the same Haiku
model. The results are observations from one run per case, not a general
performance or answer-quality claim. [How the benchmark works](./benchmark.md) covers running it and its design. The
benchmark and raw-run records live in
[`packages/core/test/benchmark/token-efficiency/`](../../../packages/core/test/benchmark/token-efficiency).

## Results

Measured 2026-08-02, one repetition per cell, all verifiers passing.

The metric is **context tokens** — uncached input plus cache reads plus cache
writes, i.e. the prompt tokens the model had to be shown. Output tokens are
reported separately and are not included in this metric.

| harness                                   |    trivial |     search |       edit | 5-turn conversation |
| ----------------------------------------- | ---------: | ---------: | ---------: | ------------------: |
| Claude Code (haiku)                       |     50,581 |     49,798 |     76,866 |             234,092 |
| **TurenOS** (claude-code provider, haiku) | **12,400** | **12,159** | **13,059** |          **65,345** |
| Codex (gpt-5.6-sol)                       |     26,748 |     26,760 |     55,927 |             137,505 |

In this run, TurenOS used **4.1x fewer context tokens** than Claude Code on the
trivial task and **3.6x fewer** across the five-turn conversation. Both used the
same Haiku model and subscription.

Per-turn growth in the conversation task: TurenOS 426 tokens/turn, Codex 374,
Claude Code 3,323.

### Comparison scope and limits

- **Paired model:** The TurenOS and Claude Code rows use `claude-haiku-4-5`
  through the same subscription. This removes the model difference between those
  rows, but does not control every runtime or configuration difference.
- **Different Codex model:** Codex used `gpt-5.6-sol`. Its row describes that
  run; differences from the Haiku rows cannot be attributed to harness overhead
  alone.
- **Small sample:** There was one repetition per case. The table does not show
  run-to-run variance, and the deterministic task verifiers check specific
  outcomes rather than overall answer quality.
- **Blocked arm:** The `turen-openai` arm was blocked because the throwaway
  vault key could not decrypt the stored OAuth credential. It needs
  `OPENAI_API_KEY` to run; no result is imputed for it.

## Where the tokens go

The floor — what a single trivial request costs before any real work — dominates
the measured tasks. The five-turn
conversation is 65,345 tokens, of which roughly 62,000 is the same preamble sent
five times and about 1,500 is actual conversation growth.

Decomposition of the floor on the claude-code provider, measured by
`decompose.ts` (which PATH-shims the `claude` binary to capture the real request,
then probes the CLI directly for what a shim cannot observe):

| contributor                                             | tokens | share |
| ------------------------------------------------------- | -----: | ----: |
| Claude Code native tool schemas (8 tools)               |  9,277 | 53.2% |
| Claude Code preset system prompt (removed — see below)  |  6,178 | 35.4% |
| request envelope                                        |    657 |  3.8% |
| TurenOS's own system prompt                             |    478 |  2.7% |
| transcript, tool result, per-turn context (approximate) |   ~850 |  4.9% |

Per-tool marginal cost, probed individually: Bash 2,962 · Agent 2,462 · Grep
1,057 · Read 688 · WebFetch 492 · Edit 440 · Write 277 · Glob 254.

## What was changed to get here

The floor started at 17,442 and is now 12,397, a 28.9% reduction.

**Removed the stacked second system prompt (−4,487).** On the claude-code
provider TurenOS was inheriting Claude Code's `claude_code` preset _underneath_ its
own prompt: a second coding-agent persona telling the model it is Claude Code, to
keep answers under four lines for a terminal TurenOS does not render into, and how
to use TodoWrite, hooks and slash commands that this path disables. TurenOS already
ships a model-family prompt for that job and uses it on every other provider.
This also fixed a latent bug — Claude Code's wire ids are bare aliases (`haiku`),
which matched no prompt-selection rule and silently fell back to the generic
prompt.

**De-duplicated todo guidance (−528).** The `TodoWrite` block in
`provider-prompt/anthropic.txt` restated guidance for a tool this path does not
advertise.

Removing the preset also removes context: the Claude Code CLI injects git status and memory
paths alongside its preset, so dropping the preset drops those. TurenOS's `<env>`
block still supplies cwd, workspace root, platform, date and is-git-repo — the
same context every other TurenOS provider receives — but not git status.

## Tradeoffs retained

- **The `Agent` native tool (2,462 tokens, ~20% of the current floor).** Removing
  it is a one-line change and the single largest remaining win, but it deletes
  subagent delegation on the claude-code provider. Parallel subagents are a core
  workflow, so this is a capability trade rather than an efficiency win.
- `WebFetch` (492) and `Write` (277) are the same shape at smaller scale.
- `ClaudeCodeGuidance.WORKFLOW` (301) partly overlaps the provider prompt's
  tool-usage policy; the PostToolBatch reminder still refers to it.

## Running it

```sh
# Plan and cost estimate. Spends nothing.
bun run packages/core/test/benchmark/token-efficiency/run.ts --dry-run

# Full suite. Spends real money on the configured subscriptions.
bun run packages/core/test/benchmark/token-efficiency/run.ts --yes

# Iterate on one arm cheaply.
bun run packages/core/test/benchmark/token-efficiency/run.ts \
  --harness turen-claude-code --task trivial --yes

# Decompose the floor.
bun run packages/core/test/benchmark/token-efficiency/decompose.ts --per-tool
```

Flags: `--harness`, `--task`, `--repetitions`, `--timeout`, `--out`, `--dry-run`,
`--yes`. The runner refuses to spend without `--yes`. Results are written to
`results/<timestamp>.json` with raw per-run usage retained.

The benchmark points `FORGE_DB` at a scratch database and asserts at runtime that
it never addresses a real one.

## Notes for anyone extending this

**Codex reports cumulative usage per thread, not per turn.** The
`turn.completed` event's `usage` accumulates across the whole thread, so summing
consecutive events triple-counts a multi-turn run — it inflated the five-turn
Codex figure from 137,505 to 408,822 before this was caught. The runner
differences consecutive readings and keeps `rawUsage` on each turn record.

**Round-trips matter as much as preamble.** Claude Code needs two requests to
answer a one-file question and three to make a small edit, where TurenOS needs one.
A harness that halves its system prompt but doubles its round-trips has not
improved.
