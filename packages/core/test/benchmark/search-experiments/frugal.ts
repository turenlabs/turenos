export * as Frugal from "./frugal"

import { Structural } from "./structural"

export function transform(source: string): string {
  const replacements = [
    [
      "inverted: Map<string, { term: string; rows: number[] }>",
      "inverted: Map<string, { term: string; rows: Uint32Array; length: number }>",
    ],
    [
      "const entry = ix.inverted.get(t) ?? { term: t, rows: [] }\n    entry.rows.push(id, f)",
      `const entry = ix.inverted.get(t) ?? { term: t, rows: new Uint32Array(4), length: 0 }
    if (entry.length + 2 > entry.rows.length) {
      const rows = new Uint32Array(entry.rows.length * 2)
      rows.set(entry.rows)
      entry.rows = rows
    }
    entry.rows[entry.length++] = id
    entry.rows[entry.length++] = f`,
    ],
    [
      "const postings = ix.inverted.get(t)!.rows\n    let write = 0\n    for (let read = 0; read < postings.length; read += 2)",
      "const entry = ix.inverted.get(t)!\n    const postings = entry.rows\n    let write = 0\n    for (let read = 0; read < entry.length; read += 2)",
    ],
    ["    postings.length = write", "    entry.length = write"],
    [
      "const postings = ix.inverted.get(t)?.rows\n    if (!postings?.length) continue\n    const df = postings.length / 2",
      "const entry = ix.inverted.get(t)\n    if (!entry?.length) continue\n    const postings = entry.rows\n    const df = entry.length / 2",
    ],
    [
      "    for (let i = 0; i < postings.length; i += 2) {\n      const doc = postings[i]!",
      "    for (let i = 0; i < entry.length; i += 2) {\n      const doc = postings[i]!",
    ],
    ["chunkLex.inverted.get(t)?.rows.length", "chunkLex.inverted.get(t)?.length"],
    [
      "const postings = chunkLex.inverted.get(t)?.rows ?? []\n        for (let i = 0; i < postings.length; i += 2)",
      "const entry = chunkLex.inverted.get(t)\n        if (!entry?.length) continue\n        const postings = entry.rows\n        for (let i = 0; i < entry.length; i += 2)",
    ],
    [
      "doc: { file, line: i + 1, name, kind, snippet: lines[i]!.trim().slice(0, 160) },",
      "doc: { file, line: i + 1, name, kind },",
    ],
    ['                  snippet: `${fn.symbol} ${fn.name}(${fn.params.join(", ")})`.slice(0, 160),\n', ""],
  ] as const

  return replacements.reduce((text, [before, after]) => {
    const index = text.indexOf(before)
    if (index < 0 || index !== text.lastIndexOf(before)) {
      throw new Error(`Expected one frugal marker: ${before}`)
    }
    return text.replace(before, after)
  }, Structural.transform(source))
}
