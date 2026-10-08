// Link targets in inline, reference-style and HTML form. An inline target is matched on its `](` alone, so a link
// wrapped around an image badge is still seen; `<...>` targets may hold spaces, and titles may use any quote style.
export const LINK =
  /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|^\s*\[[^\]]+\]:\s*(?:<([^>\n]+)>|(\S+))|(?:href|src)="([^"]+)"/gm
// The same link forms with their prefix captured, for scripts that rewrite a target in place.
export const REWRITABLE_LINK = /(\]\(\s*<?|^\s*\[[^\]]+\]:\s*<?|(?:href|src)=")([^)\s>"]+)/gm

export function isPage(file: string) {
  return /\.mdx?$/.test(file)
}

export function linkTargets(prose: string) {
  return [...prose.matchAll(LINK)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5])
    .filter((target) => target !== undefined)
}

// Flags each line inside a fenced block, markers included. A fence closes only on the character that opened it.
export function fenced(lines: string[]) {
  return lines.reduce<{ open?: string; flags: boolean[] }>(
    (state, line) => {
      const fence = /^\s*(```+|~~~+)/.exec(line)?.[1]
      if (fence && state.open === undefined) return { open: fence, flags: [...state.flags, true] }
      if (fence && state.open !== undefined && fence[0] === state.open[0])
        return { open: undefined, flags: [...state.flags, true] }
      return { open: state.open, flags: [...state.flags, state.open !== undefined] }
    },
    { flags: [] },
  ).flags
}

// Blanks fenced blocks, and inline code unless keepSpans is set, so examples aren't read as links or references.
export function stripCode(text: string, keepSpans = false) {
  const lines = text.split("\n")
  const inside = fenced(lines)
  return lines
    .map((line, index) => (inside[index] ? "" : keepSpans ? line : line.replace(/`[^`\n]*`/g, "``")))
    .join("\n")
}

// GitHub heading slugs, with -1, -2 suffixes for repeated headings.
export function headingSlugs(headings: string[]) {
  const counts = new Map<string, number>()
  return headings.map((heading) => {
    const slug = heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replaceAll("`", "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replaceAll(" ", "-")
    const seen = counts.get(slug) ?? 0
    counts.set(slug, seen + 1)
    return seen === 0 ? slug : `${slug}-${seen}`
  })
}

// Every anchor a page offers: heading slugs plus explicit id/name attributes. Inline code stays in headings because
// GitHub keeps its text in the slug, so "### `Tool.make`" is #toolmake.
export function anchors(text: string) {
  const headings = [...stripCode(text, true).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => match[1] ?? "")
  // Fenced examples can hold HTML too; only real attributes are anchors.
  const explicit = [...stripCode(text, true).matchAll(/<[^>]+\b(?:id|name)="([^"]+)"/g)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  )
  return new Set([...headingSlugs(headings), ...explicit])
}

export function linksTo(text: string, target: string) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const suffix = target.endsWith("/") ? "(README\\.md)?" : "([/#][^)\\s]*)?"
  return new RegExp(`\\]\\((\\./)?${escaped}${suffix}\\)`).test(text)
}
