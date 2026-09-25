# Zero-Mem prototype

Status: prototype, as of 2026-09-25 (not enabled in TurenOS).

This repository contains an isolated prototype inspired by [Zero-Mem: Zero-Token Memory Operations for LLM Agents](https://arxiv.org/abs/2607.29377). It is not enabled in TurenOS and does not replace the native memory service. It treats memory as provenance-preserving evidence selection rather than LLM-generated summaries; the raw trace remains the source of record.

Native TurenOS memory has a separate, optional Potion hybrid path controlled
by `semantic_memory.enabled`. That path keeps SQLite/FTS5 authoritative and is
not the same implementation as this Zero-Mem prototype. The prototype remains
useful for graph, hierarchy, closure, and benchmark experiments without
requiring a model download.

## Implementation

The implementation lives in `packages/plugin/src/zero-mem.ts` and has no Core or Server dependency. `ZeroMem.create()` returns an in-memory store with:

- verbatim, provenance-bearing trace units with idempotent upsert and removal
- deterministic BM25 lexical seeds
- regex-based code/security entity extraction and entity-context graph edges
- adjacent trace edges and fixed-size session/boundary windows
- deterministic query profiling and relational/local routing
- bounded graph propagation, local closure, score fusion, and result metadata
- exact session and boundary filters

Graph hops are capped and trace retention is bounded by default so an untrusted plugin option cannot stall the event loop or retain an unbounded transcript.

`packages/plugin/src/zero-mem-plugin.ts` provides an optional legacy-plugin adapter. It bootstraps the correctly scoped project drawers through the public SDK, refreshes that snapshot before search, ingests text events, and registers a separate `zero_mem_search` tool that requests `memory.read`. Completed tool output is opt-in because raw observations may contain secrets. For non-Git directories, the host must pass the native bound `projectKey`; the public plugin API cannot discover TurenOS's filesystem-identity binding on its own. It intentionally does not replace `memory_search`, the `Memory.Service`, the HTTP API, or Settings.

The public memory list endpoint (`packages/protocol/src/groups/memory.ts`) takes only wing and room filters and returns at most 200 drawers. Core's `Memory.Service` list accepts `limit` and `offset` (`packages/core/src/memory/index.ts`), but the protocol and SDK do not expose them. The adapter fails closed for a room at that limit instead of silently indexing a partial snapshot; a production adapter needs that pagination exposed at the host seam.

## Usage

```ts
import { ZeroMem } from "@turenlabs/plugin/zero-mem"

const memory = ZeroMem.create({
  topK: 5,
  windowSize: 8,
  graphHops: 2,
})

memory.upsert({
  id: "trace-1",
  text: "The Sable API credentials rotate daily.",
  timestamp: Date.now(),
  sessionID: "session-1",
  boundaryID: "turn-1",
})

const results = memory.search("Sable API rotation")
```

## Paper summary

Zero-Mem defines “zero-token memory operations” as memory construction,
organization, routing, retrieval, closure, and calibration that invoke no LLM
and consume no LLM input or output tokens. Only the final question-answering
reader uses an LLM.

The paper preserves interaction traces and derives two complementary views:

1. An entity-context graph connects observed entities to context units and connects adjacent context units.
2. A temporal hierarchy organizes turns into windows, episodes, and local spans.

Queries are profiled deterministically for subjects, keywords, answer type,
temporal cues, and boundary. Both views run for every query. Routing changes
their relative weights, graph propagation follows relational connections,
hierarchical retrieval preserves local context, and evidence closure adds
bounded graph bridges and neighbors. Calibration filters conflicting or
out-of-scope evidence before the final reader.

The paper's reference system uses non-generative NER such as spaCy, BM25, and
BGE-M3 dense embeddings. Its reported experiments use LoCoMo and long-context
HotpotQA variants. The paper reports 59.15 F1 / 52.96 BLEU-1 on LoCoMo with
GPT-4o-mini, 72.07 F1 on the 56K-token HotpotQA setting, and a 57.6% memory
operation latency reduction versus its fastest compared baseline.

Paper links:

- [arXiv abstract](https://arxiv.org/abs/2607.29377)
- [HTML paper](https://arxiv.org/html/2607.29377v1)
- [Official repository](https://github.com/TheMoon0815/Zero-mem)

## Paper differences

The paper leaves several reproduction details unspecified and its released repository currently contains no implementation. This prototype makes those choices explicit:

- regex extraction replaces spaCy NER
- BM25 is used as a deterministic local proxy; no BGE-M3 embedding or LLM call is made
- fixed turn windows replace learned or semantic episode segmentation
- graph propagation is bounded and in-memory
- evidence is returned as original trace text; no generated memory summary is written
- persistence, deletion reconciliation, final-QA reading, and answer calibration remain host responsibilities

The prototype therefore demonstrates the architecture and zero-token memory-operation property, not the paper's reported LoCoMo or HotpotQA scores.

## Benchmark

`packages/core/test/benchmark/zero-mem.ts` compares the actual SQLite/FTS `Memory.Service` with the prototype over the same deterministic drawer corpus. It reports build/index cost, warm query p50/p95 latency, recall@5, precision@5, MRR, and result counts. The corpus:

- 376 total drawers
- 360 distractors
- authored multi-hop, local-context, code, security, URL, and scope cases
- five measured runs after six warm-up queries
- p50/p95 latency, recall@5, precision@5, MRR, result counts, and build cost

Run it from the Core package:

```sh
FORGE_DB=:memory: BENCH_RUNS=5 bun run bench:zero-mem
```

The benchmark measures retrieval over drawer-as-trace projections. It is not an end-to-end agent or final-reader benchmark. Zero-Mem's in-memory ingest/rebuild time must not be compared to Core's durable SQLite write time as if they were equivalent persistence guarantees.

### Recorded results

Results as recorded in the repository on 2026-09-03:

| System                 | Query p50 | Query p95 | Recall@5 | Precision@5 |   MRR |
| ---------------------- | --------: | --------: | -------: | ----------: | ----: |
| Core Memory SQLite/FTS |  0.272 ms |  0.385 ms |    0.889 |       0.400 | 1.000 |
| Zero-Mem in-memory     |  0.095 ms |  0.153 ms |    1.000 |       0.467 | 1.000 |

Core's durable write and index build took 79.595 ms and 7.305 ms. Zero-Mem
ingest and rebuild took 0.668 ms and 4.962 ms. These build figures are not
equivalent persistence guarantees: the first writes durable SQLite records and
the second builds an in-memory index.
