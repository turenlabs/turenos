export * as CodeSearch from "."

import { Potion, type PotionLoadOptions, type PotionRuntime } from "@turenlabs/plugin/potion"
import { Context, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ExtensionRuntime } from "../extension"
import { Watcher } from "../filesystem/watcher"
import { Protected } from "../filesystem/protected"
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
const MAX_BODY_CHARS = 2000
const MAX_CANDIDATES = 128
const MAX_SYMBOLS_PER_FILE = 64
const MAX_CALLEES_PER_NAME = 20
const MAX_RESULTS = 40
const THESAURUS_REBUILD_MS = 2000

const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".toml",
  ".yaml",
  ".yml",
  ".sh",
  ".md",
  ".css",
  ".html",
  ".vue",
  ".svelte",
  ".zig",
  ".swift",
  ".kt",
])
const EXCLUDE =
  /(^|\/)(?:node_modules|\.worktrees|dist)\/|src\/generated|resources\/licenses|test\/fixtures|__snapshots__|\.snap$|bun\.lock$|\.min\.js$|\.wasm$|\.d\.ts$/i

// --- terms --------------------------------------------------------------------

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "when",
  "what",
  "how",
  "does",
  "are",
  "all",
  "its",
  "their",
  "them",
  "they",
  "you",
  "your",
  "our",
  "can",
  "not",
  "but",
  "use",
  "used",
  "using",
  "via",
  "per",
  "each",
  "any",
  "one",
  "two",
])

function terms(text: string): string[] {
  return text
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

const SUFFIXES = [
  "ational",
  "ation",
  "ingly",
  "ities",
  "tion",
  "ing",
  "edly",
  "ed",
  "ies",
  "es",
  "ers",
  "ors",
  "er",
  "or",
  "ly",
  "s",
]

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
  docs: (DocMeta | undefined)[]
  alive: boolean[]
  docLen: number[]
  // Interleaved document IDs and frequencies avoid one object per posting.
  inverted: Map<string, number[]>
  sumLen: number
  n: number
  fileDocs: Map<string, number[]>
  fileTerms: Map<string, Set<string>>
}

const newLex = (): LexIndex => ({
  docs: [],
  alive: [],
  docLen: [],
  inverted: new Map(),
  sumLen: 0,
  n: 0,
  fileDocs: new Map(),
  fileTerms: new Map(),
})

function addDoc(ix: LexIndex, doc: DocMeta, text: string) {
  const freqs = new Map<string, number>()
  for (const t of terms(text)) {
    const key = stem(t)
    freqs.set(key, (freqs.get(key) ?? 0) + 1)
  }
  const id = ix.docs.length
  const fileTerms = ix.fileTerms.get(doc.file) ?? new Set<string>()
  let len = 0
  for (const [t, f] of freqs) {
    len += f
    const postings = ix.inverted.get(t) ?? []
    postings.push(id, f)
    ix.inverted.set(t, postings)
    fileTerms.add(t)
  }
  ix.docs.push(doc)
  ix.alive.push(true)
  ix.docLen.push(len)
  ix.sumLen += len
  ix.n++
  ix.fileTerms.set(doc.file, fileTerms)
  const list = ix.fileDocs.get(doc.file) ?? []
  list.push(id)
  ix.fileDocs.set(doc.file, list)
}

function removeFileDocs(ix: LexIndex, file: string) {
  if (!ix.fileDocs.has(file)) return
  for (const id of ix.fileDocs.get(file) ?? []) {
    if (!ix.alive[id]) continue
    ix.alive[id] = false
    ix.n--
    ix.sumLen -= ix.docLen[id]!
    ix.docs[id] = undefined
    ix.docLen[id] = 0
  }
  for (const t of ix.fileTerms.get(file) ?? ix.inverted.keys()) {
    const postings = ix.inverted.get(t)!
    let write = 0
    for (let read = 0; read < postings.length; read += 2) {
      if (!ix.alive[postings[read]!]) continue
      postings[write++] = postings[read]!
      postings[write++] = postings[read + 1]!
    }
    postings.length = write
    if (!write) ix.inverted.delete(t)
  }
  ix.fileDocs.delete(file)
  ix.fileTerms.delete(file)
}

