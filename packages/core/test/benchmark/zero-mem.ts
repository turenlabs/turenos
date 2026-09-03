#!/usr/bin/env bun
/**
 * Retrieval benchmark over drawer-as-trace projections.
 *
 * This is not a reproduction of the paper's full LoCoMo or HotpotQA
 * evaluation. It compares the current Core Memory SQLite/FTS service with the
 * isolated plugin implementation over a deterministic TurenOS-shaped corpus.
 * Zero-Mem uses its deterministic regex entity extractor and BM25 lexical
 * proxy; it does not use spaCy, embeddings, LLM calls, or network access.
 *
 * Run from packages/core with an in-memory database:
 *   FORGE_DB=:memory: BENCH_RUNS=5 bun run test/benchmark/zero-mem.ts
 */
import { performance } from "node:perf_hooks"
import { Effect } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Database } from "@turenlabs/core/database/database"
import { Memory } from "@turenlabs/core/memory"
import { ZeroMem } from "../../../plugin/src/zero-mem.ts"

const TOP_K = 5
const DISTRACTOR_COUNT = 360
const CORPUS_TIME = 1_700_000_000_000

type DrawerKind = "note" | "fact" | "decision" | "observation"

type CorpusSpec = {
  readonly key: string
  readonly title: string
  readonly body: string
  readonly kind: DrawerKind
  readonly roomKey: string
  readonly sessionID: string
  readonly boundaryID: string
  readonly anchor?: Memory.Anchor
}

type CorpusEntry = {
  readonly spec: CorpusSpec
  readonly drawer: Memory.Drawer
}

type QueryCase = {
  readonly name: string
  readonly query: string
  readonly goldKeys: readonly string[]
  readonly roomKey?: string
}

type QueryPlan = QueryCase & {
  readonly goldIDs: readonly string[]
  readonly scopeRoomID?: Memory.RoomID
  readonly allowedIDs?: ReadonlySet<string>
}

type Sample = {
  readonly latencyMs: number
  readonly resultCount: number
  readonly recall: number
  readonly precision: number
  readonly mrr: number
}

type ArmSummary = {
  readonly p50Ms: number
  readonly p95Ms: number
  readonly recallAtK: number
  readonly precisionAtK: number
  readonly mrr: number
  readonly meanResultCount: number
}

type QuerySummary = {
  readonly name: string
  readonly query: string
  readonly goldEvidenceIDs: readonly string[]
  readonly scope?: {
    readonly roomKey: string
  }
  readonly core: ArmSummary
  readonly zeroMem: ArmSummary
}

type BenchmarkSummary = {
  readonly benchmark: string
  readonly corpus: {
    readonly distractors: number
    readonly authoredTraces: number
    readonly totalDrawers: number
  }
  readonly config: {
    readonly database: string
    readonly runs: number
    readonly topK: number
    readonly warmupQueries: number
  }
  readonly build: {
    readonly core: {
      readonly writeMs: number
      readonly indexMs: number
      readonly indexedDrawers: number
    }
    readonly zeroMem: {
      readonly ingestMs: number
      readonly rebuildMs: number
      readonly stats: ZeroMem.Stats
    }
  }
  readonly queries: readonly QuerySummary[]
  readonly aggregate: {
    readonly core: ArmSummary
    readonly zeroMem: ArmSummary
  }
}

function readRuns(): number {
  const value = Number.parseInt(process.env["BENCH_RUNS"] ?? "5", 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("BENCH_RUNS must be a positive integer")
  }
  return value
}

