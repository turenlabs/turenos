# Why Long Sessions Get Slower

Investigated October 2, 2026 on branch `worktree-session-slowdown`. Read-only queries against the production `forge.db`, `forge.log` and `forge.log.1`, plus one throwaway timing probe of the frame code (not committed). The first fix, Codex cache-affinity headers, is described under "First Fix" below.

## Conclusion

Per-turn latency grows because **the provider has to read an ever larger prompt, and our cache often fails to cover it.** It is not our local request preparation, and it is not context-frame encode/decode.

1. Time to first provider event grows about 4.6x with request size. Local preparation grows only about 2.8x from a small base.
2. OpenAI prompt caching fails far more often than it should. 30% of OpenAI turns above 100k tokens read **zero** cached tokens, even when the previous turn ended less than five minutes earlier.
3. The failure is model-dependent and has worsened over time. Days with near-zero misses exist (9/26, 9/27), so this is a regression, not a ceiling. The deeper analysis below shows the dominant pattern is **a miss that does not recover**, not independent random misses.
4. Compaction almost never runs, so sessions routinely sit at 400k to 780k tokens. Every turn pays for that.

**How much of the slowdown is the cache?** A minority. Joining each OpenAI turn above 100k tokens to its cache status (cold means under half the prompt was cached), the time from last tool settling to the first content frame is, at p50:

| Context   | Warm  | Cold   | Cold penalty |
| --------- | ----- | ------ | ------------ |
| 100-200k  | 2.8 s | 3.1 s  | +0.3 s       |
| 200-400k  | 4.5 s | 7.4 s  | +2.9 s       |
| 400-600k  | 7.4 s | 11.1 s | +3.7 s       |
| 600k+     | 9.1 s | 14.9 s | +5.8 s       |

Warm turns alone go from 2.8 s to 9.1 s, so **prompt size drives most of the growth even with perfect caching**. Cold turns add roughly 3 to 6 s at large contexts, and about 30% of turns are cold, so the cache costs on the order of 1 to 2 s of an average 9 s turn. It is also most of the cost and tail latency (p90 22 to 24 s cold). The 100 to 200k row suggests a roughly 3 s floor unrelated to size. This interval includes tool-settlement overhead, so absolute values are an upper bound on provider wait.

The cause of the cache failure is still not isolated. See "Deeper Dive" for what was ruled out and what the one decisive next measurement is.

## Scope

37 human-driven top-level sessions (`ses_draft_*`, `ses_handoff_*`), the most recently updated 40 filtered to those prefixes. Automated `ses_loop_*` sessions were excluded because they are short and not representative. 9,250 assistant turns, 9,188 with usage data.

## Evidence

### Where the time goes

Turn timeline from runner phase logs (3,240 turns). Each value is elapsed since the turn began.

| Phase                              | p50 ms | p90 ms | p99 ms |
| ---------------------------------- | ------ | ------ | ------ |
| `provider_request_ready`           | 145    | 442    | 10,200 |
| `provider_request_started`         | 296    | 999    | 19,585 |
| `provider_first_event` (since 0)   | 4,373  | 12,614 | 32,861 |

Preparation is about 0.3 s at the median. The first provider event dominates.

### Growth with request size

| Wire messages | Prep p50 ms | Time to first event p50 ms | p90 ms |
| ------------- | ----------- | -------------------------- | ------ |
| 0 to 50       | 202         | 2,535                      | 6,191  |
| 150 to 300    | 272         | 3,569                      | 5,924  |
| 600 to 1,000  | 358         | 7,839                      | 11,901 |
| 1,000 to 2,000| 572         | 11,672                     | 18,470 |

Gap between a turn's last tool settling and the next assistant message opening, by context size: median 3.1 s under 50k tokens, 9.2 s above 600k (p90 7.9 s to 18.8 s). This gap includes time to first event, so it is mostly provider wait, not harness work.

### Local work is not the bottleneck