const K1 = 1.2
const B = 0.75

function bm25Weighted(ix: LexIndex, qterms: Map<string, number>, idfPower = 1): Float64Array {
  const scores = new Float64Array(ix.docs.length)
  const avg = ix.n > 0 ? ix.sumLen / ix.n : 1
  for (const [t, weight] of qterms) {
    const postings = ix.inverted.get(t)
    if (!postings?.length) continue
    const df = postings.length / 2
    const idf = Math.pow(Math.log(1 + (ix.n - df + 0.5) / (df + 0.5)), idfPower)
    for (let i = 0; i < postings.length; i += 2) {
      const doc = postings[i]!
      const freq = postings[i + 1]!
      if (!ix.alive[doc]) continue
      const dl = ix.docLen[doc]!
      scores[doc] += weight * idf * ((freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * dl) / avg)))
    }
  }
  return scores
}

/** Max-pool doc scores to file level, keeping the argmax doc for anchoring. */
function bestPerFile(ix: LexIndex, scores: Float64Array, scope?: string): Map<string, { score: number; doc: number }> {
  const out = new Map<string, { score: number; doc: number }>()
  let max = 0
  for (let i = 0; i < scores.length; i++) {
    if (!ix.alive[i] || scores[i]! <= 0) continue
    const file = ix.docs[i]!.file
    if (scope && file !== scope && !file.startsWith(`${scope}/`)) continue
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

const CALL_NAME_RE = /^[A-Za-z_$][\w$]*$/
const CALL_SKIP = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "new",
  "typeof",
  "constructor",
  "super",
  "do",
  "else",
  "case",
  "throw",
  "await",
  "yield",
  "in",
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
  [
    /^\s*(?:[\w$:<>,.*&\[\]?]+\s+){1,4}([A-Za-z_$][\w$]*)\s*\([^;]*?\)\s*(?:const\s*|noexcept\s*|throws[\w, ]*|->\s*[\w:<> ]+\s*)?\{\s*$/,
    "function",
  ],
]
const DECL_SKIP = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof",
  "new",
  "delete",
  "do",
  "else",
  "typedef",
  "using",
  "import",
  "require",
  "include",
  "print",
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
    if (out.length >= MAX_SYMBOLS_PER_FILE) break
    let name = "",
      kind = ""
    for (const [re, k] of GENERIC_DECL) {
      const m = lines[i]!.match(re)
      if (m && !DECL_SKIP.has(m[1]!)) {
        name = m[1]!
        kind = k
        break
      }
    }
    if (!name) continue
    const body = lines
      .slice(i, i + 25)
      .join("\n")
      .slice(0, MAX_BODY_CHARS)
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
      let chunkLex = newLex()
      let symLex = newLex()
      let pathLex = newLex()
      let discoveryLex = newLex()
      const semaphore = yield* Semaphore.make(1)
      let focus = new Set<string>()
      let callerIntent = false
      const files = new Map<string, { basename: string; test: boolean; vendor: boolean }>()
      const protectedPaths = Protected.under(dir)
      const eligible = (file: string) =>
        EXTENSIONS.has(path.extname(file)) &&
        !EXCLUDE.test(file) &&
        !protectedPaths.some((relative) => file === relative || file.startsWith(`${relative}/`))

      // graph state — populated only on the yolk path
      const adj = new Map<number, Set<number>>() // undirected, for spread
      const callers = new Map<number, Set<number>>() // callee doc -> caller docs, for intent
      const fileGraph = new Map<string, Set<string>>()
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
      let thesaurus: { version: number; builtAt: number; vocab: string[]; vecs: Float32Array; dim: number } | undefined
      const expansions = new Map<string, Map<string, number>>()
      let expansionVersion = -1

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

      const readSource = Effect.fnUntraced(function* (abs: string) {
        const info = yield* fs.stat(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info || info.type !== "File" || info.size > MAX_FILE_BYTES) return
        const source = yield* fs.readFileStringSafe(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (source === undefined || source.includes("\0")) return
        return source
      })

      const indexFile = Effect.fnUntraced(function* (file: string) {
        const abs = path.join(dir, file)
        const source = yield* readSource(abs)
        if (source === undefined) return

        const lines = source.split("\n").slice(0, MAX_FILE_LINES)
        for (const chunk of chunkDocs(file, lines)) addDoc(chunkLex, chunk.doc, chunk.text)

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
              const functions = unit.functions
                .map((fn) => ({
                  fn,
                  relevance:
                    (focus.has(fn.name.toLowerCase()) ? 2 : 0) +
                    (callerIntent && fn.body.some((token) => focus.has(token.text.toLowerCase())) ? 1 : 0),
                }))
                .sort((a, b) => b.relevance - a.relevance)
                .slice(0, MAX_SYMBOLS_PER_FILE)
              for (const { fn } of functions) {
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
      })

      const discoverFile = Effect.fnUntraced(function* (file: string) {
        if (!eligible(file)) return
        const source = yield* readSource(path.join(dir, file))
        if (source === undefined) return
        const counts = new Map<string, number>()
        for (const token of terms(source.slice(0, 64 * 1024))) {
          if (!STOP.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1)
        }
        const vocabulary = [...counts]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 256)
          .flatMap(([token, count]) => Array.from({ length: Math.min(count, 3) }, () => token))
          .join(" ")
        addDoc(discoveryLex, { file, line: 1 }, `${file} ${vocabulary}`)
        // Keep document IDs for updates, but avoid duplicating the global vocabulary per file.
        discoveryLex.fileTerms.delete(file)
        addDoc(pathLex, { file, line: 1 }, file)
        pathLex.fileTerms.delete(file)
        const basename = terms(path.basename(file, path.extname(file))).map(stem)
        files.set(file, {
          basename: basename.length > 1 ? ` ${basename.join(" ")} ` : "",
          test: /(^|\/)(?:tests?|specs?|__tests__|benchmark|script)\/|\.test\./.test(file),
          vendor: /(^|\/)(?:vendor|third_party)\//.test(file),
        })
      })

      const buildIndex = Effect.gen(function* () {
        yolkEnabled = yield* extensions.enabled("turenlabs/yolk").pipe(Effect.catch(() => Effect.succeed(false)))
        discoveryLex = newLex()
        pathLex = newLex()
        files.clear()
        // A failed walk must fail the build rather than index nothing: `built` would
        // otherwise cache an empty corpus, and every query in this directory would answer
        // "No results found" until the process restarted. The next search retries.
        const entries = yield* ripgrep.find({ cwd: dir, pattern: "*", limit: Number.MAX_SAFE_INTEGER }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("code search could not list workspace files; the next search retries", {
              directory: dir,
              error: error.message,
            }),
          ),
        )
        const candidates = entries.map((entry) => entry.path as string).filter(eligible)
        yield* Effect.forEach(candidates, discoverFile, { concurrency: 2, discard: true })
        version++
        built = true
      })

      const ensureIndex = Effect.fnUntraced(function* () {
        if (!built) {
          building ??= Effect.runPromise(buildIndex.pipe(Effect.asVoid)).finally(() => (building = undefined))
          const pending = building
          yield* Effect.tryPromise({ try: () => pending, catch: (cause) => cause })
        }
        if (dirty.size) {
          const pending = [...dirty]
          dirty.clear()
          yield* Effect.forEach(
            pending,
            (file) =>
              Effect.gen(function* () {
                removeFileDocs(discoveryLex, file)
                removeFileDocs(pathLex, file)
                files.delete(file)
                yield* discoverFile(file)
              }),
            { concurrency: 2, discard: true },
          ).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() => {
                    for (const file of pending) dirty.add(file)
                  })
                : Effect.void,
            ),
          )
          version++
        }
      })

      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== dir) return Effect.void
        const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
        const file = path.relative(dir, data.file).replaceAll("\\", "/")
        if (file.startsWith("..") || !eligible(file)) return Effect.void
        return Effect.sync(() => {
          dirty.add(file)
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
        // Direct matches stay current while vocabulary rebuilds are throttled during file churn.
        const rebuildDue =
          thesaurus && thesaurus.version !== version && Date.now() - thesaurus.builtAt >= THESAURUS_REBUILD_MS
        if (expansionVersion !== version || rebuildDue) {
          expansions.clear()
          expansionVersion = version
        }
        const cached = expansions.get(q)
        if (cached) return cached
        const runtime = yield* loadPotion()
        if (!runtime) return new Map<string, number>()
        const dim = runtime.profile.dimension
        let th = thesaurus
        if (!th || rebuildDue || th.dim !== dim) {
          const vocab = [...discoveryLex.inverted.keys()].filter((t) => {
            const df = (discoveryLex.inverted.get(t)?.length ?? 0) / 2
            return t.length >= 3 && !STOP.has(t) && df >= 1 && df <= discoveryLex.n * 0.1
          })
          vocab.sort((a, b) => discoveryLex.inverted.get(b)!.length - discoveryLex.inverted.get(a)!.length)
          vocab.length = Math.min(vocab.length, 4096)
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
          th = { version, builtAt: Date.now(), vocab, vecs, dim }
          thesaurus = th
        }
        const out = new Map<string, number>()
        const seen = new Set<string>()
        for (const w of new Set(terms(q).filter((t) => !STOP.has(t)))) {
          const v = yield* Effect.map(embed(runtime, [w]), (arr) => arr?.[0])
          if (!v) continue
          let n2 = 0
          for (let d = 0; d < dim; d++) n2 += v[d]! * v[d]!
          const qn = Math.sqrt(n2) || 1
          const top: { index: number; score: number }[] = []
          for (let i = 0; i < th.vocab.length; i++) {
            let dot = 0
            const off = i * dim
            for (let d = 0; d < dim; d++) dot += th.vecs[off + d]! * v[d]!
            const score = dot / qn
            if (score < 0.55 || (top.length === 6 && score <= top[5]!.score)) continue
            const position = top.findIndex((hit) => score > hit.score)
            top.splice(position < 0 ? top.length : position, 0, { index: i, score })
            if (top.length > 6) top.pop()
          }
          for (const hit of top) {
            const st = stem(th.vocab[hit.index]!)
            if (seen.has(st) || !discoveryLex.inverted.has(st)) continue
            seen.add(st)
            out.set(st, 0.2 * hit.score)
          }
        }
        if (expansions.size >= 128) expansions.delete(expansions.keys().next().value!)
        expansions.set(q, out)
        return out
      })

      const selectCandidates = Effect.fnUntraced(function* (queries: readonly string[], scope?: string) {
        callerIntent = queries.some((query) => INTENT_RE.test(query))
        focus = new Set(
          queries
            .flatMap((query) => query.replace(INTENT_RE, " ").match(/[A-Za-z_$][\w$]*/g) ?? [])
            .map((token) => token.toLowerCase())
            .filter((token) => !STOP.has(token)),
        )
        const scores = new Map<string, number>()
        const covered = new Map<string, Set<string>>()
        const add = (file: string, score: number) => {
          if (!files.has(file) || (scope && file !== scope && !file.startsWith(`${scope}/`))) return
          scores.set(file, (scores.get(file) ?? 0) + score)
        }
        for (const query of queries.slice(0, 4)) {
          const tokens = [...new Set(terms(query).filter((token) => !STOP.has(token)))]
          const weighted = new Map(tokens.map((token) => [stem(token), 1]))
          for (const [token, weight] of yield* expand(query))
            weighted.set(token, Math.max(weighted.get(token) ?? 0, weight))
          for (const [file, hit] of bestPerFile(discoveryLex, bm25Weighted(discoveryLex, weighted, 2), scope))
            add(file, hit.score)
          for (const [file, hit] of bestPerFile(pathLex, bm25Weighted(pathLex, weighted), scope))
            add(file, 0.6 * hit.score)
          for (const token of tokens) {
            const postings = discoveryLex.inverted.get(stem(token)) ?? []
            for (let i = 0; i < postings.length; i += 2) {
              const id = postings[i]!
              if (!discoveryLex.alive[id]) continue
              const file = discoveryLex.docs[id]!.file
              const set = covered.get(file) ?? new Set<string>()
              set.add(stem(token))
              covered.set(file, set)
            }
          }
          // Recover absent or rare identifiers that the sampled file vocabulary omitted.
          const rare = tokens
            .sort(
              (a, b) =>
                (discoveryLex.inverted.get(stem(a))?.length ?? 0) - (discoveryLex.inverted.get(stem(b))?.length ?? 0),
            )
            .slice(0, 4)
          for (const token of rare) {
            if ((discoveryLex.inverted.get(stem(token))?.length ?? 0) > 6) continue
            const matches = yield* ripgrep
              .grep({
                cwd: dir,
                file: scope || undefined,
                pattern: `(?i)${token}`,
                include: `*.{${[...EXTENSIONS].map((ext) => ext.slice(1)).join(",")}}`,
                limit: 2048,
              })
              .pipe(
                // Rare-term recovery only adds candidates; ranking still works without it.
                Effect.catch((error) =>
                  Effect.logWarning("code search rare-term grep failed", { token, error: error.message }).pipe(
                    Effect.as([] as const),
                  ),
                ),
              )
            const matched = new Set<string>()
            for (const match of matches) {
              const file = match.entry.path as string
              if (!files.has(file)) continue
              const set = covered.get(file) ?? new Set<string>()
              set.add(stem(token))
              covered.set(file, set)
              matched.add(file)
            }
            for (const file of matched) add(file, 0.15)
          }
        }
        const stems = new Set(
          queries.slice(0, 4).flatMap((query) =>
            terms(query)
              .filter((token) => !STOP.has(token))
              .map(stem),
          ),
        )
        const preferSource = !scope && !queries.some((query) => /\b(tests?|specs?|benchmarks?)\b/i.test(query))
        const preferLocal = !scope && !queries.some((query) => /\b(vendor|vendored|third.party)\b/i.test(query))
        for (const [file, score] of scores) {
          const hints = files.get(file)!
          const coverage = (covered.get(file)?.size ?? 0) / Math.max(1, stems.size)
          scores.set(
            file,
            (score + coverage) * (preferSource && hints.test ? 0.8 : 1) * (preferLocal && hints.vendor ? 0.65 : 1),
          )
        }
        const selected = [...scores]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, MAX_CANDIDATES)
          .map(([file]) => file)
        chunkLex = newLex()
        symLex = newLex()
        adj.clear()
        callers.clear()
        fileGraph.clear()
        fileImports.clear()
        byName.clear()
        byNameInFile.clear()
        pendingEdges.clear()
        if (typeof Bun !== "undefined") Bun.gc(true)
        yield* Effect.forEach(selected, indexFile, { concurrency: 2, discard: true })
        const modules = new Map<string, string[]>()
        for (const file of selected) {
          const noExt = file.replace(/\.[^.]+$/, "")
          for (const key of [noExt, path.basename(noExt)]) {
            const list = modules.get(key) ?? []
            list.push(file)
            modules.set(key, list)
          }
        }
        for (const file of pendingEdges.keys()) resolveEdges(file, pendingEdges.get(file)!, modules)
        for (const file of fileImports.keys()) addFileGraph(file, modules)
      })

      const scoreQuery = Effect.fnUntraced(function* (q: string, scope?: string) {
        const stems = new Set(
          terms(q)
            .filter((t) => !STOP.has(t))
            .map(stem),
        )
        if (!stems.size) return new Map<string, { score: number; doc: number; channel: LexIndex; top: number }>()
        const expanded = new Map<string, number>()
        for (const t of stems) expanded.set(t, 1)
        const literal = new Map(expanded)
        for (const [t, w] of yield* expand(q)) expanded.set(t, Math.max(expanded.get(t) ?? 0, w))
        // Semantic-only names must not outrank an exact content match in another file.
        const structural = [...stems].some(
          (t) => chunkLex.inverted.has(t) || symLex.inverted.has(t) || pathLex.inverted.has(t),
        )
          ? literal
          : expanded

        const chunkScores = bestPerFile(chunkLex, bm25Weighted(chunkLex, expanded, 2), scope)
        const symScores = bestPerFile(symLex, spreadScores(bm25Weighted(symLex, structural), adj, 0.5), scope)
        const pathScores = bestPerFile(pathLex, bm25Weighted(pathLex, structural), scope)

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
          const postings = chunkLex.inverted.get(t) ?? []
          for (let i = 0; i < postings.length; i += 2) {
            const doc = postings[i]!
            if (!chunkLex.alive[doc]) continue
            const f = chunkLex.docs[doc]!.file
            if (!fused.has(f)) continue
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
              fused.set(nb, {
                score: boosted,
                doc: existing?.doc ?? -1,
                channel: existing?.channel ?? chunkLex,
                top: 0,
              })
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
        const queryTerms = ` ${terms(q).map(stem).join(" ")} `
        const exactName = CALL_NAME_RE.test(q.trim()) ? q.trim().toLowerCase() : undefined
        const preferSource = !scope && !/\b(test|tests|spec|specs|benchmark|benchmarks)\b/i.test(q)
        const preferLocal = !scope && !/\b(vendor|vendored|third.party)\b/i.test(q)
        for (const [file, hit] of fused) {
          const hints = files.get(file)
          const symbol = symScores.get(file)
          if (exactName && symbol && symLex.docs[symbol.doc]?.name?.toLowerCase() === exactName) hit.score += 0.3
          // Named implementation files outrank incidental mentions of their names.
          if (hints?.basename && queryTerms.includes(hints.basename)) hit.score += 0.2
          // Keep dependencies and tests searchable, but prefer first-party code by default.
          if (preferSource && hints?.test) hit.score *= 0.8
          if (preferLocal && hints?.vendor) hit.score *= 0.65
        }
        return fused
      })

      const snippetFor = Effect.fnUntraced(function* (hit: { file: string; doc: number; channel: LexIndex }) {
        const meta = hit.doc >= 0 ? hit.channel.docs[hit.doc] : undefined
        if (meta?.snippet) return meta
        const source = yield* fs
          .readFileStringSafe(path.join(dir, hit.file))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!source) return meta
        const line = meta?.line ?? 1
        const text = source.split("\n")[line - 1]?.trim().slice(0, 160)
        return meta ? { ...meta, snippet: text } : meta
      })

      return Service.of({
        search: (input) =>
          semaphore.withPermit(
            Effect.gen(function* () {
              yield* ensureIndex()
              const scope = input.path?.replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\.$/, "")
              yield* selectCandidates(input.queries.slice(0, 4), scope)
              const merged = new Map<string, { score: number; doc: number; channel: LexIndex }>()
              for (const q of input.queries.slice(0, 4)) {
                for (const [f, hit] of yield* scoreQuery(q, scope)) {
                  const cur = merged.get(f)
                  if (!cur || hit.score > cur.score) merged.set(f, hit)
                }
              }
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
          ),
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
