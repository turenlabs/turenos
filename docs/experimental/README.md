# Experimental

Prototypes, experiments, and benchmarks that explore or measure rather than document how a shipped system behaves.
Each page starts with a status line. When a prototype ships, its behavior moves to a page under
[systems](../systems/README.md) and the experimental page is marked `adopted`.

- [Zero-Mem prototype](./zero-mem.md): isolated graph/hierarchy retrieval prototype and benchmark methodology.
- [Recursive context plugin](./recursive-context.md): an opt-in plugin that moves tagged long context out of the
  prompt behind bounded search and read tools.
- [Embedding model benchmark](./embedding-models.md): small embedding models against the BM25 baseline for memory,
  code, and repository retrieval.
- [Token efficiency](./token-efficiency.md): measured context-token cost, benchmark method, and remaining overhead.
