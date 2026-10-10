/** A stored teammate handle: lowercase, as the server keeps it; mentions match it in any case. */
export const teammateHandle = /^[a-z][a-z0-9_-]{0,31}$/

/** Which teammates a message tasks. Import-free so the terminal client shares the exact grammar. */
export function mentionedHandles(text: string) {
  // Match complete tokens so @rae- cannot fall back to @rae.
  return [
    ...new Set(
      [...text.matchAll(/(?:^|[^a-zA-Z0-9_])@([a-zA-Z][a-zA-Z0-9_-]{0,31})(?![a-zA-Z0-9_-])/g)].map((match) =>
        match[1]!.toLowerCase(),
      ),
    ),
  ]
}
