// debug: what does the corpus thesaurus expand hard query terms to?
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { Potion } from "../src/potion"

const REPO = path.resolve(import.meta.dir, "../../..")
const CACHE = path.join(REPO, "packages/plugin/.cache/embed")
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILE_LINES = 4000
const CHUNK_LINES = 100
const CHUNK_STEP = 100

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".sql", ".toml", ".yaml", ".yml", ".sh",
  ".md", ".css", ".html", ".vue", ".svelte", ".zig", ".swift", ".kt",
])
const EXCLUDE =
  /(^|\/)node_modules\/|\/dist\/|src\/generated|resources\/licenses|test\/fixtures|__snapshots__|\.snap$|bun\.lock$|\.min\.js$|\.wasm$|\.d\.ts$/i
const STOP = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "when", "what", "how",
  "does", "are", "all", "its", "their", "them", "they", "you", "your", "our", "can",
  "not", "but", "use", "used", "using", "via", "per", "each", "any", "one", "two",
])

function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

// vocab with df over chunks
const ls = spawnSync("git", ["ls-files"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
const files = ls.stdout
  .toString()
  .split("\n")
  .filter((f) => f && EXTENSIONS.has(path.extname(f)) && !EXCLUDE.test(f))
  .filter((f) => existsSync(path.join(REPO, f)) && statSync(path.join(REPO, f)).size <= MAX_FILE_BYTES)

const df = new Map<string, number>()
let nChunks = 0
for (const file of files) {
  let text: string
  try { text = readFileSync(path.join(REPO, file), "utf8") } catch { continue }
  if (text.includes("\0")) continue
  const lines = text.split("\n").slice(0, MAX_FILE_LINES)
  for (let start = 0; start < lines.length; start += CHUNK_STEP) {
    const seen = new Set(terms(lines.slice(start, start + CHUNK_LINES).join("\n")))
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
    nChunks++
    if (start + CHUNK_LINES >= lines.length) break
  }
}
const vocab = [...df.keys()].filter((t) => {
  const d = df.get(t)!
  return t.length >= 3 && !STOP.has(t) && d >= 3 && d <= nChunks * 0.1
})
console.log(`vocab: ${vocab.length} terms over ${nChunks} chunks`)

const runtime = await Potion.load({ cacheDir: CACHE })
const dim = runtime.profile.dimension
const termVecs = new Float32Array(vocab.length * dim)
for (let i = 0; i < vocab.length; i += 512) {
  const embedded = runtime.embed(vocab.slice(i, i + 512))
  for (const [j, v] of embedded.entries()) {
    const off = (i + j) * dim
    termVecs.set(v, off)
    let n2 = 0
    for (let d = 0; d < dim; d++) n2 += termVecs[off + d]! ** 2
    const norm = Math.sqrt(n2) || 1
    for (let d = 0; d < dim; d++) termVecs[off + d]! /= norm
  }
}

function neighbors(w: string, k = 20) {
  const v = runtime.embed([w])[0]!
  let n2 = 0
  for (let d = 0; d < dim; d++) n2 += v[d]! * v[d]!
  const qn = Math.sqrt(n2) || 1
  const scores = vocab.map((t, i) => {
    let dot = 0
    const off = i * dim
    for (let d = 0; d < dim; d++) dot += termVecs[off + d]! * v[d]!
    return [t, dot / qn] as const
  })
  return scores.sort((a, b) => b[1] - a[1]).slice(0, k)
}

for (const w of ["integrity", "approves", "permission", "loop", "checksum", "artifact", "download"]) {
  console.log(`${w}: ${neighbors(w).map(([t, s]) => `${t}(${s.toFixed(2)})`).join(" ")}`)
}
console.log("\n--- phrase centroids ---")
for (const q of [
  "verify downloaded artifact integrity before caching",
  "who approves or denies a tool call before it runs",
  "detect when the agent keeps repeating the same tool calls",
]) {
  console.log(`${q}\n  ${neighbors(q).map(([t, s]) => `${t}(${s.toFixed(2)})`).join(" ")}`)
}
await runtime.close()
