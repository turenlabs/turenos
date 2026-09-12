/**
 * Benchmark v3: retrieval strategies over the forge codebase.
 *
 * Baselines:   grep    — literal all-terms-present file match, ranked by frequency
 *              lexical — BM25 over 100-line chunks
 *              path    — BM25 over file paths
 *              semantic— potion-base-8M cosine over embedded chunks
 * Channels:    lexstem — BM25 with suffix stemming
 *              symbol  — BM25 over Yolk function docs (name+sig+path, no body)
 *              fnlevel — BM25 over Yolk function docs including body tokens
 *              spread  — fnlevel scores propagated one hop over the naive call graph
 *              prf     — pseudo-relevance feedback: harvest discriminative terms
 *                        from top hits, re-query once
 *              fusion  — file-level blend (chunk + symbol + path)
 *              mq      — fusion over query + author-supplied alt phrasings
 *              nova    — full pipeline: blend(chunk, fnlevel+spread, path) then PRF
 *
 * Usage: bun script/bench-code-search.ts
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Potion } from "../src/potion"
import {
  detectLanguage,
  isKnownUnsupportedSourcePath,
  lexLanguage,
  shouldSkipIndexPath,
} from "../../core/src/yolk/language"
import { parserForLanguage } from "../../core/src/yolk/parsers"
import { parseGoUnit, parseJavaUnit } from "../../core/src/yolk/indexer"

const REPO = path.resolve(import.meta.dir, "../../..")
const CACHE = path.join(homedir(), ".cache", "turenos-code-search-bench")

const CHUNK_LINES = 100
const CHUNK_STEP = 75
const MAX_FILE_LINES = 3_000
const MAX_FILE_BYTES = 300_000
const MAX_BODY_CHARS = 4_000
const MAX_CALLEES_PER_NAME = 20
const SPREAD_DECAY = 0.5
const PRF_DOCS = 6
const PRF_TERMS = 8
const PRF_WEIGHT = 0.5

const W_CHUNK = 0.45
const W_SYMBOL = 0.35
const W_PATH = 0.2

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".sql", ".toml", ".yaml", ".yml", ".sh",
  ".md", ".css", ".html", ".vue", ".svelte", ".zig", ".swift", ".kt",
])
const EXCLUDE =
  /(^|\/)node_modules\/|\/dist\/|src\/generated|resources\/licenses|test\/fixtures|__snapshots__|\.snap$|bun\.lock$|\.min\.js$|\.wasm$|\.d\.ts$/i

const QUERIES: { q: string; expect: string[]; alts?: string[] }[] = [
  { q: "how does ollama model discovery work", expect: ["packages/forge/src/provider/provider.ts"] },
  { q: "generate a session title from the first user message", expect: ["packages/forge/src/session/prompt.ts"] },
  { q: "load the potion embedding model safetensors", expect: ["packages/plugin/src/potion.ts"] },
  { q: "hybrid semantic lexical memory search ranking", expect: ["packages/core/src/memory/semantic.ts"] },
  { q: "grep tool permission assertion", expect: ["packages/core/src/tool/grep.ts"] },
  { q: "spawn durable child subagent session with write roots", expect: ["packages/core/src/tool/subagent.ts"] },
  { q: "settle turn token cost pricing tiers", expect: ["packages/core/src/session/runner/model.ts"] },
  { q: "pick the cheapest small model in the catalog", expect: ["packages/core/src/catalog.ts"] },
  { q: "websocket transport frames for llm routes", expect: ["packages/llm/src/route/transport/websocket.ts"] },
  { q: "anthropic messages sse stream parsing", expect: ["packages/llm/src/protocols/anthropic-messages.ts"] },
  { q: "SessionRunCoordinator joins same session resumes", expect: ["packages/core/src/session/run-coordinator.ts"] },
  { q: "electron mac packaging config notarize", expect: ["packages/desktop/electron-builder.config.ts"] },
  {
    q: "full text search index for memory drawers",
    expect: ["packages/core/src/memory/fts.ts", "packages/core/src/memory/sql.ts"],
  },
  { q: "ripgrep wrapper search file contents", expect: ["packages/core/src/ripgrep.ts"] },
  { q: "tool registry materialization settle output bounding", expect: ["packages/core/src/tool/registry.ts"] },
  // paraphrase queries — key terms don't literally appear in the target
  {
    q: "verify downloaded artifact integrity before caching",
    expect: ["packages/plugin/src/potion.ts"],
    alts: ["sha256 checksum hash mismatch", "ensure cached file verified"],
  },
  { q: "retry a failed provider request with backoff", expect: ["packages/core/src/session/runner/retry.ts"] },
  {
    q: "detect when the agent keeps repeating the same tool calls",
    expect: ["packages/core/src/session/runner/loop-detector.ts"],
    alts: ["loop detector", "repeated identical calls"],
  },
  // structure-shaped queries
  {
    q: "inspect impact of changing a function before editing",
    expect: ["packages/core/src/tool/yolk.ts", "packages/core/src/tool/yolk-analyzer.ts", "packages/core/src/yolk/runtime.ts"],
  },
  { q: "reverse call graph impact of a symbol", expect: ["packages/core/src/yolk/indexer/index.ts"] },
  { q: "wordpiece tokenizer vocabulary lookup", expect: ["packages/plugin/src/potion.ts"] },
  {
    q: "watcher invalidates changed files for the analyzer",
    expect: ["packages/core/src/filesystem/watcher.ts", "packages/core/src/tool/yolk-analyzer.ts"],
  },
  {
    q: "who approves or denies a tool call before it runs",
    expect: ["packages/core/src/permission.ts"],
    alts: ["permission assert allow deny", "ruleset effect"],
  },
  // second batch — broader coverage
  { q: "sse framing decode event stream bytes", expect: ["packages/llm/src/route/framing.ts"] },
  {
    q: "persist and restore window bounds across launches",
    expect: ["packages/desktop/src/main/storage/product.ts", "packages/desktop/src/main/windows.ts"],
  },
  {
    q: "encrypt secrets with an os protected key",
    expect: ["packages/core/src/secret-vault.ts", "packages/desktop/src/main/secret-key.ts"],
  },
  { q: "load AGENTS.md instruction context for the session", expect: ["packages/core/src/instruction-context.ts"] },
  { q: "sync the model catalog from models.dev", expect: ["packages/core/src/plugin/models-dev.ts"] },
  {
    q: "admit a durable session input and wake the drain",
    expect: ["packages/core/src/session/execution/local.ts", "packages/core/src/session/execution-control.ts"],
  },
  { q: "resolve services for a workspace location", expect: ["packages/core/src/location-service-map.ts"] },
  { q: "run a prompt from the command line", expect: ["packages/forge/src/cli/cmd/run.ts"] },
  { q: "register mcp hosted tools from server listing", expect: ["packages/core/src/tool/mcp.ts"] },
  { q: "capture shell command output for the model", expect: ["packages/core/src/tool/bash.ts"] },
  { q: "ask the user a question mid run", expect: ["packages/core/src/tool/question.ts"] },
  { q: "protected files that agents cannot touch", expect: ["packages/core/src/filesystem/protected.ts"] },
  { q: "edit tool apply changes to a file", expect: ["packages/core/src/tool/edit.ts"] },
  // graph-only question: the answer is a caller of an obvious symbol
  { q: "callers of the embed function", expect: ["packages/core/src/memory/semantic.ts"] },
  // non-yolk languages: rust/swift have chunks+paths but zero parser symbols
  {
    q: "sevenz archive decoding implemented in rust",
    expect: ["packages/static-analysis-wasm/source-106/vendor/sevenz-rust/src/decoders.rs"],
    alts: ["7z bzip2 aes decoder stream"],
  },
  {
    q: "heuristics detect packed pe binaries",
    expect: ["packages/static-analysis-wasm/source-106/src/packers.rs"],
    alts: ["aspack themida detect it easy rules"],
  },
  {
    q: "offline source and il extraction from documents",
    expect: ["packages/static-analysis-wasm/source-106/src/document_code.rs"],
    alts: ["document_code extract il source no execution"],
  },
  {
    q: "swift virtualization harness memory limits",
    expect: ["packages/rosetta-harness/Sources/TurenRosettaHarness/main.swift"],
    alts: ["mainactor minimum memory vm boot"],
  },
]

const STOP = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "when", "what", "how",
  "does", "are", "all", "its", "their", "them", "they", "you", "your", "our", "can",
  "not", "but", "use", "used", "using", "via", "per", "each", "any", "one", "two",
])

// --- corpus -----------------------------------------------------------------

type Chunk = { file: string; start: number; text: string }

function collect(): { chunks: Chunk[]; files: string[] } {
  const ls = spawnSync("git", ["ls-files"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
  const files = ls.stdout
    .toString()
    .split("\n")
    .filter((f) => f && EXTENSIONS.has(path.extname(f)) && !EXCLUDE.test(f))
    .filter((f) => {
      const abs = path.join(REPO, f)
      return existsSync(abs) && statSync(abs).size <= MAX_FILE_BYTES
    })
  const chunks: Chunk[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(path.join(REPO, file), "utf8")
    } catch {
      continue
    }
    if (text.includes("\0")) continue
    const lines = text.split("\n").slice(0, MAX_FILE_LINES)
    for (let start = 0; start < lines.length; start += CHUNK_STEP) {
      chunks.push({ file, start, text: lines.slice(start, start + CHUNK_LINES).join("\n") })
      if (start + CHUNK_LINES >= lines.length) break
    }
  }
  return { chunks, files }
}

// --- co-change graph: files that commit together are topically coupled -------

function buildCochange(files: string[]): Map<string, Set<string>> {
  const inCorpus = new Set(files)
  const log = spawnSync(
    "git",
    ["log", "--name-only", "--format=%x00%x00", "-n", "4000", "--no-renames"],
    { cwd: REPO, maxBuffer: 512 * 1024 * 1024 },
  )
  const counts = new Map<string, Map<string, number>>()
  const bump = (a: string, b: string) => {
    const m = counts.get(a) ?? new Map<string, number>()
    m.set(b, (m.get(b) ?? 0) + 1)
    counts.set(a, m)
  }
  for (const rec of log.stdout.toString().split("\0\0")) {
    const fs = [...new Set(rec.split("\n").map((s) => s.trim()).filter((f) => inCorpus.has(f)))]
    if (fs.length > 50) continue // drop squash/import mega-commits
    for (let i = 0; i < fs.length; i++)
      for (let j = i + 1; j < fs.length; j++) {
        bump(fs[i]!, fs[j]!)
        bump(fs[j]!, fs[i]!)
      }
  }
  const graph = new Map<string, Set<string>>()
  for (const [f, m] of counts) {
    const top = [...m.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30)
    if (top.length) graph.set(f, new Set(top.map(([g]) => g)))
  }
  return graph
}

// --- terms ------------------------------------------------------------------

function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

const SUFFIXES = ["ational", "ation", "ingly", "ities", "tion", "ing", "edly", "ed", "ies", "es", "ers", "ors", "er", "or", "ly", "s"]

function stem(t: string): string {
  for (const s of SUFFIXES) {
    if (t.endsWith(s) && t.length - s.length >= 4) {
      t = t.slice(0, -s.length)
      break
    }
  }
  if (t.endsWith("e") && t.length > 4) t = t.slice(0, -1)
  return t
}

// --- BM25 -------------------------------------------------------------------

const K1 = 1.2
const B = 0.75

type LexIndex = {
  docLen: Float32Array
  avgLen: number
  inverted: Map<string, { doc: number; freq: number }[]>
  df: Map<string, number>
  n: number
}

function buildLex(docs: { file: string; text: string }[], stemmed: boolean): LexIndex {
  const docLen = new Float32Array(docs.length)
  const inverted = new Map<string, { doc: number; freq: number }[]>()
  let total = 0
  for (const [i, doc] of docs.entries()) {
    const freq = new Map<string, number>()
    for (const t of terms(`${doc.file}\n${doc.text}`)) {
      const key = stemmed ? stem(t) : t
      freq.set(key, (freq.get(key) ?? 0) + 1)
    }
    docLen[i] = [...freq.values()].reduce((a, b) => a + b, 0)
    total += docLen[i]
    for (const [t, f] of freq) {
      const postings = inverted.get(t)
      if (postings) postings.push({ doc: i, freq: f })
      else inverted.set(t, [{ doc: i, freq: f }])
    }
  }
  const df = new Map([...inverted.entries()].map(([t, p]) => [t, p.length]))
  return { docLen, avgLen: total / Math.max(1, docs.length), inverted, df, n: docs.length }
}

function bm25Weighted(index: LexIndex, qterms: Map<string, number>, idfPower = 1): Float32Array {
  const scores = new Float32Array(index.n)
  for (const [t, w] of qterms) {
    const postings = index.inverted.get(t)
    if (!postings) continue
    const idf = Math.log(1 + (index.n - postings.length + 0.5) / (postings.length + 0.5)) ** idfPower
    for (const { doc, freq } of postings) {
      scores[doc] += (w * idf * (freq * (K1 + 1))) / (freq + K1 * (1 - B + (B * index.docLen[doc]) / index.avgLen))
    }
  }
  return scores
}

function bm25(index: LexIndex, query: string, stemmed: boolean): Float32Array {
  const qterms = new Map<string, number>()
  for (const t of new Set(terms(query).map((x) => (stemmed ? stem(x) : x)))) qterms.set(t, 1)
  return bm25Weighted(index, qterms)
}

// --- helpers ----------------------------------------------------------------

function rankedIdx(scores: Float32Array): number[] {
  return Array.from(scores.keys())
    .filter((i) => scores[i]! > 0)
    .sort((a, b) => scores[b]! - scores[a]!)
}

function normalizeMap<V>(scores: Map<V, number>): Map<V, number> {
  if (scores.size === 0) return scores
  let min = Infinity
  let max = -Infinity
  for (const s of scores.values()) {
    min = Math.min(min, s)
    max = Math.max(max, s)
  }
  const out = new Map<V, number>()
  for (const [k, s] of scores) out.set(k, max === min ? (max === 0 ? 0 : 1) : (s - min) / (max - min))
  return out
}

function docScoresToFiles(scores: Float32Array, fileOf: (i: number) => string): Map<string, number> {
  const out = new Map<string, number>()
  for (const i of rankedIdx(scores)) {
    const f = fileOf(i)
    if ((out.get(f) ?? 0) < scores[i]!) out.set(f, scores[i]!)
  }
  return out
}

function rankFiles(scores: Map<string, number>): string[] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
}

function firstHitFiles(ranking: string[], expect: string[]): number {
  for (const [i, f] of ranking.entries()) if (expect.includes(f)) return i + 1
  return 0
}

function grepRank(files: string[], lexStem: LexIndex, fileOf: (i: number) => string, query: string): string[] {
  const qterms = [...new Set(terms(query).map(stem))]
  const hits = new Map<string, number>()
  const coverage = new Map<string, Set<string>>()
  for (const t of qterms) {
    for (const { doc, freq } of lexStem.inverted.get(t) ?? []) {
      const f = fileOf(doc)
      hits.set(f, (hits.get(f) ?? 0) + freq)
      const cov = coverage.get(f) ?? new Set<string>()
      cov.add(t)
      coverage.set(f, cov)
    }
  }
  void files
  return [...coverage.entries()]
    .filter(([, cov]) => cov.size === qterms.length)
    .sort((a, b) => (hits.get(b[0]) ?? 0) - (hits.get(a[0]) ?? 0))
    .map(([f]) => f)
}

// --- yolk symbol extraction (lexer+parsers only — no e-graph) ---------------

type SymDoc = { file: string; name: string; symbol: string; text: string }
type CallEdge = { caller: number; file: string; receiver: string; calleeName: string }

const CALL_NAME_RE = /^[A-Za-z_$][\w$]*$/
const CALL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "typeof",
  "constructor", "super", "do", "else", "case", "throw", "await", "yield", "in",
])

function extractSymbols(files: string[]): {
  syms: SymDoc[]
  adjacency: Map<number, Set<number>>
  fileGraph: Map<string, Set<string>>
  parsed: Set<string>
} {
  const syms: SymDoc[] = []
  const edges: CallEdge[] = []
  const fileImports = new Map<string, Map<string, string>>()
  for (const file of files) {
    const abs = path.join(REPO, file)
    if (shouldSkipIndexPath(abs) || isKnownUnsupportedSourcePath(abs)) continue
    let raw: Buffer
    try {
      raw = readFileSync(abs)
    } catch {
      continue
    }
    const language = detectLanguage(abs, raw)
    if (!language) continue
    const source = raw.toString("utf8")
    let unit
    try {
      const tokens = lexLanguage(source, language)
      unit =
        language === "go"
          ? parseGoUnit(abs, tokens)
          : language === "java"
            ? parseJavaUnit(abs, tokens)
            : parserForLanguage(REPO, abs, language, source, tokens)
    } catch {
      continue
    }
    fileImports.set(file, unit.imports)
    for (const fn of unit.functions) {
      const idx = syms.length
      const body = fn.body
        .slice(0, 4000)
        .map((t) => t.text)
        .join(" ")
        .slice(0, MAX_BODY_CHARS)
      syms.push({
        file,
        name: fn.name,
        symbol: fn.symbol,
        text: `${fn.symbol} ${fn.name} ${fn.receiver} ${fn.kind} ${fn.params.join(" ")} ${file} ${body}`,
      })
      for (let i = 0; i < fn.body.length - 1; i++) {
        const t = fn.body[i]!.text
        if (!CALL_NAME_RE.test(t) || CALL_SKIP.has(t)) continue
        if (fn.body[i + 1]?.text !== "(") continue
        // receiver pattern: `recv . name (` — the ident two tokens back
        const dot = fn.body[i - 1]?.text === "."
        const receiver = dot && CALL_NAME_RE.test(fn.body[i - 2]?.text ?? "") ? fn.body[i - 2]!.text : ""
        edges.push({ caller: idx, file, receiver, calleeName: t })
      }
    }
  }
  // indexes for resolution
  const byName = new Map<string, number[]>()
  const byNameInFile = new Map<string, number[]>()
  const moduleToFiles = new Map<string, string[]>()
  for (const f of files) {
    const noExt = f.replace(/\.[^.]+$/, "")
    for (const key of [noExt, path.basename(noExt)]) {
      const list = moduleToFiles.get(key) ?? []
      list.push(f)
      moduleToFiles.set(key, list)
    }
  }
  for (const [i, s] of syms.entries()) {
    for (const [map, key] of [
      [byName, s.name],
      [byNameInFile, `${s.file}#${s.name}`],
    ] as const) {
      const list = map.get(key) ?? []
      list.push(i)
      map.set(key, list)
    }
  }
  const symsInModule = (module: string, name: string): number[] | undefined => {
    const files = moduleToFiles.get(module) ?? moduleToFiles.get(module.split("/").at(-1) ?? module)
    if (!files) return
    const out: number[] = []
    for (const f of files) out.push(...(byNameInFile.get(`${f}#${name}`) ?? []))
    return out
  }
  // import-aware resolution: `recv.name(` resolves through recv's imported
  // module; bare `name(` prefers same-file defs, then direct imports, then a
  // capped global name match
  const adjacency = new Map<number, Set<number>>()
  for (const { caller, file, receiver, calleeName } of edges) {
    const imports = fileImports.get(file)
    let targets: number[] | undefined
    if (receiver && imports?.has(receiver)) targets = symsInModule(imports.get(receiver)!, calleeName)
    if (!targets?.length && !receiver) {
      targets = byNameInFile.get(`${file}#${calleeName}`)
      if (!targets?.length && imports?.has(calleeName)) targets = symsInModule(imports.get(calleeName)!, calleeName)
    }
    if (!targets?.length) targets = byName.get(calleeName)
    if (!targets || targets.length > MAX_CALLEES_PER_NAME) continue
    for (const callee of targets) {
      if (callee === caller) continue
      const out = adjacency.get(caller) ?? new Set<number>()
      out.add(callee)
      adjacency.set(caller, out)
      const into = adjacency.get(callee) ?? new Set<number>()
      into.add(caller)
      adjacency.set(callee, into)
    }
  }
  // file-level import graph: f → files it imports, and files importing f
  const fileGraph = new Map<string, Set<string>>()
  for (const [f, imports] of fileImports) {
    for (const module of imports.values()) {
      const targets = moduleToFiles.get(module) ?? moduleToFiles.get(module.split("/").at(-1) ?? module)
      if (!targets) continue
      for (const target of targets) {
        if (target === f) continue
        const out = fileGraph.get(f) ?? new Set<string>()
        out.add(target)
        fileGraph.set(f, out)
        const into = fileGraph.get(target) ?? new Set<string>()
        into.add(f)
        fileGraph.set(target, into)
      }
    }
  }
  return { syms, adjacency, fileGraph, parsed: new Set(fileImports.keys()) }
}

// --- generic symbols: regex declarations, any language, no grammar ----------

const GENERIC_DECL: [RegExp, string][] = [
  [/\b(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/\bdef\s+([A-Za-z_]\w*)/, "function"],
  [/\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:async|unsafe|extern|const)\s+)*fn\s+([A-Za-z_]\w*)/, "function"],
  [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
  [/\bfun\s+([A-Za-z_]\w*)/, "function"],
  [/\bsub\s+([A-Za-z_]\w*)/, "function"],
  [/\b(?:class|struct|interface|trait|enum|union|record|module|namespace|impl|extension)\s+([A-Za-z_]\w*)/, "type"],
  [/\b(?:static\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/, "value"],
  // C/Java-style: `retType name(args) {`
  [/^\s*(?:[\w$:<>,.*&\[\]?]+\s+){1,4}([A-Za-z_$][\w$]*)\s*\([^;]*?\)\s*(?:const\s*|noexcept\s*|throws[\w, ]*|->\s*[\w:<> ]+\s*)?\{\s*$/, "function"],
]
const DECL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "new", "delete",
  "do", "else", "typedef", "using", "import", "require", "include", "print",
])

function extractGenericSymbols(files: string[]): SymDoc[] {
  const out: SymDoc[] = []
  for (const file of files) {
    const abs = path.join(REPO, file)
    if (shouldSkipIndexPath(abs) || EXCLUDE.test(file)) continue
    let source: string
    try {
      source = readFileSync(abs, "utf8")
    } catch {
      continue
    }
    const lines = source.split("\n")
    for (let i = 0; i < lines.length; i++) {
      let name = "", kind = ""
      for (const [re, k] of GENERIC_DECL) {
        const m = lines[i]!.match(re)
        if (m && !DECL_SKIP.has(m[1]!)) { name = m[1]!; kind = k; break }
      }
      if (!name) continue
      const body = lines.slice(i, i + 25).join("\n").slice(0, MAX_BODY_CHARS)
      out.push({ file, name, symbol: name, text: `${name} ${name} ${kind} ${file} ${body}` })
    }
  }
  return out
}

/** One-hop spreading activation: score' = s + decay * max(neighbor scores). */
function spreadScores(base: Float32Array, adjacency: Map<number, Set<number>>): Float32Array {
  const out = new Float32Array(base)
  for (const [node, neighbors] of adjacency) {
    if (base[node]! <= 0) continue
    for (const nb of neighbors) {
      const boosted = base[node]! * SPREAD_DECAY
      if (boosted > out[nb]!) out[nb] = boosted
    }
  }
  return out
}

