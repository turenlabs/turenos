# Embedding model benchmark

Status: benchmark, as of 2026-09-03 (the date the results were recorded).

Compares small embedding models against the BM25-style baseline for memory and code retrieval, to decide whether an
embedding layer earns its place. Run the commands from `packages/plugin`.

## Candidates

`packages/plugin/script/bench-embedding-models.py` compares the current BM25-style baseline
with small ONNX and Model2Vec embedding models. It uses the same 376-trace
corpus as the Zero-Mem benchmark plus six paraphrase probes. Model files are
not committed; set the environment variables for the candidates you want to
run:

The production-facing `packages/plugin/src/potion.ts` loader is dependency-free and downloads
only the pinned Potion safetensors and tokenizer artifacts. Core loads it in two places: semantic memory
(`packages/core/src/memory/semantic.ts`) when `semantic_memory` is enabled, and `code_search` query expansion
(`packages/core/src/search/index.ts`, cached under `code-search-embeddings`) on every query regardless of that
setting. The Python dependencies below are benchmark-only.

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
- [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M), about 31 MB for the [pinned model and tokenizer](https://huggingface.co/api/models/minishlab/potion-base-8M/revision/bf8b056651a2c21b8d2565580b8569da283cab23?blobs=true), static 256 dimensions ([pinned configuration](https://huggingface.co/minishlab/potion-base-8M/blob/bf8b056651a2c21b8d2565580b8569da283cab23/config.json))
- [potion-code-16M-v2](https://huggingface.co/minishlab/potion-code-16M-v2), approximately 32 MB deployed, static 256 dimensions
- [pubmedbert-base-embeddings-8M](https://huggingface.co/NeuML/pubmedbert-base-embeddings-8M), approximately 31 MB deployed, static 256 dimensions
- [ogma-small](https://huggingface.co/axiotic/ogma-small), approximately 37 MB with ONNX weights and tokenizer, 256 dimensions; CC-BY-NC-4.0

Dense-only results on the synthetic corpus, as recorded on 2026-09-03:

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

## Code retrieval

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

Code-only results, as recorded on 2026-09-03:

| System             | Recall@5 |   MRR |    Query p50 |    Query p95 |
| ------------------ | -------: | ----: | -----------: | -----------: |
| BM25 baseline      |    0.917 | 0.681 | not measured | not measured |
| Potion base 8M     |    0.917 | 0.653 |     0.057 ms |     0.174 ms |
| Potion code 16M v2 |    0.917 | 0.653 |     0.041 ms |     0.045 ms |

Potion-code is substantially faster than transformer models, but it did not
beat BM25 on this first small fixture. A larger code corpus with symbol,
language, and cross-file queries is needed before choosing it over a hybrid
BM25-plus-dense retriever.

## Repository retrieval

`BENCH_DATASET=repo` uses the current TurenOS checkout as the corpus. It scans
9,408 overlapping TypeScript/TSX chunks from `packages/` (counted when the benchmark ran), excludes generated
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

Repository results, as recorded on 2026-09-03:

| System             | File hit@5 |   MRR |    Query p50 |    Query p95 |
| ------------------ | ---------: | ----: | -----------: | -----------: |
| BM25 baseline      |      0.875 | 0.681 | not measured | not measured |
| Potion base 8M     |      0.375 | 0.375 |     0.038 ms |     0.053 ms |
| Potion code 16M v2 |      0.500 | 0.500 |     0.043 ms |     0.057 ms |

On the real repository, BM25 is currently the clear winner. Potion-code is
faster and beats Potion base, but does not yet justify replacing lexical code
search. The fixture is still a targeted eight-query smoke benchmark, not a
full code-search evaluation.
