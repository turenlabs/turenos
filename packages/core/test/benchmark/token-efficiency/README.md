# Token-efficiency benchmark

Measures how many tokens TurenOS, Claude Code and Codex each spend to do the same
small tasks against the same fixture repo, and scores whether they actually got
the answer right.

This is measurement infrastructure. It is designed so a number in
`results/*.json` can always be traced back to a raw reading from a real CLI. If
a harness cannot run, or a verifier fails, the row is recorded as a failure —
never dropped, never estimated.

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

### Fixture (`fixture/`)

A six-file TypeScript project, checked in, deterministic. Task answers are
pinned to literals in it: `MAX_RETRY_ATTEMPTS = 4271`, `REQUEST_TIMEOUT_MS =
3000`, the class `TenantStore`, the codename `Bramblewick`, and the symbol
`normalizeTenantId` which appears in exactly three of the six files.
`src/metrics.ts` is a deliberate negative control — it must _not_ appear in the
symbol-search answer.

**If you edit the fixture you must edit `src/tasks.ts`.** A verifier that passes
for the wrong reason is worse than no benchmark.

Each run gets a fresh copy of the fixture in a scratch directory **outside this
repo**, `git init`-ed and committed. This matters: run in place, and every
harness walks up and discovers the real forge repo's git root, `AGENTS.md` and
config, silently contaminating the measurement.

### Tasks (`src/tasks.ts`)

| id             | shape                                   | isolates                                        |
| -------------- | --------------------------------------- | ----------------------------------------------- |
| `trivial`      | one-file constant lookup                | fixed overhead — the floor before any real work |
| `search`       | cross-file symbol search                | tool-output cost                                |
| `edit`         | change a constant, verified **on disk** | write-path cost                                 |
| `conversation` | 5 turns in one session                  | context growth per turn                         |

The `edit` verifier reads the workspace file rather than trusting what the model
says it did, and also checks a neighbouring constant was not collaterally
changed.

### Metrics (`src/types.ts`)

The three harnesses report usage in incompatible shapes, and the normalisation
is the load-bearing part of this benchmark:

- **Anthropic-shaped** (Claude Code, TurenOS via `claude-code`): `input_tokens`
  _excludes_ cache. Context read = `input + cache_read + cache_creation`.
- **OpenAI-shaped** (Codex): `input_tokens` _includes_ the cached portion, with
  `cached_input_tokens` a subset of it. Context read = `input_tokens`.

Everything is normalised to `contextTokens = inputTokens + cacheReadTokens +
cacheWriteTokens` — "how many prompt tokens did the model have to be shown".
That is the only figure that is apples-to-apples across all three.

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

### Fair pairing

Comparing across providers confounds model with harness, so arms are paired to
hold the underlying model fixed:

- `anthropic-haiku`: **claude-code** vs **turen-claude-code** — both drive
  Claude Haiku 4.5 through the same local Claude Code subscription, so the delta
  is purely harness overhead. This is the meaningful comparison.
- `openai-codex`: **codex** vs **turen-openai** — same intent on the OpenAI
  side.

Cheapest capable models are used: Haiku 4.5 on the Anthropic side; on the Codex
side this account is restricted by OpenAI to `gpt-5.6-sol` (every mini-tier id
was rejected with "not supported when using Codex with a ChatGPT account"), with
reasoning effort pinned to `low` rather than inherited from
`~/.codex/config.toml`.

### Isolation

TurenOS runs against a scratch database under the scratch root, with a throwaway
secret-vault key minted per benchmark process. `assertSafeForgeDb` in
`src/workspace.ts` hard-fails if `FORGE_DB` would ever resolve inside the user's
real forge data directory.

Both external harnesses are run with their machine-local configuration disabled
(`--setting-sources ""` for Claude Code, `--ignore-user-config` for Codex) so
results do not depend on whose laptop it is.

## Cost

Claude Code and Codex bill against subscriptions here, so the real marginal
dollar cost is zero and the true budget is rate limit. `modeledCostUsd` applies
a published price table (`src/pricing.ts`) purely to put a comparable weight on
input vs cached vs output tokens — it is not "what this run cost".
`gpt-5.6-sol` is deliberately unpriced (no published list price), and reports
`null` rather than an invented number.
