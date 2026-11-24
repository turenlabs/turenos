# Coding session benchmark

Status: benchmark, as of 2026-11-23.

This benchmark compares TurenOS and distance-cli on the same two-turn coding task. It measures the time to show progress and to finish, then grades the actual code after each turn. It uses signed-in clients and spends real model requests only when run with `--yes`. See the [OpenAI harness comparison](./openai-harness-comparison.md) for the measured results, including the separate Codex run.

## Method

Each client gets a fresh scratch Git repository. The first turn fixes a shipping calculation; the second resumes the same session and adds an optional discount. Both prompts ask the model to use file tools only. An independent grader checks shipping behavior after each turn and reruns the original cases after the follow-up. Client order reverses on every other repetition.

TurenOS runs through the local Turen TUI agent commands and the server's V2 event stream. distance-cli runs with `stream-json`, no project context, and a scratch effort config. Each client uses its existing ChatGPT sign-in and keeps benchmark sessions in its normal session store. The benchmark does not change either client's saved config.

## Run

Install Bun, Git, `turen-tui`, `distance-cli`, and a Node.js release with filesystem and network permission controls (tested with Node.js 26). Connect a trusted, ChatGPT-signed-in TurenOS server at `127.0.0.1:4096` and sign in to ChatGPT in distance-cli. If the server requires HTTP Basic authentication, supply `FORGE_SERVER_PASSWORD` and, for a custom username, `FORGE_SERVER_USERNAME` in the environment. Use only a server you control; the prompts limit what tools should do, not what the server process can access.

```sh
# Print the plan without submitting any prompts.
bun run packages/core/test/benchmark/coding-session/run.ts

# Two paired repetitions, each repeating both turns on both clients.
bun run packages/core/test/benchmark/coding-session/run.ts --yes --repetitions 2
```

Defaults are `gpt-6.2-sol`, `medium` effort, one repetition, and a 120-second timeout per turn. Override them with `--model`, `--effort`, `--repetitions`, or `--timeout`. The runner prints one JSON record for setup and one per attempted turn. It exits nonzero on a failed turn or grade. It leaves the scratch directory named in the setup record for inspecting the resulting code.

## Read the measurements

- `passed` requires both a completed client turn and an independent passing grade. `elapsedMs` covers subprocess launch through exit, not grading. The first text delta can be a progress message rather than the final answer.
- `incomplete-stream` means the TurenOS client finished but the runner did not receive its final step event. The grader still checks the files, but the runner exits nonzero and the partial event measurements should not be used for comparison.
- `firstTextMs`, `firstReasoningMs`, and `firstToolMs` time the first observed text, reasoning-summary, and tool-call events. Missing fields mean no matching event was observed. These are not terminal paint timings.
- `requestsWithUsage` counts requests that reported usage, not HTTP attempts. `usage.input` includes `usage.cached`; `usage.output` includes reasoning tokens. Do not add `usage.reasoning` to `usage.output` again. Only TurenOS reports the reasoning breakdown here. `toolCalls` counts calls reported by the client.

This is a small, two-turn file-editing exercise, not a ranking across coding workloads. System prompts, tool schemas, and cache hits may differ. TurenOS background title requests are not included in the session's measured step counts.

## Verification

```sh
cd packages/core
bun test test/benchmark/coding-session
```

The tests cover both grading stages, rejected changes to the rates file, and a symlink in place of a source file. They also check usage normalization and waiting for a delayed final event.

## Source

- [Runner](../../packages/core/test/benchmark/coding-session/run.ts)
- [Client adapters](../../packages/core/test/benchmark/coding-session/harness.ts)
- [Grader](../../packages/core/test/benchmark/coding-session/grade.mjs)