function authoredCorpus(): readonly CorpusSpec[] {
  return [
    {
      key: "multi-source",
      title: "Cobalt Relay source",
      body: "Cobalt Relay emits an amber ticket toward the relay gate.",
      kind: "fact",
      roomKey: "multi-hop",
      sessionID: "ses-multi-hop",
      boundaryID: "boundary-multi-hop",
    },
    {
      key: "multi-bridge",
      title: "Amber ticket handoff",
      body: "The amber ticket crosses the handoff and carries the destination record.",
      kind: "observation",
      roomKey: "multi-hop",
      sessionID: "ses-multi-hop",
      boundaryID: "boundary-multi-hop",
    },
    {
      key: "multi-destination",
      title: "Glacier Cache destination",
      body: "Glacier Cache stores the destination record after the handoff.",
      kind: "fact",
      roomKey: "multi-hop",
      sessionID: "ses-multi-hop",
      boundaryID: "boundary-multi-hop",
    },
    {
      key: "local-before",
      title: "Violet switch migration",
      body: "The violet switch migration moved queued jobs to the new worker.",
      kind: "decision",
      roomKey: "local",
      sessionID: "ses-local",
      boundaryID: "boundary-local",
    },
    {
      key: "local-symptom",
      title: "Violet switch symptom",
      body: "After the migration, the queue stalled while the violet switch settled.",
      kind: "observation",
      roomKey: "local",
      sessionID: "ses-local",
      boundaryID: "boundary-local",
    },
    {
      key: "local-repair",
      title: "Queue repair",
      body: "The repair cleared the stalled queue and restored the worker.",
      kind: "decision",
      roomKey: "local",
      sessionID: "ses-local",
      boundaryID: "boundary-local",
    },
    {
      key: "code-definition",
      title: "SessionRunnerLLM definition",
      body: "SessionRunnerLLM is defined in packages/core/src/session/runner/llm.ts and owns the provider turn handler.",
      kind: "fact",
      roomKey: "code",
      sessionID: "ses-code",
      boundaryID: "boundary-code",
      anchor: { repo: "forge", path: "packages/core/src/session/runner/llm.ts", symbol: "SessionRunnerLLM" },
    },
    {
      key: "code-followup",
      title: "Provider stream handoff",
      body: "The llm.ts runner sends tool results through llm.stream before the next provider turn.",
      kind: "observation",
      roomKey: "code",
      sessionID: "ses-code",
      boundaryID: "boundary-code",
      anchor: { repo: "forge", path: "packages/core/src/session/runner/llm.ts" },
    },
    {
      key: "security-cve",
      title: "CVE mitigation",
      body: "CVE-2026-4242 exposed the vault token parser; the security fix rejects the malformed claim.",
      kind: "observation",
      roomKey: "security",
      sessionID: "ses-security",
      boundaryID: "boundary-security",
    },
    {
      key: "security-rotation",
      title: "Vault rotation",
      body: "The security fix rotates the vault secret and invalidates every stale token.",
      kind: "decision",
      roomKey: "security",
      sessionID: "ses-security",
      boundaryID: "boundary-security",
    },
    {
      key: "security-audit",
      title: "Authorization audit",
      body: "The authorization audit confirms the vault boundary denies the malformed claim.",
      kind: "fact",
      roomKey: "security",
      sessionID: "ses-security",
      boundaryID: "boundary-security",
    },
    {
      key: "fact-source",
      title: "Saffron Archive endpoint",
      body: "Saffron Archive publishes reports to https://archive.example.test/saffron.",
      kind: "fact",
      roomKey: "facts",
      sessionID: "ses-facts",
      boundaryID: "boundary-facts",
      anchor: { repo: "forge", path: "docs/saffron-archive.md" },
    },
    {
      key: "fact-format",
      title: "Saffron Archive format",
      body: "The archive endpoint returns signed reports in the saffron envelope.",
      kind: "observation",
      roomKey: "facts",
      sessionID: "ses-facts",
      boundaryID: "boundary-facts",
    },
    {
      key: "scope-target",
      title: "Boundary beacon",
      body: "Scope beacon boundary seal belongs to the selected session and is safe to retrieve.",
      kind: "fact",
      roomKey: "scope-a",
      sessionID: "ses-scope-a",
      boundaryID: "boundary-a",
    },
    {
      key: "scope-wrong-boundary",
      title: "Boundary beacon from another boundary",
      body: "Scope beacon boundary seal belongs to a different boundary and must not be retrieved.",
      kind: "observation",
      roomKey: "scope-b",
      sessionID: "ses-scope-a",
      boundaryID: "boundary-b",
    },
    {
      key: "scope-wrong-session",
      title: "Boundary beacon from another session",
      body: "Scope beacon boundary seal belongs to a different session and must not be retrieved.",
      kind: "observation",
      roomKey: "scope-b",
      sessionID: "ses-scope-b",
      boundaryID: "boundary-a",
    },
  ]
}

