#!/usr/bin/env python3
"""Compare small local embedding models with a BM25 baseline.

This benchmark deliberately has no model download step. Point MINILM_MODEL and
BGE_MODEL at local ONNX files, for example:

  MINILM_MODEL=/tmp/forge-embedding-bench/minilm-int8.onnx \
  BGE_MODEL=/tmp/forge-embedding-bench/bge-int8.onnx \
  VOCAB=/tmp/forge-embedding-bench/vocab.txt \
  python3 script/bench-embedding-models.py

The corpus mirrors the authored cases in the Zero-Mem benchmark and adds the
same 360 distractors. This measures dense retrieval quality and CPU overhead;
it does not claim to reproduce the full Zero-Mem graph fusion pipeline.
"""

from __future__ import annotations

import math
import os
import re
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, median
from typing import Iterable

import numpy as np
import onnxruntime as ort

try:
    from model2vec import StaticModel
except ImportError:
    StaticModel = None

try:
    from tokenizers import Tokenizer
except ImportError:
    Tokenizer = None


TOP_K = 5
RUNS = int(os.environ.get("BENCH_RUNS", "5"))
MAX_LENGTH = 256
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


@dataclass(frozen=True)
class Trace:
    key: str
    title: str
    body: str
    room: str

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.body}"


@dataclass(frozen=True)
class Query:
    name: str
    text: str
    gold: tuple[str, ...]
    room: str | None = None
    target_file: str | None = None


def authored_traces() -> list[Trace]:
    return [
        Trace("multi-source", "Cobalt Relay source", "Cobalt Relay emits an amber ticket toward the relay gate.", "multi-hop"),
        Trace("multi-bridge", "Amber ticket handoff", "The amber ticket crosses the handoff and carries the destination record.", "multi-hop"),
        Trace("multi-destination", "Glacier Cache destination", "Glacier Cache stores the destination record after the handoff.", "multi-hop"),
        Trace("local-before", "Violet switch migration", "The violet switch migration moved queued jobs to the new worker.", "local"),
        Trace("local-symptom", "Violet switch symptom", "After the migration, the queue stalled while the violet switch settled.", "local"),
        Trace("local-repair", "Queue repair", "The repair cleared the stalled queue and restored the worker.", "local"),
        Trace("code-definition", "SessionRunnerLLM definition", "SessionRunnerLLM is defined in packages/core/src/session/runner/llm.ts and owns the provider turn handler.", "code"),
        Trace("code-followup", "Provider stream handoff", "The llm.ts runner sends tool results through llm.stream before the next provider turn.", "code"),
        Trace("security-cve", "CVE mitigation", "CVE-2026-4242 exposed the vault token parser; the security fix rejects the malformed claim.", "security"),
        Trace("security-rotation", "Vault rotation", "The security fix rotates the vault secret and invalidates every stale token.", "security"),
        Trace("security-audit", "Authorization audit", "The authorization audit confirms the vault boundary denies the malformed claim.", "security"),
        Trace("fact-source", "Saffron Archive endpoint", "Saffron Archive publishes reports to https://archive.example.test/saffron.", "facts"),
        Trace("fact-format", "Saffron Archive format", "The archive endpoint returns signed reports in the saffron envelope.", "facts"),
        Trace("scope-target", "Boundary beacon", "Scope beacon boundary seal belongs to the selected session and is safe to retrieve.", "scope-a"),
        Trace("scope-wrong-boundary", "Boundary beacon from another boundary", "Scope beacon boundary seal belongs to a different boundary and must not be retrieved.", "scope-b"),
        Trace("scope-wrong-session", "Boundary beacon from another session", "Scope beacon boundary seal belongs to a different session and must not be retrieved.", "scope-b"),
    ]


def corpus() -> list[Trace]:
    distractors = [
        Trace(
            f"distractor-{index:03d}",
            f"Drawer filler {index:03d}",
            f"distractor-{index:03d} marker-{(index * 17) % 97:02d} ledger-{index:03d} retained for corpus pressure",
            "distractors",
        )
        for index in range(360)
    ]
    return distractors + authored_traces()


