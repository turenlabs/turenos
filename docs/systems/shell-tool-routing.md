# Shell tool routing

TurenOS exposes specialized tools for workspace discovery, content search, and file mutation. The `bash` tool remains the
right boundary for tests, builds, Git, package managers, compilers, and other terminal programs. It is not the normal
boundary for searching or editing the workspace.

Model-facing descriptions express that distinction, but prompt text alone is probabilistic. `ShellToolRouting` therefore
recognizes a deliberately narrow set of high-confidence shell commands that have a specialized equivalent and rejects
them before shell permission or process execution.

The implementation is shared by both session stacks:

- `packages/core/src/shell-tool-routing.ts` contains classification and retry messages.
- `packages/core/src/tool/bash.ts` applies it to the V2 `bash` tool.
- `packages/forge/src/tool/shell.ts` applies it to the legacy TurenOS shell tool.

This is routing policy, not a sandbox. Read [Dangerous commands](./dangerous-commands/README.md) for the separate recursive-delete
guard and the authority retained by commands that are allowed to execute.

## Decision Boundary

```text
shell command
    |
    +--> dangerous recursive deletion
    |       -> hard failure from ShellSafety
    |
    +--> high-confidence workspace search
    |       -> retry with grep or glob
    |
    +--> high-confidence workspace mutation
    |       -> retry with edit or apply_patch
    |
    +--> normal terminal operation
            -> continue to permission and execution
```

Routing happens before the shell permission request and before process creation. A rejected command cannot be approved
through the shell permission dialog because TurenOS has already identified a safer, structured boundary for the operation.

## Routed Commands

The current policy recognizes these command families:

| Shell command shape                                                                                  | Specialized tool                                                |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `rg` content search                                                                                  | `grep`                                                          |
| `rg --files`                                                                                         | `glob`                                                          |
| file-targeted or recursive `grep`                                                                    | `grep`                                                          |
| `git grep`                                                                                           | `grep`                                                          |
| non-destructive `find` file discovery                                                                | `glob`                                                          |
| `sed -i` or `perl -pi`                                                                               | `edit` or `apply_patch`, according to the visible mutation tool |
| shell `apply_patch`                                                                                  | `apply_patch` or `edit`, according to the visible mutation tool |
| workspace writes through `echo`, `printf`, `cat`, `tee`, `Set-Content`, `Add-Content`, or `Out-File` | `edit` or `apply_patch`, according to the visible mutation tool |

The legacy registry does not advertise `edit` and `apply_patch` together. GPT models selected for patch editing receive
`apply_patch`; other models receive `edit` and `write`. Before returning an error, the legacy shell integration maps a
mutation recommendation to the tool actually visible to that model so it never instructs the agent to call an absent
tool.

## Commands Left to Bash

The classifier intentionally allows cases where the specialized workspace tools are not equivalent:

- filtering process output, such as `git diff | grep SessionRunner`;
- output transforms such as `git diff | sed -n '1,80p'`;
- test and build output redirection, such as `bun test > test-results.log`;
- file searches rooted outside the active workspace, such as `rg error /tmp/build.log`;
- writes to external paths and special streams such as `/tmp/output`, `/dev/null`, and stderr `>&2`;
- informational commands such as `rg --version` and `grep --version`;
- destructive or executable `find` forms, which do not have the same semantics as `glob`.

External searches stay in Bash because the `grep` tool is scoped to the active Location or managed tool-output files. A
redirect to a build log also stays in Bash because `edit` and `apply_patch` are workspace mutation tools, not general
process-output sinks.

## Parsing

Bash and PowerShell reuse the tree-sitter parse already produced for shell safety. The router examines command nodes in
document order, accounts for common wrappers such as `command` and `env`, distinguishes a pipeline consumer from a
workspace search, and inspects file redirects separately from descriptor duplication.

`cmd.exe` uses a smaller lexical classifier because there is no tree-sitter grammar in this runtime. It covers direct
`rg`, `git grep`, `find`, and simple `echo`/`type` redirects. Complex batch syntax is allowed rather than guessed at.

Search argument parsing consumes common value-taking options before identifying path operands. This matters for commands
such as `rg -m 1 error /tmp/build.log`: `1` is the value of `-m`, not a workspace path.

## Model Guidance

Runtime enforcement is paired with tool descriptions that make the preferred boundary clear before a mistake occurs:

```text
glob         find workspace files by name or pattern
grep         search workspace file contents
edit         replace exact text in one existing file
apply_patch  coordinate workspace additions, deletions, and updates
bash         run tests, builds, Git, package managers, compilers, and terminal programs
```

The legacy `grep` prompt previously recommended Bash with `rg` for match counting. That exception was removed because it
taught the model to cross the same boundary the runtime now enforces.

## Benchmark

The deterministic benchmark lives at:

```text
packages/core/test/benchmark/tool-routing.ts
packages/core/test/fixtures/tool-routing.json
```

Run it from the Core package:

```bash
cd packages/core
bun run bench:tool-routing
```

The fixture currently covers routed and allowed commands across Bash, PowerShell, and `cmd.exe`, including adversarial
negatives for process pipelines, stderr duplication, external absolute and relative paths, value-taking search options,
and build-output redirects. It reports exact-class accuracy plus routing precision and recall.

The baseline intentionally models the previous runtime behavior: every command outside the recursive-delete guard was
allowed to reach Bash. It is useful for measuring deterministic policy coverage, but it is **not** an end-to-end model
evaluation. A perfect score means the implementation agrees with this reviewed command corpus. It does not establish
that a provider model will always choose the correct tool, complete the task, or recover in one turn.

Add both positive and adversarial allowed cases when extending the classifier. Precision is more important than broad
coverage: a missed route still reaches the existing shell permission boundary, while a false positive can prevent a
legitimate terminal operation.

## Verification

Run the focused suites from their package directories:

```bash
cd packages/core
bun run bench:tool-routing
bun test test/shell-tool-routing.test.ts test/tool-bash.test.ts test/shell-safety.test.ts
bun typecheck

cd ../forge
bun test test/tool/shell.test.ts
```

`packages/core/test/shell-tool-routing.test.ts` replays the benchmark corpus as regression tests. The Bash integration
tests separately prove that a routed command stops before permission and process execution.

## Limits

- The policy recognizes high-confidence command shapes, not arbitrary scripts or interpreters.
- It does not rewrite commands or execute a specialized tool automatically. It returns an actionable error and lets the
  model make the typed retry.
- It does not replace permissions. Commands that are not routed still proceed through normal Bash permission handling.
- It does not make Bash safe. An allowed process retains the host user's filesystem, process, and network authority.
- It is not a live provider benchmark. Changes to prompts and schemas still require task-level evaluation to measure
  first-call tool choice, argument accuracy, recovery turns, completion rate, latency, and token cost.

## Source

- [`packages/core/src/shell-tool-routing.ts`](../../packages/core/src/shell-tool-routing.ts)
- [`packages/core/src/tool/bash.ts`](../../packages/core/src/tool/bash.ts)
- [`packages/forge/src/tool/shell.ts`](../../packages/forge/src/tool/shell.ts)
- Tests: [`packages/core/test/shell-tool-routing.test.ts`](../../packages/core/test/shell-tool-routing.test.ts)