function makeCorpus(): readonly CorpusSpec[] {
  const distractors = Array.from({ length: DISTRACTOR_COUNT }, (_, index) => {
    const number = String(index).padStart(3, "0")
    const marker = String((index * 17) % 97).padStart(2, "0")
    return {
      key: `distractor-${number}`,
      title: `Drawer filler ${number}`,
      body: `distractor-${number} marker-${marker} ledger-${number} retained for corpus pressure`,
      kind: "note" as const,
      roomKey: "distractors",
      sessionID: "ses-distractors",
      boundaryID: "boundary-distractors",
    }
  })
  return [...distractors, ...authoredCorpus()]
}

function makeQueries(): readonly QueryCase[] {
  return [
    {
      name: "multi-hop relation",
      query: "How does Cobalt Relay connect to Glacier Cache?",
      goldKeys: ["multi-source", "multi-bridge", "multi-destination"],
    },
    {
      name: "local timeline",
      query: "What happened after the Violet Switch migration?",
      goldKeys: ["local-before", "local-symptom", "local-repair"],
    },
    {
      name: "code path",
      query: "Where is SessionRunnerLLM defined in packages/core/src/session/runner/llm.ts?",
      goldKeys: ["code-definition", "code-followup"],
    },
    {
      name: "security chain",
      query: "What security fix addressed CVE-2026-4242?",
      goldKeys: ["security-cve", "security-rotation", "security-audit"],
    },
    {
      name: "fact and URL",
      query: "Where does Saffron Archive publish reports?",
      goldKeys: ["fact-source", "fact-format"],
    },
    {
      name: "scoped room",
      query: "scope beacon boundary seal",
      goldKeys: ["scope-target"],
      roomKey: "scope-a",
    },
  ]
}

function provenanceFor(spec: CorpusSpec): Memory.Provenance {
  return {
    assertedBy: "benchmark",
    source: "agent",
    sessionID: spec.sessionID,
  }
}

function makeTrace(entry: CorpusEntry): ZeroMem.TraceUnit {
  return {
    id: entry.drawer.id,
    text: [entry.drawer.title, entry.drawer.body, entry.drawer.anchor.path, entry.drawer.anchor.symbol]
      .filter(Boolean)
      .join("\n"),
    timestamp: entry.drawer.timeCreated,
    boundaryID: entry.spec.boundaryID,
    ...(entry.drawer.provenance.sessionID === undefined ? {} : { sessionID: entry.drawer.provenance.sessionID }),
    metadata: {
      title: entry.drawer.title,
      body: entry.drawer.body,
      boundaryID: entry.spec.boundaryID,
    },
    scopeID: entry.drawer.roomID,
  }
}

function requireEntry(entries: ReadonlyMap<string, CorpusEntry>, key: string): CorpusEntry {
  const entry = entries.get(key)
  if (entry === undefined) throw new Error(`Benchmark corpus is missing ${key}`)
  return entry
}

function resolveQueries(
  queries: readonly QueryCase[],
  entries: ReadonlyMap<string, CorpusEntry>,
  rooms: ReadonlyMap<string, Memory.Room>,
): readonly QueryPlan[] {
  return queries.map((query) => {
    const goldIDs = query.goldKeys.map((key) => requireEntry(entries, key).drawer.id)
    const scopeRoom = query.roomKey === undefined ? undefined : rooms.get(query.roomKey)
    if (query.roomKey !== undefined && scopeRoom === undefined) {
      throw new Error(`Benchmark query ${query.name} names an unknown room ${query.roomKey}`)
    }
    const allowedIDs =
      query.roomKey === undefined
        ? undefined
        : new Set(
            [...entries.values()]
              .filter((entry) => entry.spec.roomKey === query.roomKey)
              .map((entry) => entry.drawer.id),
          )
    return {
      ...query,
      goldIDs,
      ...(scopeRoom === undefined ? {} : { scopeRoomID: scopeRoom.id }),
      ...(allowedIDs === undefined ? {} : { allowedIDs }),
    }
  })
}

