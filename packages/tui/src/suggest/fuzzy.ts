/** 0 for a prefix, 1 for the start of a later word, 2 for letters in order, undefined for no match. */
export function fuzzyRank(query: string, text: string) {
  const wanted = query.toLowerCase()
  const name = text.toLowerCase()
  if (!wanted || name.startsWith(wanted)) return 0
  if (name.split(/[^a-z0-9]+/).some((word) => word.startsWith(wanted))) return 1
  let next = 0
  for (const letter of name) if (letter === wanted[next]) next++
  return next === wanted.length ? 2 : undefined
}

/** The items whose text matches, best match first and original order within a rank. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string) {
  return items
    .flatMap((item, index) => {
      const rank = fuzzyRank(query, text(item))
      return rank === undefined ? [] : [{ item, rank, index }]
    })
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item)
}