Real stored frames, timed with the actual `Frame` schema and digest code (a throwaway Bun script that read the stored frame rows and ran `Schema.decodeSync`, the per-entry digest, `Schema.encodeSync` and `JSON.stringify` on them):

| Frame     | Entries | decode | digest all entries | encode | stringify |
| --------- | ------- | ------ | ------------------ | ------ | --------- |
| 7.2 MB    | 467     | 30 ms  | 19 ms              | 13 ms  | 9 ms      |
| 44.6 MB   | 621     | 12 ms  | 65 ms              | 9 ms   | 41 ms     |

Together well under 200 ms per turn. The earlier memory report flagged these frames as an allocation concern. They are a memory concern, not a latency concern.

### Cache failure

| Context      | Turns | Cache hit | Avg uncached input tokens |
| ------------ | ----- | --------- | ------------------------- |
| under 100k   | 1,220 | 48%       | 29,573                    |
| 100k to 300k | 2,535 | 57%       | 85,646                    |
| 300k to 600k | 4,014 | 62%       | 171,108                   |
| over 600k    | 1,423 | 65%       | 238,804                   |

- Providers other than OpenAI are fine: `opencode-go` 98.9% hit, `claude-code` 100%.
- On hot turns (previous turn under 5 minutes earlier, previous prompt above 100k), 44% missed. About 987M tokens were re-processed against 71M lost to idle expiry. Idle TTL is not the problem.
- Most misses are total: 2,226 turns read 0% cached (813M tokens), 401 read under 25%. Only 817 were partial hits. A whole-prefix miss means the beginning of the prompt changed, the route changed, or the provider did not honor the key. A rewritten middle of history would give partial hits.
- Zero-cache turns come in streaks: 350 turns were the sixth or later in a row. Something persistent is wrong during those stretches.
- Previous-turn `tool_load` is followed by a zero-cache turn 86% of the time (88 samples). That is plausibly a tool-array change and is a real but small contributor.

By model, OpenAI turns above 100k tokens:

| Session model | Period      | Turns | Zero-cache | Hit rate |
| ------------- | ----------- | ----- | ---------- | -------- |
| gpt-6-luna    | before 9/28 | 4,727 | 12%        | 65%      |
| gpt-6-luna    | from 9/28   | 1,011 | 1%         | 69%      |
| gpt-6-sol     | before 9/28 | 2,202 | 24%        | 70%      |
| gpt-6-sol     | from 9/28   | 254   | 47%        | 50%      |
| gpt-6.1-sol   | from 9/28   | 2,009 | 44%        | 46%      |

Daily zero-cache rate: 0% to 1% on 9/26 and 9/27, 37% on both 10/1 and 10/2.

Caveat: `provider_usage` has no per-turn model column. The split uses each session's current model, so sessions that switched models are attributed to the latest one.

### Deeper Dive: What Causes The Misses