def code_corpus() -> list[Trace]:
    authored = [
        Trace("session-admission", "SessionV2 prompt admission", "async function prompt(input) inserts a durable session_input row before SessionExecution.wake(sessionID).", "code"),
        Trace("session-boundary", "SessionRunner provider boundary", "The SessionRunner promotes admitted inputs at the next safe provider-turn boundary after tool calls settle.", "code"),
        Trace("memory-scope", "Memory search scope", "Memory.search applies wing, room, asOf, and includeExpired filters before ordering FTS results.", "code"),
        Trace("memory-permission", "Memory read permission", "The memory tool authorizes memory.read against the project wing before reading or creating durable memory.", "code"),
        Trace("fts-reindex", "FTS rebuild", "Memory.reindex deletes and rebuilds memory_drawer_fts from the authoritative memory_drawer table.", "code"),
        Trace("plugin-events", "Plugin event ingestion", "The plugin handles message.part.updated and turns a text part into a provenance-preserving trace with memory.upsert.", "code"),
        Trace("code-anchor", "Repository anchor", "Drawer anchors store repository-relative path and symbol so code evidence can be rehydrated against the worktree.", "code"),
        Trace("stream-turn", "Single provider stream", "The runner makes one llm.stream(request) call per provider turn and consumes the async stream before continuation.", "code"),
        Trace("graph-propagation", "Entity graph propagation", "Zero-Mem propagates query activation across entity-context and adjacent-context graph edges before score fusion.", "code"),
        Trace("sqlite-transaction", "Atomic drawer write", "The memory write uses db.transaction to commit the drawer row and its FTS index update atomically.", "code"),
        Trace("room-uniqueness", "Room uniqueness", "memory_room has a unique wing_id and slug constraint so room upserts are stable within a project wing.", "code"),
        Trace("session-coordinator", "Session run coordinator", "SessionRunCoordinator coalesces same-session resumes while allowing different sessions to run concurrently.", "code"),
    ]
    distractors = [
        Trace(
            f"code-distractor-{index:02d}",
            f"Utility implementation {index:02d}",
            f"function utility{index:02d}(value) {{ const result = value.trim(); return result.toLowerCase(); }} generic helper module.",
            "code",
        )
        for index in range(24)
    ]
    return distractors + authored


def code_queries() -> list[Query]:
    return [
        Query("admit before wake", "Where is a new instruction turned into durable work before its run starts?", ("session-admission",)),
        Query("safe prompt boundary", "Which code waits until tools finish before accepting another instruction?", ("session-boundary",)),
        Query("memory historical scope", "How does stored project-note lookup constrain topic and date?", ("memory-scope",)),
        Query("memory authorization", "Where is access to saved project notes checked before reading them?", ("memory-permission",)),
        Query("rebuild FTS", "Which routine recreates the full-text side table from canonical records?", ("fts-reindex",)),
        Query("event trace", "How is a live chat fragment captured as searchable evidence?", ("plugin-events",)),
        Query("code provenance", "Where do retrieved facts retain their file and symbol references?", ("code-anchor",)),
        Query("single stream", "Which implementation avoids issuing a second model request during one turn?", ("stream-turn",)),
        Query("graph activation", "How does relevance spread through related entities and neighboring contexts?", ("graph-propagation",)),
        Query("atomic write", "Where are a record update and its search index change made all-or-nothing?", ("sqlite-transaction",)),
        Query("room constraint", "How does the database prevent duplicate topic containers in one project?", ("room-uniqueness",)),
        Query("resume coordination", "Which coordinator continues one run together while unrelated runs proceed concurrently?", ("session-coordinator",)),
    ]


def repo_corpus(root: Path) -> list[Trace]:
    chunks: list[Trace] = []
    excluded_parts = {".git", "build", "dist", "generated", "node_modules"}
    for path in sorted(root.joinpath("packages").rglob("*.ts")) + sorted(root.joinpath("packages").rglob("*.tsx")):
        if any(part in excluded_parts for part in path.parts) or ".gen." in path.name:
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        relative = path.relative_to(root).as_posix()
        for start in range(0, len(lines), 60):
            end = min(start + 80, len(lines))
            body = "\n".join(lines[start:end]).strip()
            if not body:
                continue
            chunks.append(Trace(f"{relative}:{start + 1}-{end}", relative, body, "repo"))
            if end == len(lines):
                break
    return chunks


