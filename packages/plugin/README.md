# TurenOS Plugin Experiments

This package contains the public plugin APIs and an isolated prototype of
[Zero-Mem: Zero-Token Memory Operations for LLM Agents](https://arxiv.org/abs/2607.29377).
The prototype is **not enabled or registered in TurenOS**. TurenOS's native
SQLite/FTS memory service remains unchanged.

## Zero-Mem

Zero-Mem treats memory as provenance-preserving evidence selection rather than
LLM-generated summaries. The raw trace remains the source of record. The
prototype implements these pieces without a Core or Server dependency:

- BM25 lexical retrieval for exact names, paths, identifiers, dates, and phrases
- deterministic code/security entity extraction
- entity-context and adjacent-context graph edges
- fixed-size session and boundary windows
- deterministic query profiling and relational/local routing
- bounded graph propagation and temporal-local closure
- fused scores with relation and closure metadata
- session, boundary, scope, and validity filtering
- bounded trace retention and defensive copies for plugin safety

The implementation is available as:

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

## Recursive Context Plugin

`@turenlabs/plugin/rlm-plugin` is a small, opt-in RLM-style context
externalizer. It is intentionally a context-management primitive, not an
automatic recursive model runner: it moves explicitly tagged prompt content
out of the provider message and gives the model bounded search and read tools.

Create a local plugin module such as `.forge/plugins/rlm.ts`:

```ts
import { createRlmPlugin } from "@turenlabs/plugin/rlm-plugin"

export default createRlmPlugin({
  maxContextChars: 8_000_000,
  maxContextsPerSession: 32,
})
```

Add the module to the project's `forge.json`:

```json
{
  "$schema": "https://github.com/turenlabs/forge/config.json",
  "plugin": ["./.forge/plugins/rlm.ts"]
}
```

Mark a long input block explicitly so the plugin can preserve the surrounding
question while externalizing the bulk context:

```text
Compare the deployment behavior described in this context.

<!-- rlm-context name="deployment-notes" -->
...long context...
<!-- /rlm-context -->
```

The plugin replaces the marked block with a context handle and registers:

- `rlm_context_search` for focused lexical discovery
- `rlm_context_read` for bounded exact line ranges

Contexts are kept in memory for the plugin lifetime and scoped to the session
that created them. Search and read request the `rlm.context.read` permission.
The defaults bound one context to 8,000,000 characters, retain at most 32
contexts per session, return at most 20 search matches, and read at most 200
lines per call. The plugin does not execute generated code, call a second
model, or persist prompt content to disk.

After changing a plugin or `forge.json`, quit and restart TurenOS so the plugin
loader picks up the change.

`@turenlabs/plugin/zero-mem-plugin` also exports `createZeroMemPlugin`, an
optional legacy-plugin adapter. It registers a separate `zero_mem_search` tool,
requests `memory.read`, bootstraps the scoped durable drawer snapshot through
the SDK, and ingests live text events. It does not replace `memory_search`,
`Memory.Service`, the HTTP API, or Settings.

Adapter constraints:

- Completed tool output is excluded by default because raw observations may contain secrets.
- A non-Git project must provide the native bound `projectKey`; the public plugin API cannot discover TurenOS's filesystem-identity binding.
- The current memory list API caps a room at 200 drawers and has no pagination. The adapter fails closed instead of indexing a partial snapshot.

## Paper Summary

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

This repository is an engineering prototype, not a reproduction of those
results. It deliberately uses a deterministic regex entity extractor and a
BM25 lexical proxy instead of spaCy and BGE-M3, fixed windows instead of
semantic episode segmentation, and an in-memory index instead of durable
storage. The final-QA reader and answer calibration remain host concerns.

Paper links:

- [arXiv abstract](https://arxiv.org/abs/2607.29377)
- [HTML paper](https://arxiv.org/html/2607.29377v1)
- [Official repository](https://github.com/TheMoon0815/Zero-mem)

## Benchmark

The benchmark is `packages/core/test/benchmark/zero-mem.ts`. It compares the
actual Core `Memory.Service` backed by SQLite/FTS with the isolated Zero-Mem
store over the same deterministic drawer-as-trace corpus:

- 376 total drawers
- 360 distractors
- authored multi-hop, local-context, code, security, URL, and scope cases
- five measured runs after six warm-up queries
- p50/p95 latency, recall@5, precision@5, MRR, result counts, and build cost

Run it from `packages/core`:

```sh
FORGE_DB=:memory: BENCH_RUNS=5 bun run bench:zero-mem
```

Latest local run:

| System                 | Query p50 | Query p95 | Recall@5 | Precision@5 |   MRR |
| ---------------------- | --------: | --------: | -------: | ----------: | ----: |
| Core Memory SQLite/FTS |  0.272 ms |  0.385 ms |    0.889 |       0.400 | 1.000 |
| Zero-Mem in-memory     |  0.095 ms |  0.153 ms |    1.000 |       0.467 | 1.000 |

Core's durable write and index build took 79.595 ms and 7.305 ms. Zero-Mem
ingest and rebuild took 0.668 ms and 4.962 ms. These build figures are not
equivalent persistence guarantees: the first writes durable SQLite records and
the second builds an in-memory index.

The benchmark is retrieval-only. It is not an end-to-end agent, final-reader,
LoCoMo, or HotpotQA benchmark.

## Embedding Candidates

`script/bench-embedding-models.py` compares the current BM25-style baseline
with small ONNX and Model2Vec embedding models. It uses the same 376-trace
corpus as the Zero-Mem benchmark plus six paraphrase probes. Model files are
not committed; set the environment variables for the candidates you want to
run:

The production-facing `src/potion.ts` loader is dependency-free and downloads
only the pinned Potion safetensors and tokenizer artifacts when Core semantic
memory is enabled. The Python dependencies below are benchmark-only.

```sh
MINILM_MODEL=/path/to/model_int8.onnx \
BGE_MODEL=/path/to/model_int8.onnx \
VOCAB=/path/to/vocab.txt \
bun run bench:embeddings
```

The transformer candidates use `VOCAB`. Static Model2Vec candidates use model
IDs or local model directories and require `model2vec` in the benchmark
environment:

```sh
python3 -m pip install --target /tmp/forge-embedding-bench/pydeps model2vec
```

Candidate model files and formats:

- [all-MiniLM-L6-v2 INT8](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/main/onnx), approximately 22.8 MB, 384 dimensions
- [bge-small-en-v1.5 INT8](https://huggingface.co/Xenova/bge-small-en-v1.5/tree/main/onnx), approximately 33.8 MB, 384 dimensions
- [snowflake-arctic-embed-s INT8](https://huggingface.co/Snowflake/snowflake-arctic-embed-s/tree/main/onnx), approximately 34 MB, 384 dimensions
- [snowflake-arctic-embed-xs INT8/FP16](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/tree/main/onnx), approximately 23/45.3 MB, 384 dimensions
- [mxbai-embed-xsmall-v1 INT8](https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/tree/main/onnx), approximately 24.4 MB, 384 dimensions
- [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), approximately 30 MB deployed, static 256 dimensions
- [potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2), approximately 32 MB deployed, static 256 dimensions
- [pubmedbert-base-embeddings-8M](https://huggingface.co/NeuML/pubmedbert-base-embeddings-8M), approximately 31 MB deployed, static 256 dimensions
- [ogma-small](https://huggingface.co/axiotic/ogma-small), approximately 37 MB with ONNX weights and tokenizer, 256 dimensions; CC-BY-NC-4.0

Latest dense-only run on the synthetic corpus:

| System             | Recall@5 | Precision@5 |    Query p50 |    Query p95 |
| ------------------ | -------: | ----------: | -----------: | -----------: |
| BM25 baseline      |    0.944 |       0.433 | not measured | not measured |
| MiniLM INT8        |    0.903 |       0.417 |     1.214 ms |     2.116 ms |
| BGE-small INT8     |    0.917 |       0.417 |     2.914 ms |     4.254 ms |
| Arctic-S INT8      |    0.944 |       0.433 |     2.934 ms |     4.259 ms |
| Arctic-XS INT8     |    0.917 |       0.417 |     1.588 ms |     2.328 ms |
| Arctic-XS FP16     |    0.917 |       0.417 |     3.602 ms |     4.672 ms |
| mxbai-xsmall INT8  |    0.917 |       0.417 |     1.229 ms |     2.100 ms |
| Potion base 8M     |    0.917 |       0.417 |     0.036 ms |     0.049 ms |
| Potion code 16M v2 |    0.917 |       0.417 |     0.043 ms |     0.067 ms |
| PubMedBERT 8M      |    0.917 |       0.417 |     0.036 ms |     0.044 ms |
| Ogma small         |    0.972 |       0.450 |     1.297 ms |     1.742 ms |

These results are dense-only, not Zero-Mem graph-plus-dense fusion. The
synthetic corpus is dominated by exact technical identifiers, so BM25 is
expected to be competitive. Ogma's result is exploratory only because the
model is noncommercial. The embedding layer should remain optional until it is
evaluated on real conversational paraphrases and license requirements are
resolved.

### Code Retrieval

The benchmark also has a small code-specific mode with 36 TypeScript-like
snippets, 24 distractors, and 12 natural-language code queries. Run the Potion
comparison with:

```sh
PYTHONPATH=/tmp/forge-embedding-bench/pydeps \
HF_HOME=/tmp/forge-embedding-bench/hf \
BENCH_DATASET=code \
POTION_MODEL=minishlab/potion-base-8M \
POTION_CODE_MODEL=minishlab/potion-code-16M-v2 \
bun run bench:embeddings
```

Latest code-only run:

| System             | Recall@5 |   MRR |    Query p50 |    Query p95 |
| ------------------ | -------: | ----: | -----------: | -----------: |
| BM25 baseline      |    0.917 | 0.681 | not measured | not measured |
| Potion base 8M     |    0.917 | 0.653 |     0.057 ms |     0.174 ms |
| Potion code 16M v2 |    0.917 | 0.653 |     0.041 ms |     0.045 ms |

Potion-code is substantially faster than transformer models, but it did not
beat BM25 on this first small fixture. A larger code corpus with symbol,
language, and cross-file queries is needed before choosing it over a hybrid
BM25-plus-dense retriever.

### TurenOS Repository Retrieval

`BENCH_DATASET=repo` uses the current TurenOS checkout as the corpus. It scans
9,408 overlapping TypeScript/TSX chunks from `packages/`, excludes generated
and build output, and evaluates eight queries against real implementation
files. Targets are scored at file level so a neighboring chunk from the
correct source file counts as a hit.

```sh
PYTHONPATH=/tmp/forge-embedding-bench/pydeps \
HF_HOME=/tmp/forge-embedding-bench/hf \
BENCH_DATASET=repo \
POTION_MODEL=minishlab/potion-base-8M \
POTION_CODE_MODEL=minishlab/potion-code-16M-v2 \
bun run bench:embeddings
```

Latest TurenOS repository run:

| System             | File hit@5 |   MRR |    Query p50 |    Query p95 |
| ------------------ | ---------: | ----: | -----------: | -----------: |
| BM25 baseline      |      0.875 | 0.681 | not measured | not measured |
| Potion base 8M     |      0.375 | 0.375 |     0.038 ms |     0.053 ms |
| Potion code 16M v2 |      0.500 | 0.500 |     0.043 ms |     0.057 ms |

On the real repository, BM25 is currently the clear winner. Potion-code is
faster and beats Potion base, but does not yet justify replacing lexical code
search. The fixture is still a targeted eight-query smoke benchmark, not a
full code-search evaluation.

## Verification

From this directory:

```sh
bun typecheck
bun test
bun run build
```

The focused Core memory regression suite can be run separately:

```sh
cd ../core
bun test test/memory.test.ts
```