// --- potion -----------------------------------------------------------------

async function embedAll(runtime: Awaited<ReturnType<typeof Potion.load>>, chunks: Chunk[]) {
  const dim = runtime.profile.dimension
  const vectors = new Float32Array(chunks.length * dim)
  for (let i = 0; i < chunks.length; i += 512) {
    const embedded = runtime.embed(chunks.slice(i, i + 512).map((c) => `${c.file}\n${c.text}`))
    for (const [j, v] of embedded.entries()) vectors.set(v, (i + j) * dim)
  }
  return { vectors, dim }
}

function cosineAll(vectors: Float32Array, dim: number, query: Float32Array): Float32Array {
  const n = vectors.length / dim
  const scores = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let dot = 0
    const off = i * dim
    for (let d = 0; d < dim; d++) dot += vectors[off + d]! * query[d]!
    scores[i] = dot
  }
  return scores
}

// --- fusion + prf -----------------------------------------------------------

type Channels = {
  chunk: Map<string, number> // normalized file scores from chunk BM25
  sym: Map<string, number> // normalized file scores from symbol/fn BM25
  path: Map<string, number> // normalized file scores from path BM25
}

function fuse(ch: Channels, allFiles: string[]): Map<string, number> {
  const fused = new Map<string, number>()
  for (const f of allFiles) {
    const score =
      W_CHUNK * (ch.chunk.get(f) ?? 0) + W_SYMBOL * (ch.sym.get(f) ?? 0) + W_PATH * (ch.path.get(f) ?? 0)
    if (score > 0) fused.set(f, score)
  }
  return fused
}

