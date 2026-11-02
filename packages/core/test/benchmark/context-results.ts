/**
 * Offline architecture probe, not an agent-quality or billed-token benchmark.
 * Run from packages/core: bun run test/benchmark/context-results.ts [report.json]
 * Uses the legacy output spool, Memory FTS5 and CodeMode with deterministic data.
 * Native retained-result integration is covered separately by tool-results.test.ts.
 * No model calls, embeddings, production database or production code changes.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await mkdtemp(path.join(os.tmpdir(), "turenos-context-results-"))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.XDG_CACHE_HOME = path.join(root, "cache")

try {
  const { CodeMode, Tool } = await import("@turenlabs/codemode")
  const { ToolOutput } = await import("@turenlabs/llm")
  const { Effect, Schema } = await import("effect")
  const { Database } = await import("../../src/database/database")
  const { AppNodeBuilder } = await import("../../src/effect/app-node-builder")
  const { LayerNode } = await import("../../src/effect/layer-node")
  const { Global } = await import("../../src/global")
  const { Memory } = await import("../../src/memory")
  const { SessionSchema } = await import("../../src/session/schema")
  const { ToolOutputStore } = await import("../../src/tool-output-store")

  const rows = Array.from({ length: 2_048 }, (_, index) => ({
    id: `row-${index}`,
    status: index % 64 === 0 ? "failed" : "passed",
    amount: index + 1,
    detail: index === 1_024 ? "MIDDLE_EVIDENCE_4271" : "payload ".repeat(16),
  }))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ToolOutputStore.Service
      const memory = yield* Memory.Service
      const original = JSON.stringify(rows, null, 2)
      const bounded = yield* store.bound({
        sessionID: SessionSchema.ID.make("ses_context_results_probe"),
        toolCallID: "call-large-result",
        output: { structured: rows, content: [] },
      })
      const visible = ToolOutput.toResultValue(bounded.output)
      assert.equal(visible.type, "text")
      assert.equal(bounded.outputPaths.length, 1)
      const retained = yield* Effect.promise(() => Bun.file(bounded.outputPaths[0]!).text())
      assert.equal(retained, original)
      assert.equal(String(visible.value).includes("MIDDLE_EVIDENCE_4271"), false)
      assert.equal(retained.includes("MIDDLE_EVIDENCE_4271"), true)

      const projected = yield* store.bound({
        sessionID: SessionSchema.ID.make("ses_context_results_probe"),
        toolCallID: "call-projected-result",
        output: { structured: rows, content: [{ type: "text", text: "2048 rows; 32 failures." }] },
      })
      assert.equal(projected.outputPaths.length, 0)
      assert.deepEqual(projected.output.structured, rows)

      const wing = yield* memory.wing({ kind: "project", key: "probe", name: "Probe" })
      const other = yield* memory.wing({ kind: "project", key: "other", name: "Other" })
      const room = yield* memory.room({ wingID: wing.id, slug: "results", name: "Results" })
      const otherRoom = yield* memory.room({ wingID: other.id, slug: "results", name: "Results" })
      const concepts = [
        {
          body: "Semaphore permits are exhausted; callers wait until release.",
          exact: "semaphore permits",
          paraphrase: "concurrency limiter starvation",
        },
        {
          body: "HTTP 429 Retry-After: quota exhausted.",
          exact: "HTTP 429",
          paraphrase: "rate limiting request throttle",
        },
        { body: "EACCES: chmod owner mode bits.", exact: "EACCES chmod", paraphrase: "filesystem access denied" },
      ]
      const retrieval = yield* Effect.forEach(concepts, (concept, index) =>
        Effect.gen(function* () {
          const drawer = yield* memory.write({
            wingID: wing.id,
            roomID: room.id,
            title: `Diagnostic ${index}`,
            body: concept.body,
            provenance: { assertedBy: "offline-probe", source: "agent" },
          })
          const exact = yield* memory.search({ query: concept.exact, wings: [wing.id], limit: 3 })
          const paraphrase = yield* memory.search({ query: concept.paraphrase, wings: [wing.id], limit: 3 })
          const read = yield* memory.read({ id: drawer.id, wings: [wing.id] })
          assert.equal(read?.body, concept.body)
          return {
            exactQuery: concept.exact,
            paraphraseQuery: concept.paraphrase,
            exactFoundTarget: exact.some((hit) => hit.drawer.id === drawer.id),
            paraphraseFoundTarget: paraphrase.some((hit) => hit.drawer.id === drawer.id),
          }
        }),
      )
      assert.equal(retrieval.filter((item) => item.exactFoundTarget).length, 3)
      assert.equal(retrieval.filter((item) => item.paraphraseFoundTarget).length, 0)

      yield* Effect.forEach(
        rows.filter((row) => row.status === "failed"),
        (row) =>
          memory.write({
            wingID: wing.id,
            roomID: room.id,
            title: "Job failure",
            body: `${row.id}: status failed; amount ${row.amount}`,
            provenance: { assertedBy: "offline-probe", source: "agent" },
          }),
      )
      const topHits = yield* memory.search({ query: "failed", wings: [wing.id], limit: 3 })
      assert.equal(topHits.length, 3)
      yield* memory.write({
        wingID: other.id,
        roomID: otherRoom.id,
        title: "Private marker",
        body: "compartment_secret_42",
        provenance: { assertedBy: "offline-probe", source: "agent" },
      })
      assert.equal((yield* memory.search({ query: "compartment_secret_42", wings: [wing.id] })).length, 0)
      assert.equal((yield* memory.search({ query: "compartment_secret_42", wings: [other.id] })).length, 1)

      const calls: string[] = []
      const runtime = CodeMode.make({
        tools: {
          data: {
            rows: Tool.make({
              description: "Read the deterministic result fixture",
              input: Schema.Struct({}),
              output: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  status: Schema.String,
                  amount: Schema.Number,
                  detail: Schema.String,
                }),
              ),
              run: () => Effect.succeed(rows),
            }),
          },
        },
        limits: { timeoutMs: 5_000, maxToolCalls: 1, maxOutputBytes: 1_024 },
        onToolCallEnd: (call) =>
          Effect.sync(() => {
            calls.push(call.name)
          }),
      })
      // Warm the compiler separately; elapsed time below is a local execution sample only.
      assert.equal((yield* runtime.execute("return null")).ok, true)
      const code = [
        "const rows = await tools.data.rows({})",
        'const failed = rows.filter(row => row.status === "failed")',
        "return { count: failed.length, sum: failed.reduce((sum, row) => sum + row.amount, 0), ids: failed.slice(0, 3).map(row => row.id) }",
      ].join(";\n")
      const started = performance.now()
      const computed = yield* runtime.execute(code)
      const elapsed = performance.now() - started
      if (!computed.ok) throw new Error(computed.error.message)
      assert.deepEqual(computed.value, { count: 32, sum: 31_776, ids: ["row-0", "row-64", "row-128"] })
      assert.notEqual(computed.truncated, true)
      assert.deepEqual(calls, ["data.rows"])

      const unfiltered = yield* runtime.execute("return await tools.data.rows({})")
      assert.equal(unfiltered.ok, true)
      assert.equal(unfiltered.truncated, true)

      return {
        version: 1,
        scope: "Deterministic offline probes; byte sizes, not token costs or model accuracy",
        runtime: { bun: Bun.version, platform: process.platform, architecture: process.arch },
        limitations: [
          "Programs and queries are hand-written; model tool selection and generated code are not evaluated.",
          "Retrieval uses Memory lexical search only; its semantic layer is not loaded.",
          "Byte sizes exclude provider tokenization, inference, retries, caching and storage/index overhead.",
          "CodeMode calls a fixture host tool; V2 retention and CodeMode adapters are not implemented by this probe.",
        ],
        retention: {
          rawBytes: Buffer.byteLength(original),
          previewBytes: Buffer.byteLength(String(visible.value)),
          middleEvidenceInPreview: false,
          exactReadbackMatches: true,
          projectedModelBytes: Buffer.byteLength(JSON.stringify(ToolOutput.toResultValue(projected.output))),
          projectedStructuredBytes: Buffer.byteLength(JSON.stringify(projected.output.structured)),
          projectedManagedFiles: projected.outputPaths.length,
        },
        retrieval,
        enumeration: { matchingRows: 32, rankedSearchRows: topHits.length, searchIsExhaustive: false },
        isolation: { foreignWingHits: 0, owningWingHits: 1 },
        codeMode: {
          value: computed.value,
          programBytes: Buffer.byteLength(code),
          resultEnvelopeBytes: Buffer.byteLength(JSON.stringify(computed)),
          catalogBytes: Buffer.byteLength(runtime.instructions()),
          processingMs: Math.round(elapsed * 100) / 100,
          toolCalls: 1,
          truncated: computed.truncated ?? false,
          unfilteredResultTruncated: unfiltered.truncated,
        },
      }
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([ToolOutputStore.nodeWithoutConfig, Memory.node]), [
          [Global.node, Global.layerWith({ data: root })],
          [Database.node, Database.layerFromPath(":memory:")],
        ]),
      ),
      Effect.scoped,
    ),
  )
  if (process.argv[2]) await Bun.write(process.argv[2], JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
