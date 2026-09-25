# Token-efficiency benchmark

Status: benchmark, as of 2026-09-25. The [results](./README.md) state their measurement date.

The harness behind the [token-efficiency results](./README.md) runs small fixture tasks through TurenOS, Claude Code,
and Codex. It lives in `packages/core/test/benchmark/token-efficiency/`.

It measures context-token usage on the same small fixture tasks and runs task-specific verifiers against each output.
Those verifiers check the requested literals and file edits, not general answer quality.

Each run records CLI-reported usage and verifier status in
`packages/core/test/benchmark/token-efficiency/results/*.json`. Failed harnesses and verifiers are recorded as failed
runs rather than included in the result comparison. Provider-request counts and the preamble decomposition use estimates
where noted below.

## Running it

```sh
# See the plan and the cost estimate without spending anything
bun run packages/core/test/benchmark/token-efficiency/run.ts --dry-run

# Full suite, 1 repetition (the reported results were produced by this)
bun run packages/core/test/benchmark/token-efficiency/run.ts --yes

# Piecemeal
bun run packages/core/test/benchmark/token-efficiency/run.ts \
  --harness turen-claude-code,claude-code --task trivial,edit --yes

# More samples
bun run packages/core/test/benchmark/token-efficiency/run.ts --repetitions 3 --yes
```

Flags: `--harness`, `--task`, `--repetitions`, `--timeout <sec>`, `--out <dir>`,
`--dry-run`, `--yes`. It refuses to spend tokens without `--yes`.

Output: a summary table on stdout and `results/<timestamp>.json` with every raw
per-run number.

### Prerequisites

- `claude` on PATH and logged in (`claude auth status`)
- `codex` on PATH and logged in
- For the `turen-openai` arm only: `OPENAI_API_KEY` in the environment

### Committing results

`.gitignore` line 41 is a bare `core` pattern (intended for crash dumps) which
also matches the `packages/core` directory, so **every new file under
`packages/core/` is silently gitignored**. Existing tracked files are
unaffected. To commit anything here you need `git add -f`, or the pattern needs
anchoring to `/core`. This is a pre-existing repo-wide issue, not specific to
this benchmark.

## Design

### Fixture (`packages/core/test/benchmark/token-efficiency/fixture/`)

A six-file TypeScript project, checked in, deterministic. Task answers are
pinned to literals in it: `MAX_RETRY_ATTEMPTS = 4271`, `REQUEST_TIMEOUT_MS =
3000`, the class `TenantStore`, the codename `Bramblewick`, and the symbol
`normalizeTenantId` which appears in exactly three of the six files.
`packages/core/test/benchmark/token-efficiency/fixture/src/metrics.ts` is a deliberate negative control — it must _not_ appear in the
symbol-search answer.

**If you edit the fixture you must edit `packages/core/test/benchmark/token-efficiency/src/tasks.ts`.** A verifier that passes
for the wrong reason is worse than no benchmark.

Each run gets a fresh copy of the fixture in a scratch directory **outside this
repo**, `git init`-ed and committed. This matters: run in place, and every
harness walks up and discovers the real forge repo's git root, `AGENTS.md` and
config, silently contaminating the measurement.

### Tasks (`packages/core/test/benchmark/token-efficiency/src/tasks.ts`)

| id             | shape                                   | isolates                                        |
| -------------- | --------------------------------------- | ----------------------------------------------- |
| `trivial`      | one-file constant lookup                | fixed overhead — the floor before any real work |
| `search`       | cross-file symbol search                | tool-output cost                                |
| `edit`         | change a constant, verified **on disk** | write-path cost                                 |
| `conversation` | 5 turns in one session                  | context growth per turn                         |

The `edit` verifier reads the workspace file rather than trusting what the model
says it did, and also checks a neighbouring constant was not collaterally
changed.

### Metrics (`packages/core/test/benchmark/token-efficiency/src/types.ts`)

The three harnesses report usage in incompatible shapes, and the normalisation
is the load-bearing part of this benchmark:

- **Anthropic-shaped** (Claude Code, TurenOS via `claude-code`): `input_tokens`
  _excludes_ cache. Context read = `input + cache_read + cache_creation`.
- **OpenAI-shaped** (Codex): `input_tokens` _includes_ the cached portion, with
  `cached_input_tokens` a subset of it. Context read = `input_tokens`.

Everything is normalised to `contextTokens = inputTokens + cacheReadTokens +
cacheWriteTokens` — "how many prompt tokens did the model have to be shown".
This makes token accounting comparable across harnesses; the Codex and Haiku
rows still use different models.

**Codex reports a running conversation total on every turn, not that turn's
usage.** Verified directly: resuming a thread and sending "Reply with exactly:
TWO" reported `cached_input_tokens` of exactly 19,968 against the previous
turn's 9,984. Summing those readings would have inflated a 5-turn run roughly
threefold. The runner differences consecutive readings and keeps the raw value
in `rawUsage` on every turn record so the correction is auditable.

Provider-request counts are exact for Claude Code (deduped assistant message
ids) and TurenOS (`step_finish` events), and **approximate for Codex**, which
exposes no per-request usage. Approximate counts are marked `~` in the table and
`providerRequestsExact: false` in the JSON.

### Pairing design

Comparing across providers confounds model with harness, so arms are paired to
hold the underlying model fixed:

- `anthropic-haiku`: **claude-code** vs **turen-claude-code** — both drive
  Claude Haiku 4.5 through the same local Claude Code subscription. This removes
  the model difference but does not control every runtime or configuration
  difference.
- `openai-codex`: **codex** vs **turen-openai** — same intent on the OpenAI
  side.

The recorded run used Haiku 4.5 on the Anthropic side; on the Codex
side the benchmark account was restricted to `gpt-5.6-sol` (every mini-tier id
was rejected with "not supported when using Codex with a ChatGPT account"), with
reasoning effort pinned to `low` rather than inherited from
`~/.codex/config.toml`.

### Isolation

TurenOS runs against a scratch database under the scratch root, with a throwaway
secret-vault key minted per benchmark process. `assertSafeForgeDb` in
`packages/core/test/benchmark/token-efficiency/src/workspace.ts` hard-fails if `FORGE_DB` would ever resolve inside the user's
real forge data directory.

Both external harnesses are run with their machine-local configuration disabled
(`--setting-sources ""` for Claude Code, `--ignore-user-config` for Codex) to reduce local-configuration differences.

## Cost

Claude Code and Codex used subscriptions for this run, so `modeledCostUsd` is not a charge incurred by the runner. It applies
a published price table (`packages/core/test/benchmark/token-efficiency/src/pricing.ts`) purely to put a comparable weight on
input vs cached vs output tokens — it is not "what this run cost".
`gpt-5.6-sol` is deliberately unpriced (no published list price), and reports
`null` rather than an invented number.
