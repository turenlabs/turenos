# Zero-Mem prototype

Status: prototype, as of 2026-09-25 (not enabled in TurenOS).

This repository contains an isolated prototype inspired by [Zero-Mem: Zero-Token Memory Operations for LLM Agents](https://arxiv.org/abs/2607.29377). It is not enabled in TurenOS and does not replace the native memory service.

Native TurenOS memory now has a separate, optional Potion hybrid path controlled
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

The current memory list API has a 200-drawer room limit and no pagination. The adapter fails closed for a room at that limit instead of silently indexing a partial snapshot; a production adapter should add pagination at the host seam.

## Paper Differences

The paper leaves several reproduction details unspecified and its released repository currently contains no implementation. This prototype makes those choices explicit:

- regex extraction replaces spaCy NER
- BM25 is used as a deterministic local proxy; no BGE-M3 embedding or LLM call is made
- fixed turn windows replace learned or semantic episode segmentation
- graph propagation is bounded and in-memory
- evidence is returned as original trace text; no generated memory summary is written
- persistence, deletion reconciliation, final-QA reading, and answer calibration remain host responsibilities

The prototype therefore demonstrates the architecture and zero-token memory-operation property, not the paper's reported LoCoMo or HotpotQA scores.

## Benchmark

`packages/core/test/benchmark/zero-mem.ts` compares the actual SQLite/FTS `Memory.Service` with the prototype over the same deterministic drawer corpus. It reports build/index cost, warm query p50/p95 latency, recall@5, precision@5, MRR, and result counts. The corpus contains authored multi-hop, local-context, code, security, URL, and scope cases plus 360 distractors.

Run it from the Core package:

```sh
FORGE_DB=:memory: BENCH_RUNS=5 bun run bench:zero-mem
```

The benchmark measures retrieval over drawer-as-trace projections. It is not an end-to-end agent or final-reader benchmark. Zero-Mem's in-memory ingest/rebuild time must not be compared to Core's durable SQLite write time as if they were equivalent persistence guarantees.
