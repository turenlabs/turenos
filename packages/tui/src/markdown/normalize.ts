export function richContent(value: string) {
  // Parsing/rendering many blocks or deeply nested punctuation can monopolize the
  // terminal. Beyond these budgets, preserve every character as ordinary text.
  if (value.length > 16_000) return false
  const counts = { lines: 1, punctuation: 0 }
  for (const char of value) {
    if (char === "\n" && ++counts.lines > 256) return false
    if ("*_[]()#>~|!`".includes(char) && ++counts.punctuation > 512) return false
  }
  return true
}

export function normalizeMarkdown(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      // "[completed] bash" and "[x] task" rows are status text; Markdown reads them as a link and conceals the brackets, so keep them in a code span.
      const rows = part.replace(/^([ \t]*)\[([^\]\n]{1,40})\](?=[ \t]|$)/gm, "$1`[$2]`")
      return rows.replace(/^([ \t]*(?:\d+[.)]|[-*+]))[ \t]*\n(?!\n)(?![ \t]*(?:\d+[.)]|[-*+])\s)[ \t]*(?=\S)/gm, "$1 ")
    })
    .join("")
}
