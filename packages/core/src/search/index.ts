export * as CodeSearch from "."

import { Potion, type PotionLoadOptions, type PotionRuntime } from "@turenlabs/plugin/potion"
import { Context, Effect, Layer, Option, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ExtensionRuntime } from "../extension"
import { Watcher } from "../filesystem/watcher"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { detectLanguage, isKnownUnsupportedSourcePath, lexLanguage } from "../yolk/language"
import { parseGoUnit, parseJavaUnit } from "../yolk/indexer"
import { parserForLanguage } from "../yolk/parsers"

export const Hit = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  score: Schema.Number,
})
export type Hit = typeof Hit.Type

export interface Interface {
  readonly search: (input: {
    readonly queries: readonly string[]
    readonly path?: string
    readonly limit?: number
  }) => Effect.Effect<Hit[], unknown>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/CodeSearch") {}

// --- corpus bounds ------------------------------------------------------------

const CHUNK_LINES = 100
const CHUNK_STEP = 100
const MAX_FILE_LINES = 4000
const MAX_FILE_BYTES = 512 * 1024
const MAX_BODY_CHARS = 8000
const MAX_CALLEES_PER_NAME = 20
const MAX_RESULTS = 40

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".sql", ".toml", ".yaml", ".yml", ".sh",
  ".md", ".css", ".html", ".vue", ".svelte", ".zig", ".swift", ".kt",
])
const EXCLUDE =
  /(^|\/)node_modules\/|\/dist\/|src\/generated|resources\/licenses|test\/fixtures|__snapshots__|\.snap$|bun\.lock$|\.min\.js$|\.wasm$|\.d\.ts$/i

// --- terms --------------------------------------------------------------------

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

// --- incremental inverted index ------------------------------------------------

type DocMeta = {
  file: string
  line: number
  name?: string
  kind?: string
  snippet?: string
}

type LexIndex = {
  docs: DocMeta[]
  alive: boolean[]
  docLen: number[]
  inverted: Map<string, { doc: number; freq: number }[]>
  df: Map<string, number>
  sumLen: number
  n: number
  fileDocs: Map<string, number[]>
  docTerms: Map<number, Map<string, number>>
}

const newLex = (): LexIndex => ({
  docs: [],
  alive: [],
  docLen: [],
  inverted: new Map(),
  df: new Map(),
  sumLen: 0,
  n: 0,
  fileDocs: new Map(),
  docTerms: new Map(),
})

function addDoc(ix: LexIndex, doc: DocMeta, text: string) {
  const freqs = new Map<string, number>()
  for (const t of terms(text)) freqs.set(stem(t), (freqs.get(stem(t)) ?? 0) + 1)
  const id = ix.docs.length
  let len = 0
  for (const [t, f] of freqs) {
    len += f
    const postings = ix.inverted.get(t) ?? []
    postings.push({ doc: id, freq: f })
    ix.inverted.set(t, postings)
    ix.df.set(t, (ix.df.get(t) ?? 0) + 1)
  }
  ix.docs.push(doc)
  ix.alive.push(true)
  ix.docLen.push(len)
  ix.sumLen += len
  ix.n++
  ix.docTerms.set(id, freqs)
  const list = ix.fileDocs.get(doc.file) ?? []
  list.push(id)
  ix.fileDocs.set(doc.file, list)
}

function removeFileDocs(ix: LexIndex, file: string) {
  for (const id of ix.fileDocs.get(file) ?? []) {
    if (!ix.alive[id]) continue
    ix.alive[id] = false
    ix.n--
    ix.sumLen -= ix.docLen[id]!
    for (const t of ix.docTerms.get(id)!.keys()) {
      const df = (ix.df.get(t) ?? 0) - 1
      if (df <= 0) {
        ix.df.delete(t)
        ix.inverted.delete(t)
      } else {
        ix.df.set(t, df)
        ix.inverted.set(t, ix.inverted.get(t)!.filter((p) => p.doc !== id))
      }
    }
    ix.docTerms.delete(id)
  }
  ix.fileDocs.delete(file)
}