function channelsFor(
  query: string,
  lexStem: LexIndex,
  symLex: LexIndex,
  pathLex: LexIndex,
  chunks: Chunk[],
  syms: SymDoc[],
  allFiles: string[],
): Channels {
  const chunk = normalizeMap(docScoresToFiles(bm25(lexStem, query, true), (i) => chunks[i]!.file))
  const sym = normalizeMap(docScoresToFiles(bm25(symLex, query, true), (i) => syms[i]!.file))
  const pathN = normalizeMap(docScoresToFiles(bm25(pathLex, query, true), (i) => allFiles[i]!))
  return { chunk, sym, path: pathN }
}

/** Harvest discriminative terms from the top-ranked docs of a channel. */
function prfTerms(index: LexIndex, topDocs: number[], taken: Set<string>): Map<string, number> {
  const top = new Set(topDocs)
  const score = new Map<string, number>()
  for (const [t, postings] of index.inverted) {
    if (taken.has(t) || STOP.has(t) || t.length < 3) continue
    const df = postings.length
    if (df > index.n * 0.2) continue // too common to discriminate
    let freq = 0
    for (const { doc, freq: f } of postings) if (top.has(doc)) freq += f
    if (freq === 0) continue
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5))
    score.set(t, freq * idf)
  }
  const out = new Map<string, number>()
  for (const [t] of [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, PRF_TERMS)) out.set(t, PRF_WEIGHT)
  return out
}

