#!/usr/bin/env bun
/**
 * Cost and partial/unavailable rate of `GitFingerprint.capture` on real worktrees.
 *
 * Captures each repository `BENCH_RUNS` times (default 3) with default limits, or with
 * `timeoutMs` overridden by `BENCH_TIMEOUT_MS`, and prints one JSON line per run plus a
 * summary line per repository. Partial-completeness sample paths are printed only for
 * repositories under the scratch root (synthetic or public clones), never for the user's own.
 *
 * Run from packages/core (macOS only):
 *   BENCH_SCRATCH=<dir> bun test/benchmark/git-fingerprint.ts <worktree> [<worktree>...]
 */
import os from "os"
import path from "path"
import { performance } from "node:perf_hooks"
import { readdir, realpath } from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { GitFingerprint } from "@turenlabs/core/git-fingerprint"

const runs = Number(process.env.BENCH_RUNS ?? 3)
const timeoutMs = process.env.BENCH_TIMEOUT_MS ? Number(process.env.BENCH_TIMEOUT_MS) : undefined
const scratch = path.resolve(process.env.BENCH_SCRATCH ?? path.join(os.tmpdir(), "fingerprint-bench"))
const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error("usage: bun test/benchmark/git-fingerprint.ts <worktree> [<worktree>...]")
  process.exit(2)
}

const layer = LayerNode.compile(GitFingerprint.node)

console.log(
  JSON.stringify({
    kind: "environment",
    platform: process.platform,
    release: os.release(),
    bun: Bun.version,
    git: git(process.cwd(), ["version"]).trim(),
    runs,
    limits: { ...GitFingerprint.Limits, ...(timeoutMs ? { timeoutMs } : {}) },
  }),
)

for (const target of targets) {
  const repository = await locate(target)
  if (!repository) {
    console.log(JSON.stringify({ kind: "skip", label: path.basename(target), reason: "not a git worktree" }))
    continue
  }
  const label = path.basename(repository.worktree)
  // Only clones placed under the benchmark scratch root are public/synthetic and may show sample paths.
  const shareable = repository.worktree.startsWith((await realpath(scratch).catch(() => scratch)) + "/")
  const context = { kind: "context", label, ...tracked(repository.worktree) }
  console.log(JSON.stringify(context))

  const results = []
  for (const run of Array.from({ length: runs }, (_, index) => index + 1)) {
    const start = performance.now()
    const result = await Effect.gen(function* () {
      const fingerprint = yield* GitFingerprint.Service
      return yield* fingerprint.capture({
        repository,
        scratch,
        ...(timeoutMs ? { limits: { timeoutMs } } : {}),
      })
    }).pipe(Effect.provide(layer), Effect.runPromise)
    const ms = Math.round(performance.now() - start)
    const line =
      result.status === "unavailable"
        ? { kind: "run", label, run, status: result.status, reason: result.reason, ms }
        : {
            kind: "run",
            label,
            run,
            status: result.status,
            completeness: result.completeness.state,
            ...(result.completeness.state === "partial"
              ? {
                  reasons: result.completeness.reasons,
                  excluded: result.completeness.excluded,
                  ...(shareable ? { samples: result.completeness.samples } : {}),
                }
              : { excluded: 0 }),
            entries: result.entries,
            readBytes: result.readBytes,
            ms,
          }
    results.push(line)
    console.log(JSON.stringify(line))
  }

  const times = results.map((item) => item.ms).toSorted((a, b) => a - b)
  console.log(
    JSON.stringify({
      kind: "summary",
      label,
      statuses: [
        ...new Set(results.map((item) => ("reason" in item ? `unavailable:${item.reason}` : item.completeness))),
      ],
      medianMs: times[Math.floor(times.length / 2)],
      minMs: times[0],
      maxMs: times[times.length - 1],
    }),
  )
}

// Captures must remove their own per-capture scratch directories.
const leftover = (await readdir(scratch).catch(() => [] as string[])).filter((name) => name.startsWith("cap-"))
console.log(JSON.stringify({ kind: "scratch", leftoverCaptureDirectories: leftover.length }))

async function locate(target: string) {
  const worktree = await realpath(path.resolve(target)).catch(() => undefined)
  if (!worktree) return undefined
  const output = Bun.spawnSync(
    ["git", "rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
    { cwd: worktree, stdout: "pipe", stderr: "ignore" },
  )
  if (output.exitCode !== 0) return undefined
  const lines = output.stdout.toString("utf8").split("\n").filter(Boolean)
  if (lines.length !== 2) return undefined
  return {
    worktree,
    gitDirectory: await realpath(lines[0]!),
    commonDirectory: await realpath(lines[1]!),
  }
}

/** Tracked index paths and HEAD tree blob count/bytes, for scale context only. */
function tracked(worktree: string) {
  const index = git(worktree, ["ls-files", "-z"]).split("\0").filter(Boolean).length
  const tree = git(worktree, ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"])
    .split("\0")
    .filter(Boolean)
    .map((record) => record.slice(0, record.indexOf("\t")).split(/\s+/))
    .filter((fields) => fields[1] === "blob")
  return {
    trackedPaths: index,
    headBlobs: tree.length,
    headBlobBytes: tree.reduce((total, fields) => total + Number(fields[3]), 0),
  }
}

function git(cwd: string, args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" }).stdout.toString("utf8")
}
