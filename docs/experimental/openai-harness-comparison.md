# OpenAI harness comparison

Status: benchmark, as of 2026-11-23.

TurenOS answered the arithmetic prompt sooner than Codex and distance-cli, while distance-cli showed a reasoning summary first before the TurenOS ChatGPT Codex route added a `reasoning.summary: "auto"` default. On the two-turn coding task, adding `parallel_tool_calls: true` and `reasoning.summary: "auto"` on the ChatGPT Codex route, updating the GPT provider prompt (`gpt.txt`), and scoping `todowrite` and `reflection_state` guidance cut TurenOS session time from 29.27–60.73 s (22 tool calls in 26 requests across 4 turns) to 22.82–23.23 s (9 tool calls in 13 requests across 4 turns), finishing sooner than distance-cli (32.42–38.35 s, 15 tool calls in 19 requests) in both paired repetitions. Both passed every code check; Codex did not pass under the file-tools-only constraint. These are small workload-specific comparisons, not an overall ranking.

## Method

Runs finished on November 24, 2026 UTC. The tested clients were Turen TUI 1.0.52 (Session V2), distance-cli 0.2.0-beta.1 (`39dbafc`), and the installed Codex CLI 0.171.0. All used GPT-6.2 Sol through ChatGPT sign-in without Fast mode. Timings came from client or server events, not from terminal paint. Client startup boundaries differed: the Codex clock started at `turn/start` after its app server and thread were ready; the other clients were timed from command launch, with TurenOS already serving locally.

The single-turn prompts ran in fresh sessions, with interleaved client order and no tool calls. The quick prompt asked for the exact string `cobalt-marker` at low effort. The arithmetic prompt started at `x = 317` and updated `x = (73*x + 97*i + 11) mod 1009` for `i = 1` through `12` at medium effort.

The [coding fixture and grader](./coding-session-benchmark.md) used fresh copies of the same small Git repository. At medium effort, the first turn fixed shipping math; the second resumed the same session to add an optional discount. The prompts allowed file tools but prohibited shell commands, network access, and delegation. The grader checked the actual file after each turn. TurenOS and distance-cli ran in alternating order; Codex ran separately using its app server and a workspace-write sandbox. The bundled benchmark runner reproduces the TurenOS and distance-cli arms; a separate local driver reused its fixture, prompts, and grader for Codex.

## Single-turn results

All 15 replies were correct: `cobalt-marker` on all nine quick turns and `797` on all six arithmetic turns. Times are medians. A dash means no summary delta was observed.

| Workload (runs per client) | Client       | First reasoning summary | First answer text | Turn complete |
| -------------------------- | ------------ | ----------------------: | ----------------: | ------------: |
| Quick reply (3)            | TurenOS      |                       — |            1.82 s |        1.95 s |
| Quick reply (3)            | distance-cli |                       — |            1.59 s |        1.86 s |
| Quick reply (3)            | Codex        |                       — |            2.61 s |        2.77 s |
| Arithmetic (2)             | TurenOS      |                       — |            8.14 s |        8.27 s |
| Arithmetic (2)             | distance-cli |                  1.97 s |           10.20 s |       10.22 s |
| Arithmetic (2)             | Codex        |                       — |            9.57 s |        9.73 s |

On arithmetic, TurenOS reached the answer about two seconds before distance-cli, but distance-cli's reasoning summary arrived about six seconds before the first TurenOS text. TurenOS reported 243 and 270 reasoning tokens on its two arithmetic turns. A missing summary did not mean the model skipped reasoning. distance-cli requested `reasoning.summary: "auto"`; the tested TurenOS route did not set a summary default. The test did not isolate the cost of requesting summaries. Across the five single-turn prompts per client, reported input plus output totaled 76,266 tokens for TurenOS, 43,287 for distance-cli, and 70,670 for Codex, including cached input.

## Coding results

Four grading checkpoints per client, from two sessions of two turns. First activity is the first text, reasoning summary, or tool-call event. First text can be a progress message. Completion time describes when the turn ended, so a failed Codex turn is not a time to a working fix.

### Baseline (before ChatGPT Codex request defaults and prompt/bookkeeping updates)

| Client       | Passed checks | First activity, median | First text, median |  Turn complete, median | Tool calls observed | Requests with usage |
| ------------ | ------------: | ---------------------: | -----------------: | ---------------------: | ------------------: | ------------------: |
| TurenOS      |           4/4 |                 2.23 s |             3.04 s |                22.78 s |                  22 |                  26 |
| distance-cli |           4/4 |                 2.69 s |            13.97 s |                15.78 s |                  12 |                  16 |
| Codex        |           0/4 |                 2.06 s |             2.06 s | 9.25 s (failed grades) |                   0 |                   — |

In the baseline run, TurenOS finished the two sessions in 29.27 s and 60.73 s; distance-cli finished in 31.53 s and 31.57 s. The slower TurenOS session (`ses_d02587ea948b4f1e97ec0ed1d9761ba5`) made 16 tool calls in 18 model requests: six standalone `todowrite` turns, four standalone `reflection_state` turns, and two post-patch `read` calls alongside the four substantive file operations (`read` and `apply_patch` per turn). Three factors drove those extra round trips:

1. `chatGPTOAuth` (`packages/core/src/session/runner/model.ts`) did not set `parallelToolCalls: true` or `reasoningSummary: "auto"`.
2. `gpt-6.2-sol` resolved to `packages/core/src/session/provider-prompt/gpt.txt`, which instructed the model to parallelize only via `multi_tool_use.parallel` (a Chat Completions helper absent from the Responses API) and to emit pre-step and pre-edit commentary updates.
3. `SessionTodoGuidance` (`packages/core/src/session/todo-guidance.ts`) and `Reflection.GUIDANCE` (`packages/core/src/reflection.ts`) did not exempt direct single-file edits or instruct the model to batch bookkeeping calls alongside the next substantive tool call.

### Post-fix paired rerun (with `parallel_tool_calls: true`, `reasoning.summary: "auto"`, updated `gpt.txt`, and scoped bookkeeping guidance)

| Client       | Passed checks | First activity, median | First reasoning summary (Turn 1) | First text, median | Turn complete, median | Session total (Run 1 / Run 2) | Tool calls observed | Requests with usage |
| ------------ | ------------: | ---------------------: | -------------------------------: | -----------------: | --------------------: | ----------------------------: | ------------------: | ------------------: |
| TurenOS      |           4/4 |                 2.30 s |                  10.11–10.67 s   |             9.89 s |               11.41 s |            23.23 s / 22.82 s  |                   9 |                  13 |
| distance-cli |           4/4 |                 2.35 s |                   7.47–8.36 s    |            14.23 s |               16.21 s |            32.42 s / 38.35 s  |                  15 |                  19 |

After the changes, TurenOS completed the two sessions (`ses_f1ebb59243b34d2ea984416f75478724` and `ses_d949021d4bfa4e01b31d2cd51f189787`) in 23.23 s and 22.82 s, compared with 32.42 s and 38.35 s for distance-cli (`0mwuaovgp1h3ayy` and `0mwuapkncos6zib`). TurenOS streamed reasoning summaries on both Turn 1 runs, batched `read("cart.mjs")` and `read("rates.mjs")` in parallel when inspecting both files, made zero standalone `todowrite` or `reflection_state` turns, and avoided redundant post-patch `read` calls.

Codex left the buggy file unchanged in both baseline sessions. A separate diagnostic run reported that it tried to inspect the file with its patch tool and replaced it with an empty directory. It did not recover within the permitted tool set. These runs test file-tools-only coding, not the usual Codex workflow with shell inspection. The diagnostic is excluded from the tables. An extra TurenOS/distance-cli smoke run is also excluded because one TurenOS turn lost part of its live trace, although both clients' code passed the grader.

### Coding token usage

Totals cover the four turns per client in each paired set. Input includes cached tokens. Output includes reasoning tokens; the reasoning column is a breakdown, not an extra charge. These are reported tokens, not billing amounts. TurenOS background title work is excluded. Codex totals come from cumulative app-server usage deltas, not a request count comparable to the other two clients.

| Run set      | Client       |   Input | Cached input | Uncached input | Output | Reasoning (within output) |   Total |
| ------------ | ------------ | ------: | -----------: | -------------: | -----: | ------------------------: | ------: |
| Baseline     | TurenOS      | 345,625 |      283,392 |         62,233 |  2,285 |                       188 | 347,910 |
| Baseline     | distance-cli | 149,079 |       90,880 |         58,199 |  1,460 |   Not reported separately | 150,539 |
| Baseline     | Codex        | 197,921 |      130,816 |         67,105 |    847 |                       288 | 198,768 |
| Post-fix     | TurenOS      | 159,056 |      130,560 |         28,496 |  1,035 |                       162 | 160,091 |
| Post-fix     | distance-cli | 178,574 |      110,720 |         67,854 |  1,677 |   Not reported separately | 180,251 |

In the post-fix rerun, TurenOS total input tokens across the four turns dropped by 54.0% (from 345,625 to 159,056), uncached input tokens dropped by 54.2% (from 62,233 to 28,496, less than half of distance-cli's 67,854 uncached input tokens), and output tokens dropped by 54.7% (from 2,285 to 1,035). On the resumed Turn 2 requests in both TurenOS sessions, 36,608 of 38,047 input tokens were served from the prompt cache (96.2% cache hit rate).

## What to test next

1. **Run a fairer three-way coding baseline.** Allow read-only shell inspection for all three clients, retain the workspace write boundary, and use the same grader. Interleave all three clients, add a longer task, and report time to a passing grade alongside failure rates.
2. **Test multi-file tasks where todo and reflection guidance should activate.** Verify that the scoped `todowrite` and `reflection_state` instructions still trigger and batch cleanly alongside substantive tool calls on multi-phase tasks and ambiguous root-cause debugging.
3. **Measure first feedback separately from final latency.** In distance-cli, test summaries on versus off independently and expose the provider's reasoning-token breakdown where available.

## Limits

- The sample is too small to rank the clients or attribute differences to transport. System prompts, tool schemas, cache hits, and backend load were not controlled.
- A separate loopback replay of TurenOS 1.0.52 measured approximately 0.57–1.13 s to send the first request on a cold server versus 28–32 ms when warm. The first fixture text delta reached the V2 event stream in 3–18 ms. Those are local harness measurements, not OpenAI response or terminal paint times.

## Source

- [Coding benchmark procedure](./coding-session-benchmark.md), [fixture and prompts](../../packages/core/test/benchmark/coding-session/workspace.ts), and [grader](../../packages/core/test/benchmark/coding-session/grade.mjs).
- TurenOS [Session V2 runner](../../packages/core/src/session/runner/llm.ts) and [OpenAI Responses encoder](../../packages/llm/src/protocols/openai-responses.ts).
