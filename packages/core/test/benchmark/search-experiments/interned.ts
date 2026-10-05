export * as Interned from "./interned"

export function transform(source: string) {
  const replacements = [
    ["inverted: Map<string, number[]>", "inverted: Map<string, { term: string; rows: number[] }>"],
    [
      "const postings = ix.inverted.get(t) ?? []\n    postings.push(id, f)\n    ix.inverted.set(t, postings)\n    fileTerms.add(t)",
      "const entry = ix.inverted.get(t) ?? { term: t, rows: [] }\n    entry.rows.push(id, f)\n    ix.inverted.set(t, entry)\n    fileTerms.add(entry.term)",
    ],
    ["const postings = ix.inverted.get(t)!", "const postings = ix.inverted.get(t)!.rows"],
    ["const postings = ix.inverted.get(t)\n", "const postings = ix.inverted.get(t)?.rows\n"],
    ["chunkLex.inverted.get(t)?.length", "chunkLex.inverted.get(t)?.rows.length"],
    ["const postings = chunkLex.inverted.get(t) ?? []", "const postings = chunkLex.inverted.get(t)?.rows ?? []"],
  ] as const
  return replacements.reduce((text, [before, after]) => {
    if (!text.includes(before)) throw new Error(`Missing interned experiment marker: ${before}`)
    return text.replaceAll(before, after)
  }, source)
}
