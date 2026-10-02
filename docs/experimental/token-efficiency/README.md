# Token efficiency

Status: benchmark, as of 2026-08-02 (the measurement date below).

In 2026-08-02 benchmark runs, TurenOS's Claude Code provider used fewer context
tokens than Claude Code on four small fixture tasks with the same Haiku model.
The headline TurenOS row comes from a later run than the Claude Code and Codex
rows, after code changes to TurenOS, so its ratios compare runs from before and
after a code change. Each cell is one run, not a general performance or
answer-quality claim. [How the benchmark works](./benchmark.md) covers running it and its design. The
benchmark and raw-run records live in
[`packages/core/test/benchmark/token-efficiency/`](../../../packages/core/test/benchmark/token-efficiency).

## Results

Measured 2026-08-02, one repetition per cell, all verifiers passing. The rows come from two result files in
`packages/core/test/benchmark/token-efficiency/results/`:

- Claude Code and Codex: `2026-08-02T22-57-24-562Z.json`, the full suite.
- TurenOS: `2026-08-02T23-24-48-169Z.json`, a TurenOS-only run made after the prompt changes described in
  [What was changed](#what-was-changed-to-get-here). In the full-suite run, before those changes, TurenOS measured
  17,415 (trivial), 17,107 (search), 18,085 (edit), and 90,113 (conversation).

The metric is **context tokens** — uncached input plus cache reads plus cache
writes, i.e. the prompt tokens the model had to be shown. Output tokens are
reported separately and are not included in this metric.

| harness                                   |    trivial |     search |       edit | 5-turn conversation |
| ----------------------------------------- | ---------: | ---------: | ---------: | ------------------: |
| Claude Code (haiku)                       |     50,581 |     49,798 |     76,866 |             234,092 |
| **TurenOS** (claude-code provider, haiku) | **12,400** | **12,159** | **13,059** |          **65,345** |
| Codex (gpt-5.6-sol)                       |     26,748 |     26,760 |     55,927 |             137,505 |

Against the Claude Code row, the later TurenOS run used **4.1x fewer context
tokens** on the trivial task (50,581 / 12,400) and **3.6x fewer** across the
five-turn conversation (234,092 / 65,345). These ratios compare a TurenOS run
made after a code change with a Claude Code run made before it. Within the
single full-suite run, the ratios are 2.9x (50,581 / 17,415) and 2.6x
(234,092 / 90,113). Both harnesses used the same Haiku model and subscription.

Per-turn growth in the conversation task, as the least-squares slope over the
five per-turn totals: TurenOS 426 tokens/turn, Codex 374, Claude Code 3,323. The
Claude Code slope is not comparable with the others. Its turn 2 was a single
provider request (25,634 tokens) while turns 1, 3, 4, and 5 were two requests
each (50,559 to 53,713), so that one outlier drives the slope. Measured from
turn 1 to turn 5, Claude Code grew about 789 tokens/turn, TurenOS 405, and Codex 375.

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
conversation is 65,345 tokens, of which roughly 62,000 (5 × 12,397) is the same
preamble sent five times and about 3,360 is actual conversation growth.

The decomposition and per-tool costs below describe an earlier bridge
configuration, measured on 2026-08-02 before the prompt changes, when the floor
was 17,442. At that time the bridge gave Claude Code eight native tools. The
current bridge (`packages/core/src/session/runner/claude-code-bridge.ts`) passes
`--tools ""`, so Claude Code exposes no native tools and every tool comes from
the private turn-scoped TurenOS MCP server. It also passes TurenOS's prompt with
`--append-system-prompt-file`, which appends to the CLI's default system prompt.
The floor has not been re-measured with the current bridge.

Decomposition of the floor on the claude-code provider at that time, measured by
`decompose.ts` (which PATH-shims the `claude` binary to capture the real request,
then probes the CLI directly for what a shim cannot observe):

| contributor                                             | tokens | share |
| ------------------------------------------------------- | -----: | ----: |
| Claude Code native tool schemas (8 tools)               |  9,277 | 53.2% |
| Claude Code preset system prompt (removed — see below)  |  6,178 | 35.4% |
| request envelope                                        |    657 |  3.8% |
| TurenOS's own system prompt                             |    478 |  2.7% |
| transcript, tool result, per-turn context (approximate) |   ~850 |  4.9% |

Per-tool marginal cost of those native tools, probed individually: Bash 2,962 ·
Agent 2,462 · Grep 1,057 · Read 688 · WebFetch 492 · Edit 440 · Write 277 · Glob 254.

## What was changed to get here

The trivial-task floor fell from 17,442 (`2026-08-02T23-06-07-266Z.json`) to
12,397 (`2026-08-02T23-26-49-055Z.json`), a 28.9% reduction. Each step below is
the difference between two single TurenOS-only runs on 2026-08-02, not an
averaged estimate.

**Removed the stacked second system prompt (−4,487, 17,442 to 12,955 in
`2026-08-02T23-18-43-074Z.json`).** On the claude-code
provider TurenOS was inheriting Claude Code's `claude_code` preset _underneath_ its
own prompt: a second coding-agent persona telling the model it is Claude Code, to
keep answers under four lines for a terminal TurenOS does not render into, and how
to use TodoWrite, hooks and slash commands that this path disables. TurenOS already
ships a model-family prompt for that job and uses it on every other provider.
This also fixed a latent bug — Claude Code's wire ids are bare aliases (`haiku`),
which matched no prompt-selection rule and silently fell back to the generic
prompt.

**De-duplicated todo guidance (−528, 12,955 to 12,427 in
`2026-08-02T23-20-24-264Z.json`).** The `TodoWrite` block in
`provider-prompt/anthropic.txt` restated guidance for a tool this path does not
advertise.

Removing the preset also removes context: the Claude Code CLI injects git status and memory
paths alongside its preset, so dropping the preset drops those. TurenOS's `<env>`
block still supplies cwd, workspace root, platform, date and is-git-repo — the
same context every other TurenOS provider receives — but not git status.

## Tradeoffs retained

This section describes the earlier bridge configuration measured above. The
current bridge passes `--tools ""`, so none of these native tools is sent and
the tradeoffs below no longer apply as written.

- **The `Agent` native tool (2,462 tokens, ~20% of the 12,397 floor).** Removing
  it would have deleted subagent delegation on the claude-code provider, so it
  was kept as a capability trade rather than cut for efficiency.
- `WebFetch` (492) and `Write` (277) were the same shape at smaller scale.
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
consecutive events roughly triple-counts a multi-turn run: summing the five raw
readings recorded for the five-turn Codex run gives 408,777 instead of 137,505. The runner
differences consecutive readings and keeps `rawUsage` on each turn record.

**Round-trips matter as much as preamble.** In the full-suite run, Claude Code
needed two requests to answer a one-file question and three to make a small
edit, where TurenOS needed one.
A harness that halves its system prompt but doubles its round-trips has not
improved.