def repo_queries(documents: list[Trace]) -> list[Query]:
    cases = [
        ("memory search scope", "How does durable memory apply wing room and temporal filters before FTS ranking?", "packages/core/src/memory/index.ts", 'const search = Effect.fn("Memory.search")'),
        ("memory authorization", "Where is project memory read access authorized before database search?", "packages/core/src/tool/memory.ts", 'authorize("memory.read"'),
        ("graph propagation", "Which routine spreads query activation through entity adjacency before score fusion?", "packages/plugin/src/zero-mem.ts", "function propagateGraph"),
        ("plugin bridge", "Where is the optional plugin search tool and event bridge constructed?", "packages/plugin/src/zero-mem-plugin.ts", "export function createZeroMemPlugin"),
        ("provider stream", "Where is one provider stream consumed for each model turn?", "packages/core/src/session/runner/llm.ts", "llm.stream(wireRequest)"),
        ("memory terms", "Where are memory search terms normalized and bounded before FTS expression generation?", "packages/core/src/memory/tokenize.ts", "export function searchTerms"),
        ("layer replacement", "Which module composes effect layer nodes and applies service replacements?", "packages/core/src/effect/layer-node.ts", "export function compile"),
        ("trace validity", "Where are returned traces filtered by session boundary scope and validity?", "packages/plugin/src/zero-mem.ts", "function isAllowedTrace"),
    ]
    output: list[Query] = []
    for name, text, file_fragment, marker in cases:
        if not any(file_fragment in document.key and marker in document.body for document in documents):
            raise RuntimeError(f"repository benchmark marker not found: {file_fragment} {marker}")
        # A code hit is useful when it lands in a neighboring chunk of the
        # right file, so score at file granularity while keeping the marker as
        # a fixture guard.
        gold = tuple(document.key for document in documents if file_fragment in document.key)
        output.append(Query(name, text, gold, target_file=file_fragment))
    return output


def queries() -> list[Query]:
    return [
        Query("multi-hop relation", "How does Cobalt Relay connect to Glacier Cache?", ("multi-source", "multi-bridge", "multi-destination")),
        Query("local timeline", "What happened after the Violet Switch migration?", ("local-before", "local-symptom", "local-repair")),
        Query("code path", "Where is SessionRunnerLLM defined in packages/core/src/session/runner/llm.ts?", ("code-definition", "code-followup")),
        Query("security chain", "What security fix addressed CVE-2026-4242?", ("security-cve", "security-rotation", "security-audit")),
        Query("fact and URL", "Where does Saffron Archive publish reports?", ("fact-source", "fact-format")),
        Query("scoped room", "scope beacon boundary seal", ("scope-target",), "scope-a"),
    ]


def semantic_probes() -> list[Query]:
    return [
        Query("paraphrase relay", "Which relay sends the amber handoff toward the glacier storage?", ("multi-source", "multi-bridge", "multi-destination")),
        Query("paraphrase timeline", "What was the outcome once the violet migration changed workers?", ("local-before", "local-symptom", "local-repair")),
        Query("paraphrase code", "Which module owns the provider turn implementation and its streaming handoff?", ("code-definition", "code-followup")),
        Query("paraphrase security", "How were invalid vault credentials neutralized after the parser vulnerability?", ("security-cve", "security-rotation", "security-audit")),
        Query("paraphrase archive", "What web location hosts Saffron's publications?", ("fact-source", "fact-format")),
        Query("paraphrase scope", "What marker belongs to the chosen boundary?", ("scope-target",), "scope-a"),
    ]


