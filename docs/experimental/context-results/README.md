# Retained result research

Status: adopted, as of 2026-10-20.

The offline context-management probe informed Session V2's [retained tool results](../../systems/retained-results.md).
The probe compared access mechanisms on synthetic data; it did not evaluate an agent's decisions or provider costs.
The system page describes the implementation. This record keeps the experiment and historical evidence separate.

## Method

Run the deterministic probe from `packages/core`:

```sh
bun run test/benchmark/context-results.ts /tmp/context-results.results.json
```

The [probe source](../../../packages/core/test/benchmark/context-results.ts) and
[recorded results](../../../packages/core/test/benchmark/context-results.results.json) use handwritten programs and
queries. The [research notes](../../../packages/core/test/benchmark/context-results.research.json) identify the pinned
source commit, external references and their qualifications. Those measurements precede the implementation and its
integration with current main.

## Results

In the recorded macOS ARM64/Bun 1.4.2 fixture run, the 448,237-byte output was retained exactly while its 51,200-byte
preview omitted evidence in the middle. Lexical retrieval found all three exact queries and none of the three selected
paraphrases. A search page returned three of 32 matching rows; a handwritten CodeMode aggregate correctly counted 32
failures across 2,048 records and returned a 114-byte result envelope.

These are fixture byte counts, not measured token savings. The CodeMode probe calls one fixture host tool; the retained
result worker instead receives authorized data and exposes no host tools.

## Limits

The fixture does not measure model-generated queries or programs, real task completion, provider tokenization, retries,
prompt-cache billing or total operating cost. The [implementation plan and evidence](./plan.json) labels its original
local verification as a pre-integration baseline; current-main verification and the draft pull request are separate
terminal gates. Overlapping test runs must not be added into a unique-test count.
