# TurenOS Quality Gate

TurenOS's quality gate is a small, deterministic check inside the agent tool loop. It looks only at code the agent is
changing and nudges the agent when a patch introduces a strong signal of unfinished or unnecessarily complex code.

The gate is intentionally an **advisory ratchet**, not a blocker. A flagged edit still happens. The model receives one
short note in the existing tool result and can correct the change on its next turn.

```text
Applied patch sequentially:
M src/provider.ts
Quality ratchet: complete or remove the new placeholder implementation.
```

Healthy edits receive no note. The user sees no additional workflow, TurenOS makes no additional model call, and the
turn spends no additional output tokens on the gate.

## Why It Exists

Coding agents tend to extend the same implementation repeatedly. A locally reasonable branch, wrapper, or placeholder
can become structural debt after several feature turns. Correctness tests often continue to pass while the code becomes
larger and harder to change.

The gate targets a narrow set of high-signal mutations:

- executable placeholder implementations;
- several newly empty named functions or methods;
- substantial duplicated additions;
- concentrated growth in branches and control flow.

It does not attempt to grade general code quality or redesign working code. Existing complexity is outside its scope;
the ratchet responds only to the current mutation.

## Loop Integration

The built-in `complexity-ratchet` plugin registers one Location-scoped `tool.execute.after` callback. The callback runs
at the normal tool settlement boundary after successful `edit`, `write`, and `apply_patch` calls.

```text
model requests mutation
        |
        v
tool validates and applies mutation
        |
        v
quality gate scores changed text
        |
        +-- score < 8: no action
        |
        `-- score >= 8: append one short advisory note