def basic_tokens(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFD", text.lower())
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return re.findall(r"[a-z0-9]+(?:[-_./][a-z0-9]+)*", normalized)


class WordPieceTokenizer:
    def __init__(self, vocab_path: str):
        self.vocab = {
            token: index
            for index, token in enumerate(Path(vocab_path).read_text(encoding="utf-8").splitlines())
        }
        self.unk = self.vocab["[UNK]"]
        self.cls = self.vocab["[CLS]"]
        self.sep = self.vocab["[SEP]"]
        self.pad = self.vocab["[PAD]"]

    def wordpiece(self, token: str) -> list[int]:
        if len(token) > 100:
            return [self.unk]
        output: list[int] = []
        start = 0
        while start < len(token):
            end = len(token)
            match: str | None = None
            while start < end:
                candidate = token[start:end] if start == 0 else f"##{token[start:end]}"
                if candidate in self.vocab:
                    match = candidate
                    break
                end -= 1
            if match is None:
                return [self.unk]
            output.append(self.vocab[match])
            start = end
        return output

    def encode(self, text: str) -> list[int]:
        pieces = [piece for token in basic_tokens(text) for piece in self.wordpiece(token)]
        pieces = pieces[: MAX_LENGTH - 2]
        return [self.cls, *pieces, self.sep]

    def batch(self, texts: Iterable[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        encoded = [self.encode(text) for text in texts]
        width = max(len(item) for item in encoded)
        ids = np.full((len(encoded), width), self.pad, dtype=np.int64)
        mask = np.zeros((len(encoded), width), dtype=np.int64)
        for row, item in enumerate(encoded):
            ids[row, : len(item)] = item
            mask[row, : len(item)] = 1
        return ids, mask, np.zeros_like(ids)


class EmbeddingModel:
    def __init__(self, path: str, tokenizer: WordPieceTokenizer, pooling: str = "mean", query_prefix: str = ""):
        started = time.perf_counter()
        self.session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self.load_ms = (time.perf_counter() - started) * 1000
        self.tokenizer = tokenizer
        self.pooling = pooling
        self.query_prefix = query_prefix
        self.input_names = {item.name for item in self.session.get_inputs()}
        self.output_names = {item.name for item in self.session.get_outputs()}

    def encode(self, texts: list[str]) -> np.ndarray:
        ids, mask, token_types = self.tokenizer.batch(texts)
        inputs = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            inputs["token_type_ids"] = token_types
        output_names = ["sentence_embedding"] if "sentence_embedding" in self.output_names else ["last_hidden_state"]
        output = self.session.run(output_names, inputs)[0]
        if output.ndim == 2 or self.pooling == "sentence":
            pooled = output
        elif self.pooling == "cls":
            pooled = output[:, 0]
        else:
            weights = mask.astype(np.float32)[..., None]
            pooled = (output * weights).sum(axis=1) / weights.sum(axis=1).clip(min=1)
        return pooled / np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-12)

    def query(self, text: str) -> np.ndarray:
        return self.encode([f"{self.query_prefix}{text}"])[0]


class StaticEmbeddingModel:
    def __init__(self, model_id: str):
        if StaticModel is None:
            raise SystemExit("Static models require model2vec; install it outside the repository")
        started = time.perf_counter()
        self.model = StaticModel.from_pretrained(model_id)
        self.load_ms = (time.perf_counter() - started) * 1000

    def encode(self, texts: list[str]) -> np.ndarray:
        embeddings = np.asarray(self.model.encode(texts), dtype=np.float32)
        return embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True).clip(min=1e-12)

    def query(self, text: str) -> np.ndarray:
        return self.encode([text])[0]


class OgmaEmbeddingModel:
    def __init__(self, model_path: str, tokenizer_path: str):
        if Tokenizer is None:
            raise SystemExit("Ogma requires tokenizers; install model2vec outside the repository")
        started = time.perf_counter()
        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.tokenizer = Tokenizer.from_file(tokenizer_path)
        self.load_ms = (time.perf_counter() - started) * 1000

    def encode(self, texts: list[str]) -> np.ndarray:
        encoded = self.tokenizer.encode_batch(texts)
        width = max(len(item.ids) for item in encoded)
        ids = np.zeros((len(encoded), width), dtype=np.int64)
        mask = np.zeros((len(encoded), width), dtype=np.int64)
        for row, item in enumerate(encoded):
            # The exported model reserves seven IDs ahead of tokenizer.json's
            # SentencePiece vocabulary, including shifted CLS/SEP IDs.
            ids[row, : len(item.ids)] = np.asarray(item.ids, dtype=np.int64) + 7
            mask[row, : len(item.attention_mask)] = item.attention_mask
        output = self.session.run(
            ["embeddings"],
            {
                "token_ids": ids,
                "attention_mask": mask,
                "task_token_ids": np.full((len(texts),), 4, dtype=np.int64),
            },
        )[0]
        return output / np.linalg.norm(output, axis=1, keepdims=True).clip(min=1e-12)

    def query(self, text: str) -> np.ndarray:
        return self.encode([text])[0]


def bm25_scores(documents: list[Trace], query: str) -> list[float]:
    document_tokens = [basic_tokens(document.text) for document in documents]
    query_tokens = basic_tokens(query)
    lengths = [len(tokens) for tokens in document_tokens]
    average_length = mean(lengths)
    document_frequency = Counter(token for tokens in document_tokens for token in set(tokens))
    scores: list[float] = []
    for tokens, length in zip(document_tokens, lengths):
        frequencies = Counter(tokens)
        score = 0.0
        for token in query_tokens:
            if token not in frequencies:
                continue
            idf = math.log(1 + (len(documents) - document_frequency[token] + 0.5) / (document_frequency[token] + 0.5))
            term_frequency = frequencies[token]
            score += idf * term_frequency * 2.0 / (term_frequency + 1.5 * (0.25 + 0.75 * length / average_length))
        scores.append(score)
    return scores


def rank(scores: Iterable[float], documents: list[Trace], query: Query) -> list[str]:
    candidates = [
        (score, document)
        for score, document in zip(scores, documents)
        if query.room is None or document.room == query.room
    ]
    return [document.key for _, document in sorted(candidates, key=lambda item: (-item[0], item[1].key))[:TOP_K]]


def metrics(result: list[str], gold: tuple[str, ...], target_file: str | None = None) -> tuple[float, float, float]:
    if target_file is not None:
        relevant = sum(item.startswith(f"{target_file}:") for item in result)
        first = next((index for index, item in enumerate(result) if item.startswith(f"{target_file}:")), None)
        return float(relevant > 0), relevant / TOP_K, 0.0 if first is None else 1.0 / (first + 1)
    gold_set = set(gold)
    relevant = sum(item in gold_set for item in result)
    first = next((index for index, item in enumerate(result) if item in gold_set), None)
    return relevant / len(gold), relevant / TOP_K, 0.0 if first is None else 1.0 / (first + 1)


def report(name: str, query_results: dict[str, list[list[str]]], queries_to_run: list[Query], latencies: dict[str, list[float]]) -> None:
    print(f"\n{name}")
    print("  query                     p50 ms   p95 ms   recall@5   prec@5    MRR")
    recalls: list[float] = []
    precisions: list[float] = []
    mrrs: list[float] = []
    for index, query in enumerate(queries_to_run):
        scores = [metrics(results[index], query.gold, query.target_file) for results in query_results[name]]
        recalls.extend(score[0] for score in scores)
        precisions.extend(score[1] for score in scores)
        mrrs.extend(score[2] for score in scores)
        values = sorted(latencies[name][index::len(queries_to_run)])
        p95 = values[max(0, math.ceil(len(values) * 0.95) - 1)]
        print(f"  {query.name:<24} {median(values):7.3f} {p95:8.3f} {mean(score[0] for score in scores):9.3f} {mean(score[1] for score in scores):8.3f} {mean(score[2] for score in scores):7.3f}")
    print(f"  aggregate                  {median(latencies[name]):7.3f} {'':8} {mean(recalls):9.3f} {mean(precisions):8.3f} {mean(mrrs):7.3f}")


def main() -> None:
    model_specs = {
        "MiniLM INT8": (os.environ.get("MINILM_MODEL"), "mean", "", "onnx"),
        "BGE-small INT8": (os.environ.get("BGE_MODEL"), "mean", BGE_QUERY_PREFIX, "onnx"),
        "Arctic-S INT8": (os.environ.get("ARCTIC_S_MODEL"), "cls", BGE_QUERY_PREFIX, "onnx"),
        "Arctic-XS INT8": (os.environ.get("ARCTIC_XS_MODEL"), "cls", BGE_QUERY_PREFIX, "onnx"),
        "mxbai-xsmall INT8": (os.environ.get("MXBAI_MODEL"), "sentence", "", "onnx"),
        "Potion base 8M": (os.environ.get("POTION_MODEL"), "", "", "static"),
        "Potion code 16M v2": (os.environ.get("POTION_CODE_MODEL"), "", "", "static"),
        "PubMedBERT 8M": (os.environ.get("PUBMEDBERT_MODEL"), "", "", "static"),
        "Arctic-XS FP16": (os.environ.get("ARCTIC_XS_FP16_MODEL"), "cls", BGE_QUERY_PREFIX, "onnx"),
        "Ogma small": (os.environ.get("OGMA_MODEL"), os.environ.get("OGMA_TOKENIZER"), "", "ogma"),
    }
    vocab = os.environ.get("VOCAB")
    if not any(path is not None for path, _, _, _ in model_specs.values()):
        raise SystemExit("Set at least one model path, model ID, or VOCAB-backed ONNX model environment variable")

    dataset = os.environ.get("BENCH_DATASET", "memory")
    if dataset == "code":
        documents = code_corpus()
        test_queries = code_queries()
    elif dataset == "repo":
        root = Path(os.environ.get("REPO_ROOT", Path(__file__).resolve().parents[3]))
        documents = repo_corpus(root)
        test_queries = repo_queries(documents)
    else:
        documents = corpus()
        test_queries = queries() + semantic_probes()
    onnx_requested = any(path is not None and kind == "onnx" for path, _, _, kind in model_specs.values())
    if onnx_requested and vocab is None:
        raise SystemExit("VOCAB is required when benchmarking an ONNX model")
    tokenizer = WordPieceTokenizer(vocab) if vocab is not None else None
    print(f"Embedding benchmark ({dataset}): {len(documents)} traces, {len(test_queries)} queries, {RUNS} runs")

    bm25_results: list[list[str]] = []
    bm25_scores_by_query = [bm25_scores([document for document in documents if query.room is None or document.room == query.room], query.text) for query in test_queries]
    bm25_documents_by_query = [[document for document in documents if query.room is None or document.room == query.room] for query in test_queries]
    for scores, scoped_documents in zip(bm25_scores_by_query, bm25_documents_by_query):
        bm25_results.append([document.key for _, document in sorted(zip(scores, scoped_documents), key=lambda item: (-item[0], item[1].key))[:TOP_K]])
    print("\nBM25 baseline")
    for query, result in zip(test_queries, bm25_results):
        recall, precision, mrr = metrics(result, query.gold, query.target_file)
        print(f"  {query.name:<24} recall={recall:.3f} precision={precision:.3f} MRR={mrr:.3f}")

    for name, (path, pooling, query_prefix, kind) in model_specs.items():
        if path is None:
            continue
        model = (
            EmbeddingModel(path, tokenizer, pooling, query_prefix)
            if kind == "onnx"
            else OgmaEmbeddingModel(path, pooling) if kind == "ogma" else StaticEmbeddingModel(path)
        )
        document_embeddings = model.encode([document.text for document in documents])
        query_embeddings = [model.query(query.text) for query in test_queries]
        model_results: list[list[str]] = []
        for query_embedding, query in zip(query_embeddings, test_queries):
            scoped = [index for index, document in enumerate(documents) if query.room is None or document.room == query.room]
            scores = np.einsum(
                "ij,j->i",
                np.asarray(document_embeddings[scoped], dtype=np.float64),
                np.asarray(query_embedding, dtype=np.float64),
            )
            model_results.append([documents[index].key for _, index in sorted(zip(scores, scoped), key=lambda item: (-item[0], documents[item[1]].key))[:TOP_K]])
        latencies: list[float] = []
        for _ in range(RUNS):
            for query in test_queries:
                started = time.perf_counter()
                model.query(query.text)
                latencies.append((time.perf_counter() - started) * 1000)
        print(f"\n{name}: model load {model.load_ms:.1f} ms, document encoding complete")
        for query, result in zip(test_queries, model_results):
            recall, precision, mrr = metrics(result, query.gold, query.target_file)
            print(f"  {query.name:<24} recall={recall:.3f} precision={precision:.3f} MRR={mrr:.3f} results={','.join(result)}")
        print(f"  query latency p50={median(latencies):.3f} ms p95={sorted(latencies)[max(0, math.ceil(len(latencies) * .95) - 1)]:.3f} ms")


if __name__ == "__main__":
    main()