All OpenAI turns since 9/5, using the model and variant recorded on each assistant message (not the session's current model, which supersedes the weaker split above).

**Partition of 2,983 zero-cache turns above 100k tokens**, assigned to the first matching cause in this order:

| Cause                                             | Turns | Share | Approx tokens re-read |
| ------------------------------------------------- | ----- | ----- | --------------------- |
| Continuation: the previous turn was also cold     | 1,625 | 54%   | 601M                  |
| Gap of 15 s or more after a warm turn             | 818   | 27%   | 334M                  |
| Unexplained, non-sol model                        | 288   | 10%   | 92M                   |
| Unexplained, sol model                            | 156   | 5%    | 36M                   |
| `tool_load` on the previous turn                  | 78    | 3%    | 35M                   |
| Model or variant switched                         | 18    | 1%    | 8M                    |

Reading it:

- **A cold turn usually stays cold.** After one miss the next turn should normally be warm, because the miss writes the cache. For 54% of misses it was not. Streaks of six or more cold turns in a row occurred 350 times. That is the signature of something persistent, either our prefix changing every turn for a stretch, or provider-side routing that never lands on a warm machine.
- **Warm and unchanged is mostly fine.** With a warm previous turn, same model and variant, gap under 15 s and no `tool_load`, only 6% missed (434 of 7,760). The exceptions: `gpt-6.1-sol` 33% (110 of 334), `gpt-6-sol/xhigh` 29% (36 of 124), `gpt-5.6-luna/max` 10%. `gpt-6-luna` and `gpt-6-astra` default are at 1% to 2%.
- **Gap matters, but not alone.** Misses rise with the gap since the previous request: 4% at 3 to 6 s, about 20% at 12 s or more, 38% after 5 minutes. Within `gpt-6.1-sol`, though, the rate is 27% to 48% at every gap size, so gap does not explain `sol`.

**Ruled out**

- *Local frame cost.* Under 200 ms per turn (see above).
- *Request rate overflowing one cache key.* OpenAI documents that a single key above roughly 15 requests per minute can spill to other machines. The data goes the other way: 0 to 5% misses at 6 or more requests in the prior minute, 25% at none.
- *Context pressure rewriting the prefix.* Hot-miss rate falls as context grows: 55% at 0 to 200k, 37% at 600k to 800k. Pruning near the limit would do the opposite.
- *Tool churn in general.* Only `tool_load` stands out (86% cold on the next turn) and it accounts for 3% of misses.
- *The 9/28 perf refactors.* Diffs read, behavior-preserving.
- *Session `generation` as evidence of a stable prefix.* I briefly treated generation 1 as proof that no rebuild had happened. It is not: `ses_draft_b6a89151` shows generation 1 across six model and variant switches, so the counter is not cumulative. No conclusion here rests on it.

**Code facts that bound the search** (`packages/llm/src/protocols/openai-responses.ts`, `packages/core/src/session/runner/llm.ts`):

- The cache key is the session ID (`llm.ts:921`) and goes out as `prompt_cache_key` (`openai-responses.ts:512`). All models route through the same Codex endpoint (`openai-codex.ts:5`), so route is not what separates `sol` from `luna`.
- The pinned prefix comes from the stored frame (`llm.ts:1046`). Runtime instructions are inserted before the newest user message and notes are appended at the end, so both sit after the pinned prefix. By construction the front of the request should not change turn to turn.
- Models in `openai.ts:281-286` get `include: ["reasoning.encrypted_content"]`. When `store` is not false, reasoning is replayed as `item_reference` (`openai-responses.ts:429-433`), which depends on the provider retaining those items. When `store` is false the encrypted items are replayed inline, and any reasoning item without encrypted content is silently dropped (`:489-493`). Either path changes request bytes between turns for reasoning-heavy models. I have not verified which path `sol` takes or whether a dropped item shifts the prefix.

**What this leaves open.** Two explanations fit and the data cannot separate them: (a) our request bytes differ near the front during cold streaks, most plausibly through reasoning replay differences that depend on the model; (b) the provider does not retain or route the cache reliably for `sol`. Only a per-turn prefix hash separates them. If consecutive cold turns have the same hash, it is provider-side and the remedy is model choice, smaller prompts and a support report. If the hash changes, the field that changed is the bug.

### How Codex CLI Handles This (from `openai/codex` source)

Read from GitHub, not from the locally installed binary. Paths are under `codex-rs/`.

| Concern             | Codex                                                                                                                                                                                             | Us                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cache key           | Root session ID; subagents and internal sessions use `{source}:{parent_thread_id}` (`core/src/client.rs:580-592`)                                                                                 | Session ID, subagents get their own (`llm.ts:921`)                                                  |
| Cache affinity      | Also sends the same value as the Responses **session-id header**. Source comment: "ChatGPT derives cache affinity from the Responses session-id header" (`client.rs:594-602`, `build_session_headers`) | `openai-codex.ts:73-76` sets only `authorization` and `ChatGPT-Account-Id`. I found no session header |
| Sticky routing      | Captures `x-codex-turn-state` from the first response of a turn and replays it on every request in that turn (`client.rs:285-305`)                                                                | None                                                                                                |
| Other routing hints | `x-codex-window-id`, `x-codex-routing-hint`, `x-codex-installation-id`, `x-client-request-id`                                                                                                      | None                                                                                                |
| Transport           | Persistent Responses WebSocket reused across requests; **incremental** requests with `previous_response_id` when the new request extends the last one; prewarm request at start                   | Plain HTTP `openai-responses` (2,818 log hits, no WebSocket). Our WebSocket route exists but core never selects it. No `previous_response_id` anywhere |
| Compaction          | Auto at the lower of the configured limit and **90% of the context window** (`protocol/src/openai_models.rs:526-537`), plus an optional post-turn percent threshold and remote compaction (`compact_remote_v2.rs`) | Near the model limit; 3 compactions in 19,026 messages                                              |

What this suggests, and its limits:

- Codex treats cache affinity as something the **client must supply and keep stable**, using a header, a per-turn sticky token and a long-lived connection. Our requests carry none of that. That matches our symptom, which is cold streaks that do not recover. It is a strong lead, not proof: I have not sent a request with the headers, and I do not know which auth path (ChatGPT backend or API key) each of these sessions used. The headers matter for the ChatGPT backend; an API-key path may behave differently.
- Incremental WebSocket requests would also reduce the cost of a large prompt, because only new items travel. They do not remove the provider's work if the cache is cold, so they complement the cache fix and do not replace compaction.
- Codex's 90% default is not a model for earlier compaction. It compacts late too, so it does not support or contradict recommendation 6.

### Case Study: "Bun Server Migration" (`ses_handoff_212d1cdd…`)

One session, 342 provider turns, all `gpt-6.1-sol`, 96 user-role messages, 16 subagent children, about 9.9 hours of wall time across several resumptions. Per `provider_usage`: 75.0M input tokens, 28.0M cached (37%), 47.0M uncached, $178.5 (the session row shows $158.0 and slightly lower token totals; I use the usage rows throughout).

| Turns   | Median ctx | Weighted cache hit | Cold turns | Settle to first frame p50 | Cost per window |
| ------- | ---------- | ------------------ | ---------- | ------------------------- | --------------- |
| 0-24    | 60k        | 12%                | 24 of 25   | 4.3 s                     | $2.4            |
| 100-124 | 154k       | 62%                | 8          | 5.0 s                     | $3.2            |
| 200-224 | 263k       | 36%                | 16         | 7.6 s                     | $17.3           |
| 300-324 | 402k       | 32%                | 16         | 9.6 s                     | $27.8           |
| 325-341 | 429k       | 35%                | 10         | 10.0 s                    | $19.7 (17 turns)|

- Cost per 25 turns grows about 11x while context grows about 7x. The cache is best around 100-150k and degrades as context grows. Across the session 199 of 342 turns (58%) were cold, nearly double the 30% fleet rate, consistent with `sol` being the weak model for caching. The first 25 turns were almost entirely cold even though the prompt was small.
- Compaction did not run. Context climbed from 60k to 429k.
- Only 19 of 96 user-role messages are human or agent-written prompts. 42 are shell-job observations, 18 subagent-finished notices and 17 swarm-room posts. Attributing each turn to the most recent such message, 42% of turns and 54% of cost follow a shell-job observation, and 88% of cost follows a machine-injected message. **That attribution is not causation.** These messages are how a waiting agent gets woken, and the model's first turn after one was real work (patches, bash, reads) in nearly every case: zero text-only acknowledgement turns after shell, subagent or room messages, and only 2 to 4 wait-only turns per type. So the injected messages are not producing wasted acknowledgement turns here.
- The 16 children cost about $16 combined against $178 for the parent. Subagents are not the cost problem; one long-lived parent at 250k to 430k tokens is.
- Cold rate is about 55% to 61% for every trigger type, so no injection type is itself busting the cache.

Takeaway for this session: the expense and slowness are turn count times context size times cold rate, with context unmanaged. Splitting the work into fresh sessions at the 07:47, 12:14 and 17:39 resumptions, or compacting at roughly 150k, would have kept most turns in the cheap 100-150k band where the cache works.

### Compaction barely happens

Since 9/20: 19,026 assistant messages and only 3 compaction messages. 42% of turns run above 400k tokens and 15% above 600k. Of the 20 largest frames, "pressure" was the last rebuild reason in one. "configuration" was the reason in 11.

### Complexity signals

13,723 tool calls over 9,250 turns (1.5 per turn). Calls that exist only to manage the harness rather than the user's task:

| Group                                                    | Calls |
| -------------------------------------------------------- | ----- |
| `todowrite`                                              | 1,050 |
| `reflection_state`, `reflection_read`, `reflection_complete` | 758 |
| `room_read`, `room_post`                                 | 393   |
| `spawn_agent`, `send_agent`, `wait_agents`               | 563   |
| `tool_load`, `tool_search`                               | 155   |
| Total                                                    | 2,919 (21%) |

Every request carries 40 tool definitions. Each of those calls is a full provider turn at the session's current context size, so at 500k tokens a 2-second bookkeeping call is paid for with a very large prompt.

## Recommendations

Ordered by expected payoff.

1. **Add the prefix-hash telemetry first.** It is the one measurement that decides everything else. Per OpenAI turn, log a hash of the request in cumulative chunks (system plus tools, then the first 25, 100 and 400 input items), next to `tokens_cache_read`, model, variant, `store`, and the response request ID. Cold streak with an unchanged hash means provider-side. A changed hash names the field. A few hours of normal use is enough, and nothing is logged beyond hashes and counts.
2. **Break cold streaks.** 54% of misses were continuations. Whatever the cause, a fallback is cheap to try: after two consecutive zero-cache turns above 100k tokens, rotate the `prompt_cache_key` (for example append a counter) so the next request is not pinned to whatever routing is failing. Measure whether the following turn is warm. If it is, that is also diagnostic.
3. **Prefer models that cache.** On warm, unchanged turns `gpt-6-luna` and default `gpt-6-astra` miss 1% to 2%, `gpt-6.1-sol` 33%. For long sessions this is worth more than the model's speed advantage. At minimum, surface the live hit rate to the user per session.
4. **Do not switch model or variant mid-session on large contexts.** Each switch is a guaranteed full miss. It is a small share of misses (1%) but it costs the most per event.
5. **Tool discovery.** `tool_load` precedes 3% of misses and a 86% cold next turn. Low priority; if cheap, load tools additively after the cached prefix.
6. **Compact earlier and on purpose.** Choose a target well below the model limit, for example 200k to 250k tokens, and compact at a quiet boundary. One planned cache miss beats a persistent 400k to 780k prompt paying time-to-first-event on every turn, and it shrinks the cost of every cold streak too. Measure on a few real sessions before picking the number.
7. **Make cache health visible.** Besides the hashes in item 1, record the hit rate per turn in the sidecar log. This report had to be reverse-engineered from two tables and a log; a query should answer "is caching healthy today" directly.
8. **Cut harness turns.** Fold `todowrite` and `reflection_state` into the assistant's normal output or batch them with the next real tool call. Each currently costs a full turn at full context. Consider removing the reflection tool trio from default sessions and measuring whether quality changes. Shrink the 40-tool default set at the same time.
9. **Lower priority: frame memory.** Frames and request assembly are cheap in time. The memory concern in the earlier report stands, but it does not belong in a latency fix.

## What this does not establish

- The cause of the cache failures. The partition shows they are mostly sticky cold streaks, and `sol` models stay unstable even when warm. Whether that is our request bytes or the provider is untested until prefix hashes exist.
- Whether the 9/28 perf refactors (`e6e70546`, `66ee9ad8`) matter. Both diffs were read and look behavior-preserving. The timing coincidence is not evidence.
- The effect of compaction on quality. Recommendation 3 needs a real before and after.
- Any claim about non-OpenAI providers beyond the small samples above (181 and 12 turns).
- Dollar figures. Token counts are reported, not priced.

## Reproducing

Scratchpad scripts (not committed): `analyze2.py`, `ttfb.py`, `cachebust.py`, `bustshape.py`, `zerocause.py`, `phases.py`. All open `forge.db` with `mode=ro`. The frame timing probe was not kept; it only wrapped the schema calls named above.

## First Fix: Codex Cache-Affinity Headers

Finding that motivated it: the v1 plugin already sent `session-id` (`packages/forge/src/plugin/openai/codex.ts:493`) and kept a WebSocket pool keyed on it. The V2 runner's ChatGPT OAuth route (`packages/core/src/session/runner/model.ts`) sent only `authorization` and `ChatGPT-Account-Id`. These sessions run on V2, so this looks like a regression, and it matches the cold streaks. It is still a hypothesis until the cold-streak rate is re-measured with the fix.

What changed:

- `openai-codex.ts`: `affinityHeaders(request)` builds `originator`, `session-id`, `thread-id`, `x-client-request-id` and `x-codex-window-id` from the request's `promptCacheKey`, the same value sent as `prompt_cache_key`. Header names are from the Codex source (`codex-api/src/requests/headers.rs`, `core/src/client.rs`, `core/src/responses_metadata.rs`). Requests with no cache key (title generation, compaction) get none.
- `model.ts`: the ChatGPT OAuth route composes it after the bearer headers through `Auth.custom`. API-key requests are untouched.
- `llm.ts`: passes the compaction count as `request.metadata["forge.contextWindow"]` so the window ID advances at each compaction.
- Test: `provider-openai.test.ts` asserts the headers appear with a key, window defaults to 0, none appear without a key, and none appear on the API-key route.

Other providers (same PR):

- The v1 runtime sent `x-session-affinity`, `X-Session-Id` and `x-parent-session-id` to every non-opencode provider, and `x-opencode-session` to opencode ones. V2 kept only the opencode header (`model.ts:1166`) and dropped the rest. `session/runner/cache-affinity.ts` restores them, plus xAI's documented `x-grok-conv-id` (host-matched on `api.x.ai`).
- OpenRouter's own `promptCacheKey` option was never set by the runner, so it had no body key either. The runner now sets it, and OpenRouter also gets `x-session-id`, its explicit sticky-routing key.
- The compaction cap is provider-agnostic: it keys off the model's declared context limit. It reaches the Claude Code bridge too (its catalog limit is 1M for Opus), and the Claude Code limits test now pins that.
- opencode and opencode-go get nothing extra, since their route already carries `x-opencode-session`. The data agrees they did not need it: `opencode-go` had a 98.9% hit rate over 181 turns.
- Body `prompt_cache_key` for providers on the OpenAI Chat protocol: v1 sent one to opencode and Venice (and to any provider with `setCacheKey`), and V2's chat protocol never emitted it. Now `ModelCompatibility.promptCacheKey` (opt-in, `packages/llm`) makes the chat protocol emit it, `sendsPromptCacheKey` in `model.ts` turns it on for exactly the v1 set, and the runner also passes the key under the provider's own namespace so the AI SDK bridge hands it to bridged packages. It is opt-in because many OpenAI-compatible servers reject unknown fields. Tested through the native compatible-chat route; the Venice bridge path is covered by the flag and typecheck but not by a live call.
- Claude Code and Muse use a local CLI, so request headers and body keys do not apply to them.

Not sent, deliberately: `x-codex-installation-id` (a stable per-install identifier sent to a third party), turn metadata, routing hint and the subagent marker (attribution, not affinity).

Not done yet: **`x-codex-turn-state`**. The Codex client learns it from a response header at the start of a turn and replays it unchanged for every request in that turn, and must not send it across turns. `packages/llm` does not expose response headers to callers, so this needs a small hook in the HTTP transport and a turn-scoped holder in the runner. It is the other half of affinity and should follow if the stateless headers do not move the cold-streak rate.

How to measure it: the same queries as above (`cachebust.py`, the partition script) on turns after the fix ships. Compare the share of zero-cache turns above 100k tokens and the continuation share (54% before) on `sol` models.