// --- main -------------------------------------------------------------------

const t0 = performance.now()
const { chunks, files: allFilesUnsorted } = collect()
const allFiles = allFilesUnsorted.sort()
console.log(`corpus: ${allFiles.length} files, ${chunks.length} chunks`)

const tLex = performance.now()
const lex = buildLex(chunks, false)
const lexStem = buildLex(chunks, true)
console.log(`lexical indexes: ${(performance.now() - tLex).toFixed(0)}ms`)

const tSym = performance.now()
const { syms, adjacency, fileGraph, parsed } = extractSymbols(allFiles)
const symLex = buildLex(
  syms.map((s) => ({ file: s.file, text: s.text.split(" ").slice(0, 60).join(" ") })), // sig-style doc: name+path only
  true,
)
const fnLex = buildLex(syms, true) // full doc incl. body tokens
const gsyms = extractGenericSymbols(allFiles)
const gsymLex = buildLex(gsyms, true)
// hybrid: parser symbols on supported files + regex decls only where yolk
// has no grammar — the production shape for "works on most languages"
const hsyms = [...syms, ...gsyms.filter((s) => !parsed.has(s.file))]
const hfnLex = buildLex(hsyms, true)
console.log(
  `symbols: ${syms.length} yolk / ${gsyms.length} generic / ${hsyms.length} hybrid in ${(performance.now() - tSym).toFixed(0)}ms`,
)