function coreSearchInput(plan: QueryPlan, wingID: Memory.WingID): Memory.SearchInput {
  return {
    query: plan.query,
    wings: [wingID],
    limit: TOP_K,
    ...(plan.scopeRoomID === undefined ? {} : { rooms: [plan.scopeRoomID] }),
  }
}

function zeroSearchInput(plan: QueryPlan): ZeroMem.Query {
  return {
    query: plan.query,
    topK: TOP_K,
    ...(plan.scopeRoomID === undefined ? {} : { scopeID: plan.scopeRoomID }),
  }
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`sanity invariant failed: ${message}`)
}

function checkCoreResults(
  plan: QueryPlan,
  results: readonly Memory.Result[],
  ids: readonly string[],
  corpusIDs: ReadonlySet<string>,
): void {
  for (const id of ids) invariant(corpusIDs.has(id), `${plan.name} Core returned unknown drawer ${id}`)
  if (plan.allowedIDs === undefined) return
  for (const result of results) {
    invariant(plan.allowedIDs.has(result.drawer.id), `${plan.name} Core leaked drawer ${result.drawer.id}`)
    invariant(result.drawer.roomID === plan.scopeRoomID, `${plan.name} Core escaped room scope`)
  }
}

function checkZeroResults(
  plan: QueryPlan,
  results: readonly ZeroMem.Result[],
  ids: readonly string[],
  corpusIDs: ReadonlySet<string>,
): void {
  for (const id of ids) invariant(corpusIDs.has(id), `${plan.name} Zero-Mem returned unknown trace ${id}`)
  if (plan.allowedIDs !== undefined) {
    for (const result of results) {
      invariant(plan.allowedIDs.has(result.trace.id), `${plan.name} Zero-Mem leaked trace ${result.trace.id}`)
      invariant(result.trace.scopeID === plan.scopeRoomID, `${plan.name} Zero-Mem escaped room scope`)
    }
  }
}

function scoreResults(resultIDs: readonly string[], goldIDs: readonly string[]) {
  const gold = new Set(goldIDs)
  const found = new Set(resultIDs)
  const relevant = goldIDs.filter((id) => found.has(id)).length
  const first = resultIDs.findIndex((id) => gold.has(id))
  return {
    recall: relevant / goldIDs.length,
    precision: relevant / TOP_K,
    mrr: first < 0 ? 0 : 1 / (first + 1),
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))
  return sorted[rank] ?? 0
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function rounded(value: number): number {
  return Number(value.toFixed(3))
}

function summarize(samples: readonly Sample[]): ArmSummary {
  return {
    p50Ms: rounded(
      percentile(
        samples.map((sample) => sample.latencyMs),
        0.5,
      ),
    ),
    p95Ms: rounded(
      percentile(
        samples.map((sample) => sample.latencyMs),
        0.95,
      ),
    ),
    recallAtK: rounded(average(samples.map((sample) => sample.recall))),
    precisionAtK: rounded(average(samples.map((sample) => sample.precision))),
    mrr: rounded(average(samples.map((sample) => sample.mrr))),
    meanResultCount: rounded(average(samples.map((sample) => sample.resultCount))),
  }
}

