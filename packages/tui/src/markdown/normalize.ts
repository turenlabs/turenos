/** The rich budget for one message; `messages` scales it for a window of several. */
export function richContent(value: string, messages = 1) {
  // Parsing/rendering many blocks or deeply nested punctuation can monopolize the
  // terminal. Beyond these budgets, preserve every character as ordinary text.
  // A `text` fence is a single unhighlighted block, so it is the cheap way to degrade one message.
  const prose = splitFences(value)
    .filter((piece, i) => i % 2 === 0 || !/^[ \t]*(?:`{3,}|~{3,})text[ \t]*\n/.test(piece))
    .join("")
  if (prose.length > 16_000 * messages) return false
  const counts = { lines: 1, punctuation: 0 }
  for (const char of prose) {
    if (char === "\n" && ++counts.lines > 256 * messages) return false
    if ("*_[]()#>~|!`".includes(char) && ++counts.punctuation > 512 * messages) return false
  }
  return true
}

/**
 * Alternating prose and fenced-code pieces that join back to the input. A fence closes only at a
 * fence of the same character and at least the opening length, so a longer fence can hold a shorter one.
 */
function splitFences(text: string) {
  const pieces = [""]
  let open: { char: string; length: number } | undefined
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r?\n$/, ""))
    if (!open && marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      open = { char: marker[1]![0]!, length: marker[1]!.length }
      pieces.push(line)
      continue
    }
    if (open && marker && marker[1]![0] === open.char && marker[1]!.length >= open.length && !marker[2]!.trim()) {
      open = undefined
      pieces[pieces.length - 1] += line
      pieces.push("")
      continue
    }
    pieces[pieces.length - 1] += line
  }
  return pieces
}

export function normalizeMarkdown(text: string): string {
  const pieces = splitFences(text)
  const defined = new Set(
    [
      ...pieces
        .filter((_, i) => i % 2 === 0)
        .join("")
        .matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm),
    ].map((match) => match[1]!.toLowerCase()),
  )
  return pieces
    .map((part, i) => {
      if (i % 2 === 1) return part
      // "[completed] bash" and "[x] task" rows are status text; Markdown reads them as a link and conceals the brackets, so keep them in a code span.
      const rows = indentedRuns(part)
        .map((run, j) =>
          j % 2 === 1
            ? run
            : literalBrackets(
                run.replace(/^([ \t]*)\[([^\]\n]{1,40})\](?=[ \t]|$)/gm, (row, indent: string, label: string) =>
                  reference(label, defined) ? row : `${indent}\`[${label}]\``,
                ),
                defined,
              ),
        )
        .join("")
      return rows.replace(/^([ \t]*(?:\d+[.)]|[-*+]))[ \t]*\n(?!\n)(?![ \t]*(?:\d+[.)]|[-*+])\s)[ \t]*(?=\S)/gm, "$1 ")
    })
    .join("")
}

/** Alternating text and indented-code runs: four-space lines after a blank line, outside any list. */
function indentedRuns(text: string) {
  const runs = [""]
  let list = false
  let code = false
  let blank = true
  for (const line of text.split(/(?<=\n)/)) {
    const empty = !line.trim()
    const indented = /^( {4}|\t)/.test(line)
    if (!empty && !indented) list = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/.test(line)
    const isCode: boolean = !empty && indented && !list && (blank || code)
    if (isCode !== code && !empty) runs.push("")
    if (!empty) code = isCode
    blank = empty
    runs[runs.length - 1] += line
  }
  return runs
}

/**
 * A bracketed span with no link target is text, but OpenTUI's Markdown conceals its brackets and
 * styles it as a link label (a JSON array in a reply reads as one underlined link), and it prints
 * backslash escapes literally. So JSON standing on its own lines becomes a fenced json block, and an
 * inline `[text]` not followed by `(`, `:` or `[` becomes a code span, as status rows already are.
 */
function literalBrackets(text: string, defined: Set<string>) {
  return codeSpans(fenceJson(text))
    .map((piece, i) =>
      i % 2 === 1
        ? piece
        : piece
            .replace(/(^|[^\\!`\]])\[([^[\]\n`]{1,200})\](?![(:[])/g, (span, before: string, label: string) =>
              reference(label, defined) ? span : `${before}\`[${label}]\``,
            )
            // The paragraph highlighter reads `_` before a digit as emphasis even inside a word, so
            // `ses_4ab6 … msg_01` turned italic and lost both underscores. A code span keeps the text.
            // Only after whitespace, so link destinations, autolinks and URLs (`?a=1&user_1=2`) stay intact.
            .replace(/(?<![^\s])([A-Za-z][\w.-]*_\d[\w.-]*)(?![\w`/(])/g, "`$1`"),
    )
    .join("")
}

/** Alternating text and code spans (odd entries); a span closes at a backtick run as long as the one that opened it. */
function codeSpans(text: string) {
  const pieces: string[] = []
  let end = 0
  for (const match of text.matchAll(/```[\s\S]*?```|(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g)) {
    pieces.push(text.slice(end, match.index), match[0])
    end = match.index + match[0].length
  }
  return [...pieces, text.slice(end)]
}

/** A footnote label, or a label with a `[label]: url` definition in the document, is a reference rather than text. */
function reference(label: string, defined: Set<string>) {
  return label.startsWith("^") || defined.has(label.toLowerCase())
}

/** A line that is only `[` or `{`, through the first unindented line that closes it. */
function fenceJson(text: string) {
  return text.replace(
    /^([[{])[ \t]*\n([\s\S]*?)\n([\]}])[ \t]*$/gm,
    (block, open: string, body: string, close: string) =>
      (open === "[") === (close === "]") ? `\`\`\`json\n${open}\n${body}\n${close}\n\`\`\`` : block,
  )
}