const pathLex = buildLex(
  allFiles.map((f) => ({ file: f, text: f })),
  true,
)

const memBefore = process.memoryUsage().heapUsed
const runtime = await Potion.load({ cacheDir: CACHE })
const tEmb = performance.now()
const { vectors, dim } = await embedAll(runtime, chunks)
console.log(`embed: ${(performance.now() - tEmb).toFixed(0)}ms, heap +${((process.memoryUsage().heapUsed - memBefore) / 1e6).toFixed(0)}MB`)

// corpus thesaurus: embed the vocabulary itself — embeddings as a lexicon, not
// an index. Vocab is ~50x smaller than the doc corpus, caches perfectly, and
// expansion is bounded at query time.
const tThes = performance.now()
const vocab = [...lex.inverted.keys()].filter((t) => {
  const df = lex.df.get(t) ?? 0
  return t.length >= 3 && !STOP.has(t) && df >= 3 && df <= lex.n * 0.1
})
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
console.log(`thesaurus: ${vocab.length} terms in ${(performance.now() - tThes).toFixed(0)}ms`)

const cochange = buildCochange(allFiles)
console.log(`co-change graph: ${cochange.size} files`)

/** Query expansion from the corpus's own vocabulary: nearest corpus terms to
 * each query term by cosine, mapped through the stemmer. Weighted below
 * original terms. Phrase-centroid expansion measured worse — it echoes the
 * query's own terms back and dilutes the bridges. */