function printSummary(summary: BenchmarkSummary): void {
  console.log("ZERO-MEM RETRIEVAL BENCHMARK")
  console.log("")
  console.log("Drawer-as-trace retrieval only; this is not a full LoCoMo/HotpotQA reproduction.")
  console.log("Zero-Mem arm: deterministic regex entities plus BM25 lexical proxy; no LLM or network.")
  console.log(
    `Corpus: ${summary.corpus.totalDrawers} drawers (${summary.corpus.distractors} distractors, ${summary.corpus.authoredTraces} authored traces)`,
  )
  console.log(
    `Runs: ${summary.config.runs} after ${summary.config.warmupQueries} warm-up queries; K=${summary.config.topK}`,
  )
  console.log("")

  console.log("BUILD / INDEX")
  console.log(
    `  ${"system".padEnd(12)}${"write/ingest ms".padStart(18)}${"index/rebuild ms".padStart(19)}${"indexed".padStart(10)}`,
  )
  console.log(
    `  ${"Core Memory".padEnd(12)}${summary.build.core.writeMs.toFixed(3).padStart(18)}${summary.build.core.indexMs.toFixed(3).padStart(19)}${String(summary.build.core.indexedDrawers).padStart(10)}`,
  )
  console.log(
    `  ${"Zero-Mem".padEnd(12)}${summary.build.zeroMem.ingestMs.toFixed(3).padStart(18)}${summary.build.zeroMem.rebuildMs.toFixed(3).padStart(19)}${String(summary.build.zeroMem.stats.traceCount).padStart(10)}`,
  )
  console.log("")

  console.log("QUERY METRICS (warm-up excluded)")
  console.log(
    `  ${"query".padEnd(26)}${"arm".padEnd(13)}${"p50 ms".padStart(10)}${"p95 ms".padStart(10)}${"recall@K".padStart(11)}${"prec@K".padStart(10)}${"MRR".padStart(8)}${"results".padStart(10)}`,
  )
  for (const query of summary.queries) {
    for (const [arm, metrics] of [
      ["Core Memory", query.core],
      ["Zero-Mem", query.zeroMem],
    ] as const) {
      console.log(
        `  ${query.name.padEnd(26)}${arm.padEnd(13)}${metrics.p50Ms.toFixed(3).padStart(10)}${metrics.p95Ms.toFixed(3).padStart(10)}${metrics.recallAtK.toFixed(3).padStart(11)}${metrics.precisionAtK.toFixed(3).padStart(10)}${metrics.mrr.toFixed(3).padStart(8)}${metrics.meanResultCount.toFixed(3).padStart(10)}`,
      )
    }
  }
  console.log("")
  console.log("AGGREGATE")
  for (const [arm, metrics] of [
    ["Core Memory", summary.aggregate.core],
    ["Zero-Mem", summary.aggregate.zeroMem],
  ] as const) {
    console.log(
      `  ${arm.padEnd(13)}p50=${metrics.p50Ms.toFixed(3)} ms  p95=${metrics.p95Ms.toFixed(3)} ms  recall@K=${metrics.recallAtK.toFixed(3)}  prec@K=${metrics.precisionAtK.toFixed(3)}  MRR=${metrics.mrr.toFixed(3)}  results=${metrics.meanResultCount.toFixed(3)}`,
    )
  }
  console.log("")
  console.log("JSON SUMMARY")
  console.log(JSON.stringify(summary, null, 2))
}

