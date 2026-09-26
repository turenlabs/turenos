// Blanks fenced blocks, so examples aren't read as claims.
export function stripFences(text: string) {
  const lines = text.split("\n")
  return lines.map((line, index) => (insideFence(lines, index) ? "" : line)).join("\n")
}

export function codeSpans(prose: string) {
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "")
}

// `@path` outside inline code, which Claude Code treats as a file import.
export function bareMentions(prose: string) {
  const outsideSpans = prose.replace(/`[^`\n]*`/g, "")
  return [...outsideSpans.matchAll(/(?:^|(?<=[\s(]))@([~./\w][\w./~-]*\w)/gm)].map((match) => match[1] ?? "")
}

// A line is inside a fence when an odd number of fence markers precede it (the markers themselves count as inside).
function insideFence(lines: string[], index: number) {
  const markers = lines.slice(0, index + 1).filter((line) => /^\s*(```|~~~)/.test(line)).length
  return markers % 2 === 1 || /^\s*(```|~~~)/.test(lines[index] ?? "")
}