function expandQuery(q: string, k = 6, minSim = 0.55): Map<string, number> {
  const out = new Map<string, number>()
  const seen = new Set<string>()
  for (const w of new Set(terms(q))) {
    const v = runtime.embed([w])[0]!
    let n2 = 0
    for (let d = 0; d < dim; d++) n2 += v[d]! * v[d]!
    const qn = Math.sqrt(n2) || 1
    const scores = new Float32Array(vocab.length)
    for (let i = 0; i < vocab.length; i++) {
      let dot = 0
      const off = i * dim
      for (let d = 0; d < dim; d++) dot += termVecs[off + d]! * v[d]!
      scores[i] = dot / qn
    }
    const idx = [...scores.keys()].sort((a, b) => scores[b]! - scores[a]!).slice(0, k)
    for (const i of idx) {
      const s = scores[i]!
      const st = stem(vocab[i]!)
      if (s < minSim || seen.has(st) || !lexStem.inverted.has(st)) continue
      seen.add(st)
      out.set(st, 0.6 * s)
    }
  }
  return out
}

type Row = { q: string; ranks: Record<string, number>; ms: Record<string, number> }
const rows: Row[] = []

for (const { q, expect, alts } of QUERIES) {
  const ms: Record<string, number> = {}
  const ranks: Record<string, number> = {}
  let t = performance.now()

  const chunkFileOf = (i: number) => chunks[i]!.file
  ranks.grep = firstHitFiles(grepRank(allFiles, lexStem, chunkFileOf, q), expect)
  ms.grep = performance.now() - t
  t = performance.now()

  ranks.lexical = firstHitFiles(rankFiles(docScoresToFiles(bm25(lex, q, false), chunkFileOf)), expect)
  ms.lexical = performance.now() - t
  t = performance.now()

  ranks.lexstem = firstHitFiles(rankFiles(docScoresToFiles(bm25(lexStem, q, true), chunkFileOf)), expect)
  ms.lexstem = performance.now() - t
  t = performance.now()

  const symScores = bm25(symLex, q, true)
  ranks.symbol = firstHitFiles(rankFiles(docScoresToFiles(symScores, (i) => syms[i]!.file)), expect)
  ms.symbol = performance.now() - t
  t = performance.now()

  const fnScores = bm25(fnLex, q, true)
  ranks.fnlevel = firstHitFiles(rankFiles(docScoresToFiles(fnScores, (i) => syms[i]!.file)), expect)
  ms.fnlevel = performance.now() - t
  t = performance.now()

  const spread = spreadScores(fnScores, adjacency)
  ranks.spread = firstHitFiles(rankFiles(docScoresToFiles(spread, (i) => syms[i]!.file)), expect)
  ms.spread = performance.now() - t
  t = performance.now()

  const gsymScores = bm25(gsymLex, q, true)
  const gsymFiles = normalizeMap(docScoresToFiles(gsymScores, (i) => gsyms[i]!.file))
  ranks.gsym = firstHitFiles(rankFiles(gsymFiles), expect)
  ms.gsym = performance.now() - t
  t = performance.now()

  const pathScores = bm25(pathLex, q, true)
  const pathRanked = rankFiles(docScoresToFiles(pathScores, (i) => allFiles[i]!))
  ranks.path = firstHitFiles(pathRanked, expect)
  ms.path = performance.now() - t
  t = performance.now()

  const semScores = cosineAll(vectors, dim, runtime.embed([q])[0]!)
  ranks.semantic = firstHitFiles(rankFiles(docScoresToFiles(semScores, chunkFileOf)), expect)
  ms.semantic = performance.now() - t
  t = performance.now()

  const ch = channelsFor(q, lexStem, symLex, pathLex, chunks, syms, allFiles)
  const fused = fuse(ch, allFiles)
  ranks.fusion = firstHitFiles(rankFiles(fused), expect)
  ms.fusion = performance.now() - t
  t = performance.now()

  // cover: distinct-stem coverage first, chunk BM25 as tiebreak — grep's
  // coverage requirement relaxed into a ranking
  const qStems = [...new Set(terms(q).map(stem))]
  const covSets = new Map<string, Set<string>>()
  for (const term of qStems) {
    for (const { doc } of lexStem.inverted.get(term) ?? []) {
      const f = chunks[doc]!.file
      const set = covSets.get(f) ?? new Set<string>()
      set.add(term)
      covSets.set(f, set)
    }
  }
  const chunkBm25 = docScoresToFiles(bm25(lexStem, q, true), chunkFileOf)
  const coverRanked = [...covSets.entries()]
    .sort((a, b) => b[1].size - a[1].size || (chunkBm25.get(b[0]) ?? 0) - (chunkBm25.get(a[0]) ?? 0))
    .map(([f]) => f)
  ranks.cover = firstHitFiles(coverRanked, expect)
  ms.cover = performance.now() - t
  t = performance.now()

  // prf: harvest discriminative terms from top fused files' best chunks, re-query
  const topFiles = rankFiles(fused).slice(0, PRF_DOCS)
  const topChunks = chunks.map((c, i) => i).filter((i) => topFiles.includes(chunks[i]!.file))
  const expanded = new Map<string, number>()
  for (const term of new Set(terms(q).map(stem))) expanded.set(term, 1)
  for (const [t, w] of prfTerms(lexStem, topChunks, new Set(expanded.keys()))) expanded.set(t, w)
  const prfScores = bm25Weighted(lexStem, expanded)
  const prfCh = {
    chunk: normalizeMap(docScoresToFiles(prfScores, chunkFileOf)),
    sym: ch.sym,
    path: ch.path,
  }
  const prfFused = fuse(prfCh, allFiles)
  for (const [f, s] of fused) prfFused.set(f, Math.max(prfFused.get(f) ?? 0, s))
  ranks.prf = firstHitFiles(rankFiles(prfFused), expect)
  ms.prf = performance.now() - t
  t = performance.now()

  // nova: fusion with the call-graph-spread fn channel + a coverage bonus
  const novaSym = normalizeMap(docScoresToFiles(spread, (i) => syms[i]!.file))
  const novaBase = fuse({ chunk: ch.chunk, sym: novaSym, path: ch.path }, allFiles)
  const novaFinal = new Map(novaBase)
  for (const [f, cov] of covSets) {
    if (novaFinal.has(f)) novaFinal.set(f, novaFinal.get(f)! + 0.1 * (cov.size / Math.max(1, qStems.length)))
  }
  ranks.nova = firstHitFiles(rankFiles(novaFinal), expect)
  ms.nova = performance.now() - t
  t = performance.now()

  // apex: everything that measured well — idf² chunk weighting (identifiers
  // dominate), spread-fn channel, path, coverage bonus, same-dir locality
  const apexQ = new Map<string, number>()
  for (const term of new Set(terms(q).map(stem))) apexQ.set(term, 1)
  const apexChunk = normalizeMap(docScoresToFiles(bm25Weighted(lexStem, apexQ, 2), chunkFileOf))
  const apexBase = fuse({ chunk: apexChunk, sym: novaSym, path: ch.path }, allFiles)
  const apexFinal = new Map(apexBase)
  for (const [f, cov] of covSets) {
    if (apexFinal.has(f)) apexFinal.set(f, apexFinal.get(f)! + 0.1 * (cov.size / Math.max(1, qStems.length)))
  }
  const apexTop = rankFiles(apexFinal).slice(0, 3)
  const apexDirs = new Set(apexTop.map((f) => path.dirname(f)))
  for (const f of apexFinal.keys()) {
    if (apexDirs.has(path.dirname(f)) && !apexTop.includes(f)) apexFinal.set(f, apexFinal.get(f)! + 0.05)
  }
  // import-graph propagation: neighbors of top hits get a fraction of their score
  const apexSpread = new Map(apexFinal)
  for (const f of apexTop) {
    for (const nb of fileGraph.get(f) ?? []) {
      if (apexSpread.has(nb)) apexSpread.set(nb, Math.max(apexSpread.get(nb)!, apexFinal.get(f)! * 0.3))
    }
  }
  ranks.apex = firstHitFiles(rankFiles(apexSpread), expect)
  ms.apex = performance.now() - t
  t = performance.now()

  // gapex: the apex recipe on generic regex symbols — no grammar, no call
  // spread; measures how much of the win survives on unsupported languages
  const gapexBase = fuse({ chunk: apexChunk, sym: gsymFiles, path: ch.path }, allFiles)
  const gapexFinal = new Map(gapexBase)
  for (const [f, cov] of covSets) {
    if (gapexFinal.has(f)) gapexFinal.set(f, gapexFinal.get(f)! + 0.1 * (cov.size / Math.max(1, qStems.length)))
  }
  const gapexTop = rankFiles(gapexFinal).slice(0, 3)
  const gapexDirs = new Set(gapexTop.map((f) => path.dirname(f)))
  for (const f of gapexFinal.keys()) {
    if (gapexDirs.has(path.dirname(f)) && !gapexTop.includes(f)) gapexFinal.set(f, gapexFinal.get(f)! + 0.05)
  }
  const gapexSpread = new Map(gapexFinal)
  for (const f of gapexTop) {
    for (const nb of fileGraph.get(f) ?? []) {
      if (gapexSpread.has(nb)) gapexSpread.set(nb, Math.max(gapexSpread.get(nb)!, gapexFinal.get(f)! * 0.3))
    }
  }
  ranks.gapex = firstHitFiles(rankFiles(gapexSpread), expect)
  ms.gapex = performance.now() - t
  t = performance.now()

  // hapex: apex recipe on the hybrid symbol set — call spread only reaches
  // yolk-parsed docs (adjacency indices < syms.length), regex decls are safe
  const hfnScores = bm25(hfnLex, q, true)
  const hspread = spreadScores(hfnScores, adjacency)
  const hsymFiles = normalizeMap(docScoresToFiles(hspread, (i) => hsyms[i]!.file))
  const hapexFinal = fuse({ chunk: apexChunk, sym: hsymFiles, path: ch.path }, allFiles)
  for (const [f, cov] of covSets) {
    if (hapexFinal.has(f)) hapexFinal.set(f, hapexFinal.get(f)! + 0.1 * (cov.size / Math.max(1, qStems.length)))
  }
  const hapexTop = rankFiles(hapexFinal).slice(0, 3)
  const hapexDirs = new Set(hapexTop.map((f) => path.dirname(f)))
  for (const f of hapexFinal.keys()) {
    if (hapexDirs.has(path.dirname(f)) && !hapexTop.includes(f)) hapexFinal.set(f, hapexFinal.get(f)! + 0.05)
  }
  const hapexSpread = new Map(hapexFinal)
  for (const f of hapexTop) {
    for (const nb of fileGraph.get(f) ?? []) {
      if (hapexSpread.has(nb)) hapexSpread.set(nb, Math.max(hapexSpread.get(nb)!, hapexFinal.get(f)! * 0.3))
    }
  }
  ranks.hapex = firstHitFiles(rankFiles(hapexSpread), expect)
  ms.hapex = performance.now() - t
  t = performance.now()

  // xterm: expanded weighted query through the three channels, plain fusion —
  // isolates what the corpus thesaurus contributes
  const xExpanded = new Map(apexQ)
  for (const [term, w] of expandQuery(q)) xExpanded.set(term, Math.max(xExpanded.get(term) ?? 0, w))
  const xCh: Channels = {
    chunk: normalizeMap(docScoresToFiles(bm25Weighted(lexStem, xExpanded), chunkFileOf)),
    sym: normalizeMap(docScoresToFiles(bm25Weighted(hfnLex, xExpanded), (i) => hsyms[i]!.file)),
    path: normalizeMap(docScoresToFiles(bm25Weighted(pathLex, xExpanded), (i) => allFiles[i]!)),
  }
  ranks.xterm = firstHitFiles(rankFiles(fuse(xCh, allFiles)), expect)
  ms.xterm = performance.now() - t
  t = performance.now()

  // coev: hapex + co-change propagation — history-derived coupling, works on
  // every file type; unlike import spread it can surface files with zero
  // lexical signal at all
  const coevSpread = new Map(hapexSpread)
  for (const f of hapexTop) {
    for (const nb of cochange.get(f) ?? []) {
      const boosted = hapexFinal.get(f)! * 0.3
      if (boosted > (coevSpread.get(nb) ?? 0)) coevSpread.set(nb, boosted)
    }
  }
  ranks.coev = firstHitFiles(rankFiles(coevSpread), expect)
  ms.coev = performance.now() - t
  t = performance.now()

  // supreme: everything — expanded query (idf²), hybrid spread symbols, path,
  // coverage, locality, import-graph and co-change propagation
  const supChunk = normalizeMap(docScoresToFiles(bm25Weighted(lexStem, xExpanded, 2), chunkFileOf))
  const supSym = normalizeMap(docScoresToFiles(spreadScores(bm25Weighted(hfnLex, xExpanded), adjacency), (i) => hsyms[i]!.file))
  const supPath = normalizeMap(docScoresToFiles(bm25Weighted(pathLex, xExpanded), (i) => allFiles[i]!))
  const supFinal = fuse({ chunk: supChunk, sym: supSym, path: supPath }, allFiles)
  for (const [f, cov] of covSets) {
    if (supFinal.has(f)) supFinal.set(f, supFinal.get(f)! + 0.1 * (cov.size / Math.max(1, qStems.length)))
  }
  const supTop = rankFiles(supFinal).slice(0, 3)
  const supDirs = new Set(supTop.map((f) => path.dirname(f)))
  for (const f of supFinal.keys()) {
    if (supDirs.has(path.dirname(f)) && !supTop.includes(f)) supFinal.set(f, supFinal.get(f)! + 0.05)
  }
  const supSpread = new Map(supFinal)
  for (const f of supTop) {
    const boost = supFinal.get(f)! * 0.3
    for (const nb of fileGraph.get(f) ?? []) {
      if (boost > (supSpread.get(nb) ?? 0)) supSpread.set(nb, boost)
    }
    for (const nb of cochange.get(f) ?? []) {
      if (boost > (supSpread.get(nb) ?? 0)) supSpread.set(nb, boost)
    }
  }
  ranks.supreme = firstHitFiles(rankFiles(supSpread), expect)
  ms.supreme = performance.now() - t
  t = performance.now()

  // sintent: supreme + intent routing — "callers/uses/importers of X" routes
  // through the call graph: find the target symbols, rank their graph
  // neighbors' files above the definer. A class grep cannot express at all.
  if (/\b(callers?|callees?|uses?|importers?|references?|dependents?|consumers?|invokes?)\s+of\b/i.test(q)) {
    const core = q
      .replace(/\b(callers?|callees?|uses?|importers?|references?|dependents?|consumers?|invokes?)\s+of\b/gi, " ")
      .replace(/\b(of|the|a|an|function|method|symbol|to|it|its|is|are|in|for)\b/gi, " ")
    const symBase = bm25(hfnLex, core, true)
    const docRank = [...symBase.keys()].sort((a, b) => symBase[b]! - symBase[a]!).slice(0, 8)
    const callerFiles = new Map(supSpread)
    for (const d of docRank) {
      const s = symBase[d]!
      if (s <= 0) continue
      for (const nb of adjacency.get(d) ?? []) {
        const f = hsyms[nb]!.file
        if (f === hsyms[d]!.file) continue
        if (s * 0.8 > (callerFiles.get(f) ?? 0)) callerFiles.set(f, s * 0.8)
      }
    }
    ranks.sintent = firstHitFiles(rankFiles(callerFiles), expect)
  } else {
    ranks.sintent = ranks.supreme!
  }
  ms.sintent = performance.now() - t
  t = performance.now()

  // mq: fusion merged over author-supplied alt phrasings (upper bound w/ model)
  if (alts && alts.length > 0) {
    const merged = new Map(fused)
    for (const alt of alts) {
      const altFused = fuse(channelsFor(alt, lexStem, symLex, pathLex, chunks, syms, allFiles), allFiles)
      for (const [f, s] of altFused) merged.set(f, Math.max(merged.get(f) ?? 0, s))
    }
    ranks.mq = firstHitFiles(rankFiles(merged), expect)
  } else {
    ranks.mq = ranks.fusion!
  }
  ms.mq = performance.now() - t

  rows.push({ q, ranks, ms })
}