async function main(): Promise<void> {
  if (process.env["FORGE_DB"] !== ":memory:") {
    throw new Error("Run this benchmark from packages/core with FORGE_DB=:memory:")
  }
  const runs = readRuns()
  const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Memory.node]))
  const summary = await Effect.runPromise(
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const wing = yield* memory.wing({ kind: "project", key: "zero-mem-benchmark", name: "Zero-Mem benchmark" })
      const corpus = makeCorpus()
      const roomKeys = [...new Set(corpus.map((spec) => spec.roomKey))].sort()
      const roomValues = yield* Effect.forEach(
        roomKeys,
        (roomKey) => memory.room({ wingID: wing.id, slug: roomKey, name: `Benchmark ${roomKey}` }),
        { concurrency: 1 },
      )
      const rooms = new Map(roomValues.map((room) => [room.slug, room]))

      const coreWriteStart = performance.now()
      const drawers = yield* Effect.forEach(
        corpus,
        (spec) =>
          memory.write({
            wingID: wing.id,
            roomID: rooms.get(spec.roomKey)!.id,
            kind: spec.kind,
            title: spec.title,
            body: spec.body,
            provenance: provenanceFor(spec),
            validFrom: CORPUS_TIME,
            ...(spec.anchor === undefined ? {} : { anchor: spec.anchor }),
          }),
        { concurrency: 1 },
      )
      const coreWriteMs = performance.now() - coreWriteStart
      const entries = new Map<string, CorpusEntry>(
        corpus.map((spec, index) => [spec.key, { spec, drawer: drawers[index]! }]),
      )
      const corpusIDs = new Set(drawers.map((drawer) => drawer.id))

      const coreIndexStart = performance.now()
      const indexedDrawers = yield* memory.reindex()
      const coreIndexMs = performance.now() - coreIndexStart

      const traces = [...entries.values()].map(makeTrace)
      const zeroMem = ZeroMem.create({ topK: TOP_K, windowSize: 8, localRadius: 2, graphHops: 2 })
      const zeroIngestStart = performance.now()
      zeroMem.upsert(traces)
      const zeroIngestMs = performance.now() - zeroIngestStart
      const zeroRebuildStart = performance.now()
      const zeroStats = zeroMem.rebuild()
      const zeroRebuildMs = performance.now() - zeroRebuildStart

      const plans = resolveQueries(makeQueries(), entries, rooms)
      const samples = new Map<string, { readonly core: Sample[]; readonly zeroMem: Sample[] }>(
        plans.map((plan) => [plan.name, { core: [], zeroMem: [] }]),
      )

      // Warm both query paths once before collecting latency samples.
      for (const plan of plans) {
        const warmCore = yield* memory.search(coreSearchInput(plan, wing.id))
        const warmCoreIDs = warmCore.map((result) => result.drawer.id)
        checkCoreResults(plan, warmCore, warmCoreIDs, corpusIDs)
        const warmZero = zeroMem.search(zeroSearchInput(plan))
        const warmZeroIDs = warmZero.map((result) => result.trace.id)
        checkZeroResults(plan, warmZero, warmZeroIDs, corpusIDs)
      }

      for (let run = 0; run < runs; run += 1) {
        for (const plan of plans) {
          const coreStart = performance.now()
          const coreResults = yield* memory.search(coreSearchInput(plan, wing.id))
          const coreLatencyMs = performance.now() - coreStart
          const coreIDs = coreResults.map((result) => result.drawer.id)
          checkCoreResults(plan, coreResults, coreIDs, corpusIDs)
          const coreScore = scoreResults(coreIDs, plan.goldIDs)

          const zeroStart = performance.now()
          const zeroResults = zeroMem.search(zeroSearchInput(plan))
          const zeroLatencyMs = performance.now() - zeroStart
          const zeroIDs = zeroResults.map((result) => result.trace.id)
          checkZeroResults(plan, zeroResults, zeroIDs, corpusIDs)
          const zeroScore = scoreResults(zeroIDs, plan.goldIDs)

          const querySamples = samples.get(plan.name)!
          querySamples.core.push({
            latencyMs: coreLatencyMs,
            resultCount: coreResults.length,
            ...coreScore,
          })
          querySamples.zeroMem.push({
            latencyMs: zeroLatencyMs,
            resultCount: zeroResults.length,
            ...zeroScore,
          })
        }
      }

      const queries = plans.map((plan) => {
        const querySamples = samples.get(plan.name)!
        return {
          name: plan.name,
          query: plan.query,
          goldEvidenceIDs: plan.goldIDs,
          ...(plan.roomKey === undefined
            ? {}
            : {
                scope: {
                  roomKey: plan.roomKey,
                },
              }),
          core: summarize(querySamples.core),
          zeroMem: summarize(querySamples.zeroMem),
        }
      })
      const allCore = plans.flatMap((plan) => samples.get(plan.name)!.core)
      const allZero = plans.flatMap((plan) => samples.get(plan.name)!.zeroMem)
      return {
        benchmark: "Core Memory SQLite/FTS vs plugin Zero-Mem",
        corpus: {
          distractors: DISTRACTOR_COUNT,
          authoredTraces: corpus.length - DISTRACTOR_COUNT,
          totalDrawers: corpus.length,
        },
        config: {
          database: process.env["FORGE_DB"]!,
          runs,
          topK: TOP_K,
          warmupQueries: plans.length,
        },
        build: {
          core: {
            writeMs: rounded(coreWriteMs),
            indexMs: rounded(coreIndexMs),
            indexedDrawers,
          },
          zeroMem: {
            ingestMs: rounded(zeroIngestMs),
            rebuildMs: rounded(zeroRebuildMs),
            stats: zeroStats,
          },
        },
        queries,
        aggregate: {
          core: summarize(allCore),
          zeroMem: summarize(allZero),
        },
      } satisfies BenchmarkSummary
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
  printSummary(summary)
}

await main()
