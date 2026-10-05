// This experiment moves postings to disk without changing rank scoring.
export function transform(source: string): string {
  const replace = (before: string | RegExp, after: string) => {
    const matches = typeof before === "string" ? source.split(before).length - 1 : [...source.matchAll(before)].length
    if (matches !== 1) throw new Error(`btree transform expected one match, got ${matches}: ${before}`)
    source = source.replace(before, () => after)
  }

  replace(
    'import path from "path"',
    `import path from "path"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"`,
  )

  replace(
    /type LexIndex = \{[\s\S]*?\nconst K1 = 1\.2/g,
    `type LexIndex = {
  docs: (DocMeta | undefined)[]
  alive: boolean[]
  docLen: number[]
  sumLen: number
  n: number
  fileDocs: Map<string, number[]>
  postings: (term: string) => Iterable<{ doc: number; freq: number }>
  df: (term: string) => number
  vocabulary: (maximum: number) => string[]
  insert: (term: string, doc: number, freq: number) => void
  remove: (doc: number) => void
  transaction: (body: () => void) => void
}

function newLex(database: Database, channel: number): LexIndex {
  const postings = database.query<{ doc: number; freq: number }, [number, string]>(
    "SELECT doc, freq FROM posting WHERE channel = ? AND term = ? ORDER BY doc",
  )
  const df = database.query<{ df: number }, [number, string]>(
    "SELECT df FROM vocabulary WHERE channel = ? AND term = ?",
  )
  const vocabulary = database.query<{ term: string }, [number, number]>(
    "SELECT term FROM vocabulary WHERE channel = ? AND length(term) >= 3 AND df >= 3 AND df <= ? ORDER BY ordinal",
  )
  const insert = database.query("INSERT INTO posting (channel, term, doc, freq) VALUES (?, ?, ?, ?)")
  const remove = database.query("DELETE FROM posting WHERE channel = ? AND doc = ?")
  return {
    docs: [], alive: [], docLen: [], sumLen: 0, n: 0, fileDocs: new Map(),
    postings: (term) => postings.iterate(channel, term),
    df: (term) => df.get(channel, term)?.df ?? 0,
    vocabulary: (maximum) => vocabulary.all(channel, maximum).map((row) => row.term).filter((term) => !STOP.has(term)),
    insert: (term, doc, freq) => { insert.run(channel, term, doc, freq) },
    remove: (doc) => { remove.run(channel, doc) },
    transaction: (body) => { database.transaction(body)() },
  }
}

function addDoc(ix: LexIndex, doc: DocMeta, text: string) {
  const freqs = new Map<string, number>()
  for (const t of terms(text)) {
    const key = stem(t)
    freqs.set(key, (freqs.get(key) ?? 0) + 1)
  }
  const id = ix.docs.length
  let len = 0
  for (const [t, f] of freqs) {
    len += f
    ix.insert(t, id, f)
  }
  ix.docs.push(doc)
  ix.alive.push(true)
  ix.docLen.push(len)
  ix.sumLen += len
  ix.n++
  const list = ix.fileDocs.get(doc.file) ?? []
  list.push(id)
  ix.fileDocs.set(doc.file, list)
}

function removeFileDocs(ix: LexIndex, file: string) {
  ix.transaction(() => {
    for (const id of ix.fileDocs.get(file) ?? []) {
      if (!ix.alive[id]) continue
      ix.remove(id)
      ix.alive[id] = false
      ix.n--
      ix.sumLen -= ix.docLen[id]!
      ix.docs[id] = undefined
      ix.docLen[id] = 0
    }
    ix.fileDocs.delete(file)
  })
}

const K1 = 1.2`,
  )

  replace(
    `    const postings = ix.inverted.get(t)
    if (!postings?.length) continue
    const df = postings.length / 2`,
    `    const df = ix.df(t)
    if (!df) continue`,
  )
  replace(
    `    for (let i = 0; i < postings.length; i += 2) {
      const doc = postings[i]!
      const freq = postings[i + 1]!`,
    `    for (const { doc, freq } of ix.postings(t)) {`,
  )

  replace(
    `    const chunkLex = newLex()
    const symLex = newLex()
    const pathLex = newLex()`,
    `    const temporary = mkdtempSync(path.join(tmpdir(), "code-search-btree-"))
    const database = new Database(path.join(temporary, "postings.sqlite"))
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      try { database.close() } finally { rmSync(temporary, { recursive: true, force: true }) }
    }))
    database.exec(\`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = OFF;
      PRAGMA cache_size = -16384;
      PRAGMA temp_store = FILE;
      PRAGMA mmap_size = 0;
      CREATE TABLE posting (
        channel INTEGER NOT NULL,
        term TEXT NOT NULL,
        doc INTEGER NOT NULL,
        freq INTEGER NOT NULL,
        PRIMARY KEY (channel, term, doc)
      ) WITHOUT ROWID;
      CREATE INDEX posting_doc ON posting (channel, doc);
      CREATE TABLE vocabulary (
        ordinal INTEGER PRIMARY KEY,
        channel INTEGER NOT NULL,
        term TEXT NOT NULL,
        df INTEGER NOT NULL,
        UNIQUE (channel, term)
      );
      CREATE TRIGGER posting_insert AFTER INSERT ON posting BEGIN
        INSERT INTO vocabulary (channel, term, df) VALUES (new.channel, new.term, 1)
          ON CONFLICT (channel, term) DO UPDATE SET df = df + 1;
      END;
      CREATE TRIGGER posting_delete AFTER DELETE ON posting BEGIN
        UPDATE vocabulary SET df = df - 1 WHERE channel = old.channel AND term = old.term;
        DELETE FROM vocabulary WHERE channel = old.channel AND term = old.term AND df = 0;
      END;
    \`)
    const chunkLex = newLex(database, 0)
    const symLex = newLex(database, 1)
    const pathLex = newLex(database, 2)`,
  )

  // No Effect yields occur in this block. Concurrent file reads finish before each transaction starts.
  const body = source.match(
    /      const lines = source\.split\("\\n"\)\.slice\(0, MAX_FILE_LINES\)[\s\S]*?      version\+\+\n    \}\)/g,
  )
  if (body?.length !== 1) throw new Error("btree transform expected one synchronous indexFile body")
  replace(
    body[0]!,
    `      database.transaction(() => {
${body[0]!.slice(0, -7)}
      })()
    })`,
  )

  replace(
    `        const vocab = [...chunkLex.inverted.keys()].filter((t) => {
          const df = (chunkLex.inverted.get(t)?.length ?? 0) / 2
          return t.length >= 3 && !STOP.has(t) && df >= 3 && df <= chunkLex.n * 0.1
        })`,
    `        const vocab = chunkLex.vocabulary(chunkLex.n * 0.1)`,
  )
  replace("!chunkLex.inverted.has(st)", "!chunkLex.df(st)")
  replace(
    `        const postings = chunkLex.inverted.get(t) ?? []
        for (let i = 0; i < postings.length; i += 2) {
          const doc = postings[i]!`,
    `        for (const { doc } of chunkLex.postings(t)) {`,
  )

  if (/\.inverted\b|\.fileTerms\b/.test(source)) throw new Error("btree transform left an in-memory posting reference")
  return source
}