// --- report -----------------------------------------------------------------

const names = [
  "grep", "lexical", "lexstem", "cover", "symbol", "fnlevel", "spread", "gsym", "path", "semantic", "fusion", "prf", "nova", "apex", "gapex", "hapex", "xterm", "coev", "supreme", "sintent", "mq",
]
console.log(`\n${"query".padEnd(56)} ${names.map((n) => n.padStart(8)).join("")}`)
for (const row of rows) {
  console.log(
    `${row.q.slice(0, 55).padEnd(56)} ${names.map((n) => (row.ranks[n] === 0 ? "miss" : `#${row.ranks[n]}`).padStart(8)).join("")}`,
  )
}
console.log()
for (const name of names) {
  const hits = (k: number) => rows.filter((r) => r.ranks[name]! > 0 && r.ranks[name]! <= k).length
  const mrr = rows.reduce((a, r) => a + (r.ranks[name]! > 0 ? 1 / r.ranks[name]! : 0), 0) / rows.length
  const lat = rows.map((r) => r.ms[name] ?? 0).sort((a, b) => a - b)
  console.log(
    `${name.padEnd(9)} hit@1=${String(hits(1)).padStart(2)}/${rows.length} hit@5=${String(hits(5)).padStart(2)}/${rows.length} hit@10=${String(hits(10)).padStart(2)}/${rows.length} MRR=${mrr.toFixed(2)} p50=${lat[Math.floor(lat.length / 2)]!.toFixed(1)}ms`,
  )
}
console.log(`\ntotal: ${(performance.now() - t0).toFixed(0)}ms`)