const K1 = 1.2
const B = 0.75

function bm25Weighted(ix: LexIndex, qterms: Map<string, number>, idfPower = 1): Float64Array {
  const scores = new Float64Array(ix.docs.length)
  const avg = ix.n > 0 ? ix.sumLen / ix.n : 1
  for (const [t, weight] of qterms) {
    const postings = ix.inverted.get(t)
    if (!postings?.length) continue
    const df = ix.df.get(t)!
    const idf = Math.pow(Math.log(1 + (ix.n - df + 0.5) / (df + 0.5)), idfPower)
    for (const { doc, freq } of postings) {
      if (!ix.alive[doc]) continue
      const dl = ix.docLen[doc]!
      scores[doc] += weight * idf * ((freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * dl) / avg)))
    }
  }
  return scores
}

/** Max-pool doc scores to file level, keeping the argmax doc for anchoring. */
function bestPerFile(ix: LexIndex, scores: Float64Array): Map<string, { score: number; doc: number }> {
  const out = new Map<string, { score: number; doc: number }>()
  let max = 0
  for (let i = 0; i < scores.length; i++) {
    if (!ix.alive[i] || scores[i]! <= 0) continue
    const file = ix.docs[i]!.file
    const score = scores[i]!
    const cur = out.get(file)
    if (!cur || cur.score < score) {
      out.set(file, { score, doc: i })
      if (score > max) max = score
    }
  }
  if (max > 0) for (const v of out.values()) v.score /= max
  return out
}

/** One-hop spreading activation over an undirected adjacency. */
function spreadScores(base: Float64Array, adjacency: Map<number, Set<number>>, decay: number): Float64Array {
  const out = new Float64Array(base)
  for (const [node, neighbors] of adjacency) {
    if (base[node]! <= 0) continue
    for (const nb of neighbors) {
      const boosted = base[node]! * decay
      if (boosted > out[nb]!) out[nb] = boosted
    }
  }
  return out
}

// --- symbol extraction -----------------------------------------------------------

type EdgeInput = { caller: number; receiver: string; calleeName: string }
type Extracted = {
  chunks: { doc: DocMeta; text: string }[]
  syms: { doc: DocMeta; text: string }[]
  edges: EdgeInput[]
  imports: Map<string, string>
  parsed: boolean
}

const CALL_NAME_RE = /^[A-Za-z_$][\w$]*$/
const CALL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "typeof",
  "constructor", "super", "do", "else", "case", "throw", "await", "yield", "in",
])

