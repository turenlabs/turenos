export * as Streaming from "./streaming"

// Keep discovery data global. Build detailed indexes for at most 192 files per request.
export function transform(source: string): string {
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error(`streaming: expected one anchor: ${before.slice(0, 100)}`)
    source = source.replace(before, after)
  }
  const region = (start: string, end: string, text: string) => {
    const first = source.indexOf(start)
    const last = source.indexOf(end, first + start.length)
    if (first < 0 || last < 0 || source.indexOf(start, first + 1) >= 0 || source.indexOf(end, last + 1) >= 0)
      throw new Error(`streaming: invalid region: ${start}`)
    source = source.slice(0, first) + text + source.slice(last)
  }

  replace("const MAX_BODY_CHARS = 8000", "const MAX_BODY_CHARS = 2000")
  replace(
    "    const chunkLex = newLex()",
    "    let chunkLex = newLex()\n    let discoveryLex = newLex()\n    let requestTail = Promise.resolve()",
  )
  replace("    const symLex = newLex()", "    let symLex = newLex()")
  replace("    const pathLex = newLex()", "    let pathLex = newLex()")
  region("      addDoc(pathLex, { file, line: 1 }, file)", "      let parsed = false", "")
  replace("for (const fn of unit.functions)", "for (const fn of unit.functions.slice(0, 128))")
  replace("for (const sym of genericSyms(file, lines))", "for (const sym of genericSyms(file, lines).slice(0, 128))")
  replace("      version++\n    })", "    })")

  region(
    "    const buildIndex = Effect.gen",
    "    const loadPotion =",
    `    const buildIndex = Effect.gen(function* () {
      yolkEnabled = yield* extensions.enabled("turenlabs/yolk").pipe(Effect.catch(() => Effect.succeed(false)))
      discoveryLex = newLex()
      pathLex = newLex()
      files.clear()
      const entries = yield* ripgrep.find({ cwd: dir, pattern: "*", limit: Number.MAX_SAFE_INTEGER })
        .pipe(Effect.catch(() => Effect.succeed([] as const)))
      const candidates = entries.map((entry) => entry.path as string)
        .filter((file) => file && EXTENSIONS.has(path.extname(file)) && !EXCLUDE.test(file))
      yield* Effect.forEach(candidates, (file) => Effect.gen(function* () {
        const abs = path.join(dir, file)
        const info = yield* fs.stat(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info || info.type !== "File" || info.size > MAX_FILE_BYTES) return
        const source = yield* fs.readFileStringSafe(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (source === undefined || source.includes("\\0")) return
        // Store frequent vocabulary only. Ripgrep can recover omitted rare terms.
        const counts = new Map<string, number>()
        for (const token of terms(source.slice(0, 64 * 1024))) {
          if (!STOP.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1)
        }
        const vocabulary = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 256)
          .flatMap(([token, count]) => Array.from({ length: Math.min(count, 3) }, () => token)).join(" ")
        addDoc(discoveryLex, { file, line: 1 }, file + " " + vocabulary)
        // Discovery is rebuilt after changes. It needs no per-file deletion tables.
        discoveryLex.fileTerms.delete(file)
        discoveryLex.fileDocs.delete(file)
        addDoc(pathLex, { file, line: 1 }, file)
        pathLex.fileTerms.delete(file)
        pathLex.fileDocs.delete(file)
        const basename = terms(path.basename(file, path.extname(file))).map(stem)
        files.set(file, {
          basename: basename.length > 1 ? " " + basename.join(" ") + " " : "",
          test: /(^|\\/)(?:tests?|specs?|__tests__|benchmark|script)\\/|\\.test\\./.test(file),
          vendor: /(^|\\/)(?:vendor|third_party)\\//.test(file),
        })
      }), { concurrency: 2, discard: true })
      version++
      built = true
    })

    const ensureIndex = Effect.fnUntraced(function* () {
      if (built) return
      building ??= Effect.runPromise(buildIndex.pipe(Effect.asVoid)).finally(() => (building = undefined))
      const pending = building
      yield* Effect.promise(() => pending)
    })

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== dir) return Effect.void
      const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
      const file = path.relative(dir, data.file)
      if (file.startsWith("..") || !EXTENSIONS.has(path.extname(file)) || EXCLUDE.test(file)) return Effect.void
      return Effect.sync(() => { built = false })
    })
    yield* Effect.addFinalizer(() => unsubscribe)

`,
  )

  const expandStart = source.indexOf("    const expand =")
  const expandEnd = source.indexOf("    const scoreQuery =", expandStart)
  if (expandStart < 0 || expandEnd < 0) throw new Error("streaming: missing expansion region")
  const expansion = source.slice(expandStart, expandEnd)
  if (!expansion.includes("chunkLex")) throw new Error("streaming: missing discovery vocabulary anchor")
  replace(expansion, expansion.replaceAll("chunkLex", "discoveryLex"))
  replace(
    "        const vecs =",
    "        vocab.sort((a, b) => discoveryLex.inverted.get(b)!.length - discoveryLex.inverted.get(a)!.length)\n        vocab.length = Math.min(vocab.length, 4096)\n        const vecs =",
  )

  replace(
    "    const scoreQuery =",
    `    const selectCandidates = Effect.fnUntraced(function* (queries: readonly string[], scope?: string) {
      const scores = new Map<string, number>()
      const covered = new Map<string, Set<string>>()
      const add = (file: string, score: number) => {
        if (!files.has(file) || (scope && file !== scope && !file.startsWith(scope + "/"))) return
        scores.set(file, (scores.get(file) ?? 0) + score)
      }
      for (const query of queries.slice(0, 4)) {
        const tokens = [...new Set(terms(query).filter((token) => !STOP.has(token)))]
        const weighted = new Map(tokens.map((token) => [stem(token), 1]))
        for (const [token, weight] of yield* expand(query)) weighted.set(token, Math.max(weighted.get(token) ?? 0, weight))
        for (const [file, hit] of bestPerFile(discoveryLex, bm25Weighted(discoveryLex, weighted, 2), scope)) add(file, hit.score)
        for (const [file, hit] of bestPerFile(pathLex, bm25Weighted(pathLex, weighted), scope)) add(file, 0.6 * hit.score)
        for (const token of tokens) {
          const postings = discoveryLex.inverted.get(stem(token)) ?? []
          for (let i = 0; i < postings.length; i += 2) {
            const file = discoveryLex.docs[postings[i]!]!.file
            const set = covered.get(file) ?? new Set<string>()
            set.add(stem(token))
            covered.set(file, set)
          }
        }
        // Separate rare-term scans avoid a common OR term consuming the match budget.
        const rare = tokens.sort((a, b) => (discoveryLex.inverted.get(stem(a))?.length ?? 0) -
          (discoveryLex.inverted.get(stem(b))?.length ?? 0)).slice(0, 4)
        for (const token of rare) {
          const matches = yield* ripgrep.grep({ cwd: dir, file: scope || undefined,
            pattern: "(?i)" + token, limit: 2048 }).pipe(Effect.catch(() => Effect.succeed([] as const)))
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
      const stems = new Set(queries.slice(0, 4).flatMap((query) => terms(query).filter((token) => !STOP.has(token)).map(stem)))
      const preferSource = !scope && !queries.some((query) => /\\b(tests?|specs?|benchmarks?)\\b/i.test(query))
      const preferLocal = !scope && !queries.some((query) => /\\b(vendor|vendored|third.party)\\b/i.test(query))
      for (const [file, score] of scores) {
        const hints = files.get(file)!
        const coverage = (covered.get(file)?.size ?? 0) / Math.max(1, stems.size)
        scores.set(file, (score + coverage) * (preferSource && hints.test ? 0.8 : 1) *
          (preferLocal && hints.vendor ? 0.65 : 1))
      }
      const selected = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 192).map(([file]) => file)
      chunkLex = newLex()
      symLex = newLex()
      adj.clear()
      callers.clear()
      fileGraph.clear()
      fileEdges.clear()
      fileImports.clear()
      byName.clear()
      byNameInFile.clear()
      pendingEdges.clear()
      yield* Effect.forEach(selected, indexFile, { concurrency: 2, discard: true })
      // Caller and import edges exist only within this request's candidate set.
      const modules = new Map<string, string[]>()
      for (const file of selected) {
        const noExt = file.replace(/\\.[^.]+$/, "")
        for (const key of [noExt, path.basename(noExt)]) {
          const list = modules.get(key) ?? []
          list.push(file)
          modules.set(key, list)
        }
      }
      for (const file of pendingEdges.keys()) resolveEdges(file, pendingEdges.get(file)!, modules)
      for (const file of fileImports.keys()) addFileGraph(file, modules)
    })

    const scoreQuery =`,
  )
  replace(
    `      search: (input) =>
        Effect.gen(function* () {`,
    `      search: (input) =>
        Effect.acquireUseRelease(
          Effect.uninterruptible(Effect.promise(() => {
            const pending = requestTail
            let release!: () => void
            requestTail = new Promise<void>((resolve) => { release = resolve })
            return pending.then(() => release)
          })),
          () => Effect.gen(function* () {`,
  )
  replace(
    "          const merged = new Map<string, { score: number; doc: number; channel: LexIndex }>()",
    "          yield* selectCandidates(input.queries, scope)\n          const merged = new Map<string, { score: number; doc: number; channel: LexIndex }>()",
  )
  replace("        }),\n    })", "          }),\n          (release) => Effect.sync(release),\n        ),\n    })")
  return source
}
