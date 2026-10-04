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
      const rows = literalBrackets(part.replace(/^([ \t]*)\[([^\]\n]{1,40})\](?=[ \t]|$)/gm, "$1`[$2]`"))
      return rows.replace(/^([ \t]*(?:\d+[.)]|[-*+]))[ \t]*\n(?!\n)(?![ \t]*(?:\d+[.)]|[-*+])\s)[ \t]*(?=\S)/gm, "$1 ")
    })
    .join("")
}

/**
 * A bracketed span with no link target is text, but OpenTUI's Markdown conceals its brackets and
 * styles it as a link label (a JSON array in a reply reads as one underlined link), and it prints
 * backslash escapes literally. So JSON standing on its own lines becomes a fenced json block, and an
 * inline `[text]` not followed by `(`, `:` or `[` becomes a code span, as status rows already are.
 */
function literalBrackets(text: string) {
  return fenceJson(text)
    .split(/(```[\s\S]*?```|`+[^`\n]*`+)/g)
    .map((piece, i) =>
      i % 2 === 1
        ? piece
        : piece
            .replace(/(^|[^\\!`\]])\[([^[\]\n`]{1,200})\](?![(:[])/g, "$1`[$2]`")
            // The paragraph highlighter reads `_` before a digit as emphasis even inside a word, so
            // `ses_4ab6 … msg_01` turned italic and lost both underscores. A code span keeps the text.
            .replace(/(?<![\w`/:(=.-])([A-Za-z][\w.-]*_\d[\w.-]*)(?![\w`/(])/g, "`$1`"),
    )
    .join("")
}

/** A line that is only `[` or `{`, through the first unindented line that closes it. */
function fenceJson(text: string) {
  return text.replace(
    /^([[{])[ \t]*\n([\s\S]*?)\n([\]}])[ \t]*$/gm,
    (block, open: string, body: string, close: string) =>
      (open === "[") === (close === "]") ? `\`\`\`json\n${open}\n${body}\n${close}\n\`\`\`` : block,
  )
}
