import { applyPatch, createTwoFilesPatch, diffLines, formatPatch, structuredPatch } from "diff"
import { formatPatchDiff } from "../../src/tool/apply-patch-diff"

// From packages/core: bun run test/benchmark/apply-patch.ts current|single|candidate sparse|dense|repo
const [mode, fixture] = process.argv.slice(2)
if (mode !== "current" && mode !== "single" && mode !== "candidate") throw new Error("Choose a diff mode")
if (fixture !== "sparse" && fixture !== "dense" && fixture !== "repo") throw new Error("Choose a fixture")

function atRevision(revision: string) {
  const result = Bun.spawnSync(["git", "show", `${revision}:packages/core/src/patch.ts`])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

const lines = Array.from({ length: 1500 }, (_, index) => `line ${index}: const value = ${index * 7};\n`)
const stride = fixture === "sparse" ? 377 : 2
const before = fixture === "repo" ? atRevision("04129b62^") : lines.join("")
const after =
  fixture === "repo"
    ? atRevision("04129b62")
    : lines.map((line, index) => (index % stride === 0 ? `changed ${index};\n` : line)).join("")
const patchLines = fixture === "repo" ? 476 : Math.ceil(lines.length / stride) * 2
const oldName = "patch.ts"
const newName = oldName
const run = () => {
  if (mode === "candidate") return formatPatchDiff({ before, after, oldName, newName, patchLines })
  if (mode === "single") {
    const diff = structuredPatch(oldName, newName, before, after)
    let additions = 0
    let deletions = 0
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions++
        if (line.startsWith("-")) deletions++
      }
    }
    return { patch: formatPatch(diff), additions, deletions }
  }
  const counts = diffLines(before, after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return { patch: createTwoFilesPatch(oldName, newName, before, after), ...counts }
}

const start = performance.now()
const first = await run()
const cold = performance.now() - start
if (applyPatch(before, first.patch) !== after) throw new Error("Patch did not reproduce the update")
for (let warmup = 0; warmup < 5; warmup++) await run()
const samples = []
for (let sample = 0; sample < 31; sample++) {
  const start = performance.now()
  await run()
  samples.push(performance.now() - start)
}
samples.sort((a, b) => a - b)
console.log({
  mode,
  fixture,
  additions: first.additions,
  deletions: first.deletions,
  firstMs: cold,
  p50Ms: samples[15],
  p95Ms: samples[29],
})
