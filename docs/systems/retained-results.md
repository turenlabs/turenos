# Retained tool results

Session V2 retains protected large tool captures behind session-scoped opaque IDs. Agents can inspect or compute over
captured evidence without putting the entire result in model context or repeating the source tool. Captures expire;
they are separate from durable project [memory](./memory.md).

## How it works

1. The [tool registry](./tool-registry.md) settles a canonical tool invocation and applies secret output protection.
   `ToolOutputStore` evaluates retention against captured text and structured JSON independently of the initial model
   view. A small custom view can therefore accompany a large retained structured result.
2. A retained capture contains text, optional normalized JSON, tool/call provenance, byte sizes, creation and expiry
   times, capture-loss metadata, and a SHA-256 integrity digest. Its `retainedResult` metadata and model-facing hint
   identify the capture. A capture failure is advisory: the source operation remains completed and the hint reports that
   retention was unavailable. Do not repeat a mutation to recover its output. Secret-protection failures retain their
   existing fail-closed behavior; storage failure does not bypass protection.
3. Result tools use the invocation's trusted Session ID and check current `read` permission for `tool-results` or
   `tool-result:<id>`. Possessing an ID does not grant access to another Session's capture. Cross-session and child-session
   sharing are not implemented.
4. Durable-output bounding and history pruning preserve the reference. `result_list` can rediscover this Session's
   remaining captures after compaction. Reading, searching, and computing never rerun the source invocation; their own
   outputs are excluded from automatic recapture.

Captures contain the output available at settlement after [secret output protection](./secret-output-protection.md).
Exact readback is exact for that protected capture, not for unmasked source files or bytes a producer omitted. The
content remains untrusted data and cannot change the user's instructions, permissions, or execution state.

## Agent tools

The tools are registered by `BuiltInTools.node` for Session V2. `result_list` and `result_read` are inline;
`result_search` and `result_compute` are deferred and can be selected through `tool_search` and `tool_load`.
Task-owned child Sessions include these tools in their basic tool-name policy; each call still checks read permission
and can access only the invoking child Session's captures.

| Tool             | Input and behavior                                                                                                                                                             | Coverage and limits                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result_list`    | Lists this Session's capture metadata; optional `cursor` and `limit`.                                                                                                          | Default 20, maximum 50 results per page. Scans at most 256 directory entries and reports `incomplete`; it is not an exhaustive inventory when that flag is true.                                                          |
| `result_read`    | Reads one `id`, optional `channel`, byte `offset`, and `maxBytes`; defaults to `text`, offset 0, and 8 KiB.                                                                    | Maximum 8 KiB per page. Follow `nextOffset`; when a page splits a UTF-8 sequence, it returns `encoding: "base64"`. Decode each page before concatenating for exact bytes. The structured channel is normalized JSON text. |
| `result_search`  | Finds a literal, case-sensitive `query` in one result; defaults to the text channel and five hit excerpts.                                                                     | Maximum ten excerpts and 10,000 non-overlapping occurrences scanned. `matches` counts occurrences, not rows; `complete` says whether the scan reached the end. No semantic or cross-result search.                        |
| `result_compute` | Runs a confined JavaScript function body over `data` and returns a small JSON answer. Defaults to structured data when available, otherwise text; `channel` can select either. | No filesystem, network, process, imports, host tools, or recursive model calls. Uses the worker limits below.                                                                                                             |

For a structured capture that is an array of records, a `result_compute` request can use:

```json
{
  "id": "<ID from retainedResult or result_list>",
  "channel": "structured",
  "code": "return { failed: data.filter(row => row.failed).length, total: data.length }"
}
```

Use search to locate passages, exact reads to inspect evidence, and computation for exhaustive operations over the
available capture. Even an exhaustive computation cannot establish facts about source data omitted during capture.

## Configuration

The existing `tool_output.max_lines` and `tool_output.max_bytes` settings control the initial generic view and its
capture thresholds; their defaults are 2,000 lines and 50 KiB. Capture retention and computation limits are constants,
not new configuration switches.

Protected capture envelopes live under `Global.data/tool-result/<SHA-256 of Session ID>/`. Each envelope, including
provenance and both channels, is at most 8 MiB and expires after seven days. Managed directories use mode `0700` and
files `0600` where supported. Reads verify scope, expiry, file shape and integrity; malformed, foreign, expired or
missing captures return an unavailable error. Cleanup runs with the existing hourly output sweep and is bounded and
best-effort. Expiry is enforced at read time even when disk deletion has not reached a file.

## Verification

Run from `packages/core`:

```sh
bun test test/tool-result-store.test.ts test/tool-results.test.ts test/result-compute-runtime.test.ts
bun test test/simulator/retained-results.test.ts test/simulator/subagent-tools.test.ts
```

The [research record](../experimental/context-results/README.md) separates the pre-implementation probe from
integration verification. These local checks do not measure model-generated programs, task completion, provider
tokenization or billed-token savings.

## Limits

| Computation bound                           |                                         Value |
| ------------------------------------------- | --------------------------------------------: |
| UTF-8 program source                        |                                        16 KiB |
| Serialized input data                       | 8 MiB, also subject to JSON depth/node checks |
| Computation result/log envelope             |                                         8 KiB |
| Interpreter timeout                         |                                      1,000 ms |
| Independent worker wall deadline            |                                      3,000 ms |
| Concurrent workers per process              |                                             1 |
| Host tool calls                             |                                             0 |
| Cumulative logical allocation budget        |                                       128 MiB |
| Interpreter/allocation traversal operations |                                     1,000,000 |

Allocation and operation limits return `ResourceLimitExceeded`. They are conservative interpreter accounting, not an
RSS guarantee; bounded input can still be rejected because of its shape or the requested transformation. The parent
terminates a worker on completion, failure, unexpected exit, timeout or cancellation before releasing its permit.
Node additionally applies worker heap settings; Bun does not enforce those settings. The restricted interpreter and
empty host tool tree provide capability confinement; a worker thread is not an OS security sandbox.

Retention does not add an aggregate disk quota. Discovery's bounded directory scan can omit captures whose known IDs
remain readable. An unsupported or oversized capture is disclosed instead of being represented as complete. Existing
secret detection limitations still apply, and private file permissions do not isolate storage from a hostile process
running as the same OS user.

## Source

- Capture and expiry: [`packages/core/src/tool-result-store.ts`](../../packages/core/src/tool-result-store.ts), [`tool-output-store.ts`](../../packages/core/src/tool-output-store.ts)
- Authorization and tools: [`packages/core/src/tool/results.ts`](../../packages/core/src/tool/results.ts), [`builtins.ts`](../../packages/core/src/tool/builtins.ts), [`registry.ts`](../../packages/core/src/tool/registry.ts)
- Computation: [`packages/core/src/tool/result-compute-runtime.ts`](../../packages/core/src/tool/result-compute-runtime.ts), [`result-compute-worker.ts`](../../packages/core/src/tool/result-compute-worker.ts)
- Reference persistence: [`packages/core/src/session/runner/publish-llm-event.ts`](../../packages/core/src/session/runner/publish-llm-event.ts), [`compaction.ts`](../../packages/core/src/session/compaction.ts)
- Input preflight: [`packages/core/src/util/bounded-json.ts`](../../packages/core/src/util/bounded-json.ts)
- Tests: [`tool-result-store.test.ts`](../../packages/core/test/tool-result-store.test.ts), [`tool-results.test.ts`](../../packages/core/test/tool-results.test.ts), [`result-compute-runtime.test.ts`](../../packages/core/test/result-compute-runtime.test.ts)