const GENERIC_DECL: [RegExp, string][] = [
  [/\b(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/\bdef\s+([A-Za-z_]\w*)/, "function"],
  [/\b(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:async|unsafe|extern|const)\s+)*fn\s+([A-Za-z_]\w*)/, "function"],
  [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
  [/\bfun\s+([A-Za-z_]\w*)/, "function"],
  [/\bsub\s+([A-Za-z_]\w*)/, "function"],
  [/\b(?:class|struct|interface|trait|enum|union|record|module|namespace|impl|extension)\s+([A-Za-z_]\w*)/, "type"],
  [/\b(?:static\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/, "value"],
  [/^\s*(?:[\w$:<>,.*&\[\]?]+\s+){1,4}([A-Za-z_$][\w$]*)\s*\([^;]*?\)\s*(?:const\s*|noexcept\s*|throws[\w, ]*|->\s*[\w:<> ]+\s*)?\{\s*$/, "function"],
]
const DECL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "new", "delete",
  "do", "else", "typedef", "using", "import", "require", "include", "print",
])

const INTENT_RE = /\b(callers?|callees?|uses?|importers?|references?|dependents?|consumers?|invokes?)\s+of\b/i

function chunkDocs(file: string, lines: string[]) {
  const out: { doc: DocMeta; text: string }[] = []
  for (let start = 0; start < lines.length; start += CHUNK_STEP) {
    out.push({ doc: { file, line: start + 1 }, text: lines.slice(start, start + CHUNK_LINES).join("\n") })
    if (start + CHUNK_LINES >= lines.length) break
  }
  return out
}

function genericSyms(file: string, lines: string[]) {
  const out: { doc: DocMeta; text: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    let name = "", kind = ""
    for (const [re, k] of GENERIC_DECL) {
      const m = lines[i]!.match(re)
      if (m && !DECL_SKIP.has(m[1]!)) { name = m[1]!; kind = k; break }
    }
    if (!name) continue
    const body = lines.slice(i, i + 25).join("\n").slice(0, MAX_BODY_CHARS)
    out.push({
      doc: { file, line: i + 1, name, kind, snippet: lines[i]!.trim().slice(0, 160) },
      text: `${name} ${name} ${kind} ${file} ${body}`,
    })
  }
  return out
}

// --- service ---------------------------------------------------------------------

type PotionLoader = (options: PotionLoadOptions) => Promise<PotionRuntime>

const makeLayer = (load: PotionLoader) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const extensions = yield* ExtensionRuntime.Service
    const global = yield* Effect.serviceOption(Global.Service)

    const dir = location.directory
    const chunkLex = newLex()
    const symLex = newLex()
    const pathLex = newLex()
    const files = new Set<string>()

    // graph state — populated only on the yolk path
    const adj = new Map<number, Set<number>>() // undirected, for spread
    const callers = new Map<number, Set<number>>() // callee doc -> caller docs, for intent
    const fileGraph = new Map<string, Set<string>>()
    const fileEdges = new Map<string, [number, number][]>()
    const fileImports = new Map<string, Map<string, string>>()
    const byName = new Map<string, number[]>()
    const byNameInFile = new Map<string, number[]>()

    let version = 0
    let yolkEnabled = false
    let building: Promise<void> | undefined
    let built = false
    const dirty = new Set<string>()
    const pendingEdges = new Map<string, EdgeInput[]>()

    let potion: Promise<PotionRuntime> | undefined
    let potionFailures = 0
    let thesaurus: { version: number; vocab: string[]; vecs: Float32Array; dim: number } | undefined

    const moduleToFiles = () => {
      const map = new Map<string, string[]>()
      for (const f of files) {
        const noExt = f.replace(/\.[^.]+$/, "")
        for (const key of [noExt, path.basename(noExt)]) {
          const list = map.get(key) ?? []
          list.push(f)
          map.set(key, list)
        }
      }
      return map
    }

    const indexSym = (doc: DocMeta, text: string): number => {
      const id = symLex.docs.length
      addDoc(symLex, doc, text)
      if (doc.name) {
        for (const [map, key] of [
          [byName, doc.name],
          [byNameInFile, `${doc.file}#${doc.name}`],
        ] as const) {
          const list = map.get(key) ?? []
          list.push(id)
          map.set(key, list)
        }
      }
      return id
    }

    const resolveEdges = (file: string, edges: EdgeInput[], modules: Map<string, string[]>) => {
      const imports = fileImports.get(file)
      const inModule = (module: string, name: string) => {
        const targets = modules.get(module) ?? modules.get(module.split("/").at(-1) ?? module)
        return targets?.flatMap((f) => byNameInFile.get(`${f}#${name}`) ?? [])
      }
      const pairs: [number, number][] = []
      for (const { caller, receiver, calleeName } of edges) {
        let targets: number[] | undefined
        if (receiver && imports?.has(receiver)) targets = inModule(imports.get(receiver)!, calleeName)
        if (!targets?.length && !receiver) {
          targets = byNameInFile.get(`${file}#${calleeName}`)
          if (!targets?.length && imports?.has(calleeName)) targets = inModule(imports.get(calleeName)!, calleeName)
        }
        if (!targets?.length) targets = byName.get(calleeName)
        if (!targets || targets.length > MAX_CALLEES_PER_NAME) continue
        for (const callee of targets) {
          if (callee === caller) continue
          pairs.push([caller, callee])
          const set1 = adj.get(caller) ?? new Set<number>()
          set1.add(callee)
          adj.set(caller, set1)
          const set2 = adj.get(callee) ?? new Set<number>()
          set2.add(caller)
          adj.set(callee, set2)
          const cs = callers.get(callee) ?? new Set<number>()
          cs.add(caller)
          callers.set(callee, cs)
        }
      }
      fileEdges.set(file, pairs)
    }

    const dropEdges = (file: string) => {
      for (const [caller, callee] of fileEdges.get(file) ?? []) {
        adj.get(caller)?.delete(callee)
        adj.get(callee)?.delete(caller)
        callers.get(callee)?.delete(caller)
      }
      fileEdges.delete(file)
    }

    const addFileGraph = (file: string, modules: Map<string, string[]>) => {
      for (const module of fileImports.get(file)?.values() ?? []) {
        const targets = modules.get(module) ?? modules.get(module.split("/").at(-1) ?? module)
        for (const target of targets ?? []) {
          if (target === file) continue
          const out = fileGraph.get(file) ?? new Set<string>()
          out.add(target)
          fileGraph.set(file, out)
          const into = fileGraph.get(target) ?? new Set<string>()
          into.add(file)
          fileGraph.set(target, into)
        }
      }
    }

    const dropFileGraph = (file: string) => {
      for (const nb of fileGraph.get(file) ?? []) fileGraph.get(nb)?.delete(file)
      fileGraph.delete(file)
    }

    const indexFile = Effect.fnUntraced(function* (file: string) {
      const abs = path.join(dir, file)
      const info = yield* fs.stat(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info || info.type !== "File" || info.size > MAX_FILE_BYTES) return
      const source = yield* fs.readFileStringSafe(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (source === undefined || source.includes("\0")) return

      const lines = source.split("\n").slice(0, MAX_FILE_LINES)
      for (const chunk of chunkDocs(file, lines)) addDoc(chunkLex, chunk.doc, chunk.text)
      addDoc(pathLex, { file, line: 1 }, file)
      files.add(file)

      let parsed = false
      if (yolkEnabled && !isKnownUnsupportedSourcePath(abs)) {
        const language = detectLanguage(abs, source)
        if (language) {
          try {
            const tokens = lexLanguage(source, language)
            const unit =
              language === "go"
                ? parseGoUnit(abs, tokens)
                : language === "java"
                  ? parseJavaUnit(abs, tokens)
                  : parserForLanguage(dir, abs, language, source, tokens)
            parsed = true
            fileImports.set(file, unit.imports)
            const edges: EdgeInput[] = []
            for (const fn of unit.functions) {
              const body = fn.body
                .slice(0, 4000)
                .map((t) => t.text)
                .join(" ")
                .slice(0, MAX_BODY_CHARS)
              const caller = indexSym(
                {
                  file,
                  line: fn.line,
                  name: fn.name,
                  kind: fn.kind,
                  snippet: `${fn.symbol} ${fn.name}(${fn.params.join(", ")})`.slice(0, 160),
                },
                `${fn.symbol} ${fn.name} ${fn.receiver} ${fn.kind} ${fn.params.join(" ")} ${file} ${body}`,
              )
              for (let i = 0; i < fn.body.length - 1; i++) {
                const t = fn.body[i]!.text
                if (!CALL_NAME_RE.test(t) || CALL_SKIP.has(t)) continue
                if (fn.body[i + 1]?.text !== "(") continue
                const dot = fn.body[i - 1]?.text === "."
                const receiver = dot && CALL_NAME_RE.test(fn.body[i - 2]?.text ?? "") ? fn.body[i - 2]!.text : ""
                edges.push({ caller, receiver, calleeName: t })
              }
            }
            pendingEdges.set(file, edges)
          } catch {
            parsed = false
          }
        }
      }
      if (!parsed) for (const sym of genericSyms(file, lines)) indexSym(sym.doc, sym.text)
      version++
    })

    // resolve a file's collected call edges + import graph once name tables are
    // current (after the bulk build, or per-file on incremental updates)
    const resolveFile = (file: string) => {
      const modules = moduleToFiles()
      resolveEdges(file, pendingEdges.get(file) ?? [], modules)
      addFileGraph(file, modules)
    }

    const removeFile = (file: string) => {
      removeFileDocs(chunkLex, file)
      removeFileDocs(symLex, file)
      removeFileDocs(pathLex, file)
      dropEdges(file)
      dropFileGraph(file)
      fileImports.delete(file)
      pendingEdges.delete(file)
      for (const key of [...byNameInFile.keys()]) {
        if (key.startsWith(`${file}#`)) byNameInFile.delete(key)
      }
      for (const [name, ids] of byName) {
        const live = ids.filter((id) => symLex.alive[id])
        if (live.length) byName.set(name, live)
        else byName.delete(name)
      }
      files.delete(file)
      version++
    }

    const buildIndex = Effect.gen(function* () {
      yolkEnabled = yield* extensions.enabled("turenlabs/yolk").pipe(Effect.catch(() => Effect.succeed(false)))
      const entries = yield* ripgrep
        .find({ cwd: dir, pattern: "*", limit: Number.MAX_SAFE_INTEGER })
        .pipe(Effect.catch(() => Effect.succeed([] as const)))
      const candidates = entries
        .map((entry) => entry.path as string)
        .filter((f) => f && EXTENSIONS.has(path.extname(f)) && !EXCLUDE.test(f))
      yield* Effect.forEach(candidates, indexFile, { concurrency: 16, discard: true })
      const modules = moduleToFiles()
      for (const file of pendingEdges.keys()) {
        resolveEdges(file, pendingEdges.get(file)!, modules)
      }
      for (const file of fileImports.keys()) addFileGraph(file, modules)
      built = true
    })

    const ensureIndex = Effect.fnUntraced(function* () {
      if (!built) {
        building ??= Effect.runPromise(
          buildIndex.pipe(Effect.catch(() => Effect.sync(() => (built = true))), Effect.asVoid),
        ).finally(() => (building = undefined))
        const pending = building
        yield* Effect.promise(() => pending)
        return
      }
      if (dirty.size) {
        const pending = [...dirty]
        dirty.clear()
        yield* Effect.forEach(
          pending,
          (file) =>
            Effect.gen(function* () {
              removeFile(file)
              yield* indexFile(file)
              if (files.has(file)) resolveFile(file)
            }),
          { concurrency: 16, discard: true },
        )
      }
    })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== dir) return Effect.void
      const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
      const file = path.relative(dir, data.file)
      if (file.startsWith("..") || !EXTENSIONS.has(path.extname(file)) || EXCLUDE.test(file)) return Effect.void
      return Effect.sync(() => {
        if (data.event === "unlink") {
          removeFile(file)
          dirty.delete(file)
        } else if (built) {
          dirty.add(file)
        }
      })
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const loadPotion = Effect.fnUntraced(function* () {
      if (potionFailures >= 3) return
      const cacheDir = path.join(Option.getOrElse(global, Global.make).cache, "code-search-embeddings")
      const pending = potion ?? (potion = load({ cacheDir }))
      const runtime = yield* Effect.tryPromise({ try: () => pending, catch: (error) => error }).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!runtime) {
        // transient download failures must not poison this location permanently,
        // but a hard-broken runtime should stop retrying
        if (potion === pending) potion = undefined
        potionFailures++
      }
      return runtime
    })

    const embed = (runtime: PotionRuntime, texts: string[]) =>
      Effect.try({ try: () => runtime.embed(texts), catch: () => undefined }).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )

    const expand = Effect.fnUntraced(function* (q: string) {
      const runtime = yield* loadPotion()
      if (!runtime) return new Map<string, number>()
      const dim = runtime.profile.dimension
      let th = thesaurus
      if (!th || th.version !== version || th.dim !== dim) {
        const vocab = [...chunkLex.inverted.keys()].filter((t) => {
          const df = chunkLex.df.get(t) ?? 0
          return t.length >= 3 && !STOP.has(t) && df >= 3 && df <= chunkLex.n * 0.1
        })
        const vecs = new Float32Array(vocab.length * dim)
        const embedded = yield* embed(runtime, vocab)
        if (!embedded) return new Map<string, number>()
        for (const [j, v] of embedded.entries()) {
          const off = j * dim
          vecs.set(v, off)
          let n2 = 0
          for (let d = 0; d < dim; d++) n2 += vecs[off + d]! ** 2
          const norm = Math.sqrt(n2) || 1
          for (let d = 0; d < dim; d++) vecs[off + d]! /= norm
        }
        th = { version, vocab, vecs, dim }
        thesaurus = th
      }
      const out = new Map<string, number>()
      const seen = new Set<string>()
      for (const w of new Set(terms(q))) {
        const v = yield* Effect.map(embed(runtime, [w]), (arr) => arr?.[0])
        if (!v) continue
        let n2 = 0
        for (let d = 0; d < dim; d++) n2 += v[d]! * v[d]!
        const qn = Math.sqrt(n2) || 1
        const scores = new Float64Array(th.vocab.length)
        for (let i = 0; i < th.vocab.length; i++) {
          let dot = 0
          const off = i * dim
          for (let d = 0; d < dim; d++) dot += th.vecs[off + d]! * v[d]!
          scores[i] = dot / qn
        }
        const idx = [...scores.keys()].sort((a, b) => scores[b]! - scores[a]!).slice(0, 6)
        for (const i of idx) {
          const s = scores[i]!
          const st = stem(th.vocab[i]!)
          if (s < 0.55 || seen.has(st) || !chunkLex.inverted.has(st)) continue
          seen.add(st)
          out.set(st, 0.6 * s)
        }
      }
      return out
    })

    const scoreQuery = Effect.fnUntraced(function* (q: string) {
      const stems = new Set(terms(q).map(stem))
      const expanded = new Map<string, number>()
      for (const t of stems) expanded.set(t, 1)
      for (const [t, w] of yield* expand(q)) expanded.set(t, Math.max(expanded.get(t) ?? 0, w))

      const chunkScores = bestPerFile(chunkLex, bm25Weighted(chunkLex, expanded, 2))
      const symScores = bestPerFile(symLex, spreadScores(bm25Weighted(symLex, expanded), adj, 0.5))
      const pathScores = bestPerFile(pathLex, bm25Weighted(pathLex, expanded))

      const fused = new Map<string, { score: number; doc: number; channel: LexIndex; top: number }>()
      const contribute = (channel: Map<string, { score: number; doc: number }>, weight: number, ix: LexIndex) => {
        for (const [f, hit] of channel) {
          const cur = fused.get(f) ?? { score: 0, doc: -1, channel: ix, top: 0 }
          cur.score += weight * hit.score
          const contribution = weight * hit.score
          if (contribution > cur.top) {
            cur.top = contribution
            cur.doc = hit.doc
            cur.channel = ix
          }
          fused.set(f, cur)
        }
      }
      contribute(chunkScores, 0.45, chunkLex)
      contribute(symScores, 0.35, symLex)
      contribute(pathScores, 0.2, pathLex)

      // anchor at the symbol declaration when it's a meaningful contributor —
      // decl line/name is a more precise answer than an arbitrary chunk offset
      for (const [f, hit] of symScores) {
        const cur = fused.get(f)
        if (cur && hit.score * 0.35 >= cur.top * 0.6) {
          cur.doc = hit.doc
          cur.channel = symLex
        }
      }

      // coverage bonus: fraction of distinct query stems present in the file
      const covSets = new Map<string, Set<string>>()
      for (const t of stems) {
        for (const { doc } of chunkLex.inverted.get(t) ?? []) {
          if (!chunkLex.alive[doc]) continue
          const f = chunkLex.docs[doc]!.file
          const set = covSets.get(f) ?? new Set<string>()
          set.add(t)
          covSets.set(f, set)
        }
      }
      for (const [f, cov] of covSets) {
        const cur = fused.get(f)
        if (cur) cur.score += 0.1 * (cov.size / Math.max(1, stems.size))
      }

      // same-dir locality
      const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 3)
      const dirs = new Set(top.map(([f]) => path.dirname(f)))
      const topFiles = new Set(top.map(([f]) => f))
      for (const [f, cur] of fused) {
        if (dirs.has(path.dirname(f)) && !topFiles.has(f)) cur.score += 0.05
      }

      // import-graph propagation: neighbors of top hits get a fraction
      for (const [f, cur] of top) {
        for (const nb of fileGraph.get(f) ?? []) {
          const existing = fused.get(nb)
          const boosted = cur.score * 0.3
          if (boosted > (existing?.score ?? 0)) {
            fused.set(nb, { score: boosted, doc: existing?.doc ?? -1, channel: chunkLex, top: 0 })
          }
        }
      }

      // intent routing: "callers/uses/... of X" ranks graph neighbors' files
      if (INTENT_RE.test(q) && callers.size) {
        const core = q
          .replace(INTENT_RE, " ")
          .replace(/\b(of|the|a|an|function|method|symbol|to|it|its|is|are|in|for)\b/gi, " ")
        const symBase = bm25Weighted(symLex, new Map(terms(core).map((t) => [stem(t), 1])))
        const ranked = [...symBase.keys()]
          .filter((d) => symLex.alive[d] && symBase[d]! > 0)
          .sort((a, b) => symBase[b]! - symBase[a]!)
          .slice(0, 8)
        for (const d of ranked) {
          for (const nb of callers.get(d) ?? []) {
            if (!symLex.alive[nb]) continue
            const f = symLex.docs[nb]!.file
            if (f === symLex.docs[d]!.file) continue
            const boosted = symBase[d]! * 0.8
            const existing = fused.get(f)
            if (boosted > (existing?.score ?? 0)) {
              fused.set(f, { score: boosted, doc: nb, channel: symLex, top: 0 })
            }
          }
        }
      }
      return fused
    })

    const snippetFor = Effect.fnUntraced(function* (hit: { file: string; doc: number; channel: LexIndex }) {
      const meta = hit.doc >= 0 ? hit.channel.docs[hit.doc] : undefined
      if (meta?.snippet) return meta
      const source = yield* fs.readFileStringSafe(path.join(dir, hit.file)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!source) return meta
      const line = meta?.line ?? 1
      const text = source.split("\n")[line - 1]?.trim().slice(0, 160)
      return meta ? { ...meta, snippet: text } : meta
    })

    return Service.of({
      search: (input) =>
        Effect.gen(function* () {
          yield* ensureIndex()
          const merged = new Map<string, { score: number; doc: number; channel: LexIndex }>()
          for (const q of input.queries.slice(0, 4)) {
            for (const [f, hit] of yield* scoreQuery(q)) {
              const cur = merged.get(f)
              if (!cur || hit.score > cur.score) merged.set(f, hit)
            }
          }
          const scope = input.path?.replace(/\/+$/, "")
          const ranked = [...merged.entries()]
            .filter(([f]) => !scope || f === scope || f.startsWith(`${scope}/`))
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, Math.min(input.limit ?? 20, MAX_RESULTS))
          return yield* Effect.forEach(
            ranked,
            ([file, hit]) =>
              Effect.map(snippetFor({ file, doc: hit.doc, channel: hit.channel }), (meta) =>
                Hit.make({
                  path: file,
                  line: meta?.line ?? 1,
                  name: meta?.name,
                  kind: meta?.kind,
                  snippet: meta?.snippet,
                  score: Math.round(hit.score * 1000) / 1000,
                }),
              ),
            { concurrency: 8 },
          )
        }),
    })
  }),
  )

export const layerWith = (load: PotionLoader) => makeLayer(load)

export const nodeWith = (load: PotionLoader) =>
  makeLocationNode({
    service: Service,
    layer: makeLayer(load),
    deps: [Location.node, Ripgrep.node, FSUtil.node, EventV2.node, ExtensionRuntime.node],
  })

export const node = nodeWith(Potion.load)