```

There is no review agent, provider request, repository scan, Tree-sitter service, or language server in this path. The
implementation uses the mutation text already present in the tool call and result.

The separate [in-agent code review](../agent-review.md) is an advisory workflow used after a high-risk implementation
handoff when the relevant specialist and subagent tools are available. It uses the original requested outcomes,
changed regions or a bounded diff, and the stock read-only adversarial reviewer; it is not part of the per-tool
quality-ratchet settlement path.

### Claude Code `-p`

Claude Code normally executes tools inside the `claude -p` subprocess, which would bypass TurenOS's settlement boundary.
TurenOS prevents that path:

- all native Claude tools and ambient settings are disabled;
- the current turn's policy-filtered TurenOS tool definitions are exposed through a private turn-scoped loopback MCP
  server;
- each MCP call settles through the same captured `ToolRegistry` generation used by other providers;
- duplicate MCP envelopes from Claude's output stream are suppressed in favor of TurenOS's canonical tool lifecycle;
- the annotated result is returned to Claude inside the same `-p` run before its next model turn.

When the runner disables tools entirely, such as at the configured maximum step, the transport exposes no TurenOS MCP
server and Claude's native tools remain disabled.

See [Claude Code tool routing](../claude-code-tool-routing.md) for the capability, isolation, retry, lifecycle, teardown,
and verification details.

Source:

- [`packages/core/src/plugin/complexity-ratchet.ts`](../../packages/core/src/plugin/complexity-ratchet.ts)
- [`packages/core/src/plugin/internal.ts`](../../packages/core/src/plugin/internal.ts)
- [`packages/core/src/session/runner/claude-code-mcp.ts`](../../packages/core/src/session/runner/claude-code-mcp.ts)
- [`packages/core/src/tool/interceptor.ts`](../../packages/core/src/tool/interceptor.ts)

## Scoring

The advisory threshold is **8 points**.

| Signal                                                              |               Score |
| ------------------------------------------------------------------- | ------------------: |
| At least one executable placeholder                                 |                   8 |
| Empty named function or method                                      | 3 each, capped at 9 |
| At least eight normalized duplicate additions                       |                   8 |
| Net growth of at least 40 nonblank lines                            |                   2 |
| One added run of at least 40 nonblank lines                         |                   2 |
| At least six net new branch lines                                   |                   3 |
| At least ten net new branch lines                                   |        3 additional |
| Branch density of at least 15%, with at least four net new branches |                   2 |

The size signals cannot reach the threshold by themselves. A large branch-free data table, generated declaration, or
straight-line implementation therefore remains silent.

Branch markers include common imperative and pattern-matching constructs such as `if`, `case`, `catch`, `match`,
`when`, loops, `&&`, and `||`. This is deliberately a cross-language lexical signal, not a claim to calculate precise
cyclomatic complexity.

## Lexical Filtering

Before branch and placeholder markers are counted, a bounded lexer blanks common comments, quoted strings, template
strings, Python triple-quoted text, and block comments while preserving line structure. This prevents documentation
such as the following from looking like executable control flow:

```ts
export const help = "if authentication fails, sign in again"
```

The lexer is not a parser. It exists only to remove obvious lexical noise at low cost. When the gate cannot make a
confident assessment, silence is preferred over a warning.

## Tool Behavior

### `edit`

TurenOS compares the exact `oldString` and `newString`. For `replaceAll`, it reads the successful replacement count from
the existing tool result and scales additions, removals, branches, empty bodies, placeholders, and duplication by the
number of replacements.

### `apply_patch`

TurenOS parses the already validated patch input and scores each added file or update hunk. Deleted files do not produce
warnings.

### `write`

A newly created file is scored as an addition. An overwrite has no before image at the interceptor boundary, so TurenOS
checks only unequivocal post-state signals such as executable placeholders and several empty implementations. It does
not infer growth, duplication, or branch deltas for overwrites.

## Cost Controls

- Analysis is synchronous and local; it performs no I/O and makes no model call.
- A change larger than 32,000 UTF-16 characters is skipped.
- Replacement multiplication is capped at 1,000.
- Generated, vendored, distribution, coverage, fixture, snapshot, and migration paths are ignored.
- Documentation, data, lock, source-map, and minified file extensions are ignored.
- Failed and denied tool calls receive no quality note because the settlement boundary does not append notes to errors.
- At most one quality note is appended to a tool result.
- Claude Code mutation routing starts one authenticated loopback MCP server only for a turn that has routed tools.

These choices favor predictable latency and low interruption over exhaustive detection.

## Calibration Harness

The threshold is exercised against a curated fixture corpus rather than selected only by intuition. The current corpus
contains 21 labeled changes across TypeScript, Python, Go, Rust, Java, and C:

- 13 clean changes;
- 8 erosion changes.

Clean cases include small handlers, exhaustive matches, data-heavy files, intentional callbacks, type-only function
signatures, abstract methods, prose containing branch words, documented placeholder text, generated files, and
complexity-removing refactors. Erosion cases include concrete placeholders, repeated empty scaffolding, duplicated
validation, and concentrated branching.

The harness evaluates candidate thresholds from 1 through 16 and requires the configured threshold to be the highest,
quietest threshold among those with maximum F1 on the corpus. At threshold 8, the current fixture set has precision
1.0 and recall 1.0.

This is a small curated calibration corpus, not evidence of production-wide accuracy. New false positives and false
negatives should become fixtures before the scoring policy changes.

Files:

- [`packages/core/test/plugin/complexity-ratchet.test.ts`](../../packages/core/test/plugin/complexity-ratchet.test.ts)
- [`packages/core/test/plugin/fixtures/complexity-ratchet.json`](../../packages/core/test/plugin/fixtures/complexity-ratchet.json)
- [`packages/core/test/session-runner-claude-code-mcp.test.ts`](../../packages/core/test/session-runner-claude-code-mcp.test.ts)

Run the harness from the package directory:

```bash
cd packages/core
bun run test test/plugin/complexity-ratchet.test.ts
bun run typecheck
```

## Live Testing

The safest end-to-end check uses a disposable file and the real mutation tool. Create an obvious placeholder:

```diff
*** Begin Patch
*** Add File: .forge-quality-gate-probe.ts
+export function unfinishedProvider() {
+  throw new Error("not implemented")
+}
*** End Patch
```

The `apply_patch` result should contain:

```text
Quality ratchet: complete or remove the new placeholder implementation.
```

Delete the probe immediately afterward:

```diff
*** Begin Patch
*** Delete File: .forge-quality-gate-probe.ts
*** End Patch
```

The deletion should remain silent. A real complexity-removing refactor should also remain silent and should be followed
by the relevant focused tests and package typecheck.

Because the gate is advisory, never leave a deliberately broken probe in production code. Apply the negative mutation,
observe the note, restore it in the next tool call, and verify the original behavior.

## Known Limits

- The gate does not scan pre-existing code or proactively suggest refactors.
- It does not understand symbols, call graphs, types, macros, or runtime reachability.
- It may miss complexity spread across several individually small edits.
- Changes above the size bound are skipped rather than sampled.
- A partially successful `apply_patch` that ends in an error can leave earlier mutations behind, but after-hook notes are
  not model-visible on error settlements. The normal patch error still reports which operations were applied.
- An intentional concrete placeholder may be flagged. Abstract Python methods marked with nearby `@abstractmethod` are
  exempted, but framework-specific extension conventions are not modeled.

These limits are intentional. The quality gate should remain cheap, quiet, and easy to remove or adjust. If a proposed
rule requires repository-wide indexing, semantic parsing, another model turn, or user configuration, it belongs outside
this loop capability.
