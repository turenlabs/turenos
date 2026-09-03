import { Language } from "./languages"

export const TokenKind = {
  Ident: 0,
  String: 1,
  Number: 2,
  Punct: 3,
  Newline: 4,
  EOF: 5,
} as const

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind]

export type Token = {
  kind: TokenKind
  text: string
  offset: number
  line: number
}

export class LexerError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`)
    this.name = "LexerError"
    this.offset = offset
  }
}

const multiCharacterOperators = [
  "!==",
  "===",
  "??=",
  "**=",
  "<<=",
  ">>=",
  "<=>",
  "...",
  "?.",
  "??",
  "=>",
  "::",
  ":=",
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "->",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  ".=",
  "**",
  "<<",
  ">>",
  "[[",
  "]]",
] as const

const letter = /^\p{L}$/u
const digit = /^\p{Nd}$/u
const whitespace = /^\p{White_Space}$/u

export function lex(source: string): Token[] {
  return lexLanguage(source)
}

export function lexLanguage(source: string, language?: Language): Token[] {
  const tokens: Token[] = []
  const state = { index: 0, offset: 0, line: 1 }

  while (state.index < source.length) {
    const rune = decodeRune(source, state.index)
    if (!rune.valid) throw new LexerError("invalid UTF-8", state.offset)

    if (rune.text === "\r") {
      advance(state, rune)
      continue
    }
    if (rune.text === "\n") {
      tokens.push({ kind: TokenKind.Newline, text: "\n", offset: state.offset, line: state.line })
      state.line++
      advance(state, rune)
      continue
    }
    if (whitespace.test(rune.text)) {
      advance(state, rune)
      continue
    }

    if (source.startsWith("//", state.index)) {
      advanceASCII(state, 2)
      while (state.index < source.length && source[state.index] !== "\n")
        advance(state, decodeRune(source, state.index))
      continue
    }
    if (languageUsesHashComments(language) && rune.text === "#") {
      advance(state, rune)
      while (state.index < source.length && source[state.index] !== "\n")
        advance(state, decodeRune(source, state.index))
      continue
    }
    if (source.startsWith("/*", state.index)) {
      const start = state.offset
      advanceASCII(state, 2)
      while (state.index < source.length && !source.startsWith("*/", state.index)) {
        const commentRune = decodeRune(source, state.index)
        if (commentRune.text === "\n") {
          tokens.push({ kind: TokenKind.Newline, text: "\n", offset: state.offset, line: state.line })
          state.line++
        }
        advance(state, commentRune)
      }
      if (state.index >= source.length) throw new LexerError("unterminated block comment", start)
      advanceASCII(state, 2)
      continue
    }

    if (isECMAScriptLanguage(language) && rune.text === "/" && canStartECMAScriptRegex(tokens)) {
      const regex = lexECMAScriptRegex(source, state.index, state.offset, state.line)
      if (regex) {
        tokens.push(regex.token)
        state.index = regex.index
        state.offset = regex.offset
        continue
      }
    }

    if (
      language === Language.Python &&
      (source.startsWith('"""', state.index) || source.startsWith("'''", state.index))
    ) {
      const quote = source.slice(state.index, state.index + 3)
      const start = state.offset
      const startLine = state.line
      advanceASCII(state, 3)
      const text: string[] = []
      while (state.index < source.length && !source.startsWith(quote, state.index)) {
        const stringRune = decodeRune(source, state.index)
        if (stringRune.text === "\n") state.line++
        text.push(stringRune.text)
        advance(state, stringRune)
      }
      if (state.index >= source.length) throw new LexerError("unterminated triple-quoted string", start)
      advanceASCII(state, 3)
      tokens.push({ kind: TokenKind.String, text: text.join(""), offset: start, line: startLine })
      continue
    }

    if (rune.text === "`" && isECMAScriptLanguage(language)) {
      const template = lexECMAScriptTemplate(source, state.index, state.offset, state.line)
      tokens.push(template.token)
      state.index = template.index
      state.offset = template.offset
      state.line = template.line
      continue
    }

    if (
      (rune.text === '"' || rune.text === "'" || rune.text === "`") &&
      !(rune.text === "'" && isProseApostrophe(source, state.index, language))
    ) {
      const quote = rune.text
      const start = state.offset
      const startLine = state.line
      const text: string[] = []
      advance(state, rune)
      let escaped = false
      let terminated = false

      while (state.index < source.length) {
        const stringRune = decodeRune(source, state.index)
        if (quote !== "`" && escaped) {
          text.push("\\", stringRune.text)
          escaped = false
          advance(state, stringRune)
          continue
        }
        if (quote !== "`" && stringRune.text === "\\") {
          escaped = true
          advance(state, stringRune)
          continue
        }
        if (stringRune.text === quote) {
          advance(state, stringRune)
          tokens.push({ kind: TokenKind.String, text: text.join(""), offset: start, line: startLine })
          terminated = true
          break
        }
        if (stringRune.text === "\n") state.line++
        text.push(stringRune.text)
        advance(state, stringRune)
      }
      if (!terminated) throw new LexerError("unterminated string", start)
      continue
    }

    if (isIdentifierStart(rune.text)) {
      const startIndex = state.index
      const startOffset = state.offset
      advance(state, rune)
      while (state.index < source.length) {
        const identifierRune = decodeRune(source, state.index)
        if (!isIdentifierContinue(identifierRune.text)) break
        advance(state, identifierRune)
      }
      tokens.push({
        kind: TokenKind.Ident,
        text: source.slice(startIndex, state.index),
        offset: startOffset,
        line: state.line,
      })
      continue
    }

    if (digit.test(rune.text)) {
      const startIndex = state.index
      const startOffset = state.offset
      advance(state, rune)
      while (state.index < source.length) {
        const numberRune = decodeRune(source, state.index)
        if (
          !(
            digit.test(numberRune.text) ||
            letter.test(numberRune.text) ||
            numberRune.text === "." ||
            numberRune.text === "_"
          )
        ) {
          break
        }
        advance(state, numberRune)
      }
      tokens.push({
        kind: TokenKind.Number,
        text: source.slice(startIndex, state.index),
        offset: startOffset,
        line: state.line,
      })
      continue
    }

    const operator = multiCharacterOperators.find((candidate) => source.startsWith(candidate, state.index))
    if (operator) {
      tokens.push({ kind: TokenKind.Punct, text: operator, offset: state.offset, line: state.line })
      advanceASCII(state, operator.length)
      continue
    }

    tokens.push({ kind: TokenKind.Punct, text: rune.text, offset: state.offset, line: state.line })
    advance(state, rune)
  }

  tokens.push({ kind: TokenKind.EOF, text: "", offset: state.offset, line: state.line })
  return tokens
}

export function skipNewlines(tokens: readonly Token[], index: number): number {
  while (index < tokens.length && tokens[index]!.kind === TokenKind.Newline) index++
  return index
}

export function findMatching(tokens: readonly Token[], open: number, left: string, right: string): number | undefined {
  if (open >= tokens.length || tokens[open]!.text !== left) return
  let depth = 0
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index]!.text === left) depth++
    if (tokens[index]!.text !== right) continue
    depth--
    if (depth === 0) return index
  }
}

export function tokenTexts(tokens: readonly Token[]): string {
  return tokens
    .filter((token) => token.kind !== TokenKind.Newline && token.kind !== TokenKind.EOF)
    .map((token) => token.text)
    .join(" ")
}

function languageUsesHashComments(language?: Language) {
  return (
    language === Language.Python ||
    language === Language.Shell ||
    language === Language.HCL ||
    language === Language.PHP
  )
}

function isECMAScriptLanguage(language?: Language) {
  return language === Language.TypeScript || language === Language.JavaScript
}

function canStartECMAScriptRegex(tokens: readonly Token[]) {
  const previous = tokens.findLast((token) => token.kind !== TokenKind.Newline && token.kind !== TokenKind.EOF)
  if (!previous) return true
  if (previous.kind === TokenKind.String || previous.kind === TokenKind.Number) return false
  if (previous.kind === TokenKind.Ident) {
    return [
      "return",
      "throw",
      "case",
      "delete",
      "void",
      "typeof",
      "instanceof",
      "in",
      "of",
      "yield",
      "await",
      "else",
      "do",
    ].includes(previous.text)
  }
  return ![")", "]", "}", "++", "--"].includes(previous.text)
}

function lexECMAScriptRegex(source: string, start: number, offset: number, line: number) {
  if (source[start] !== "/" || start + 1 >= source.length || source[start + 1] === "=") return
  let index = start + 1
  let nextOffset = offset + 1
  let escaped = false
  let inClass = false

  while (index < source.length) {
    const rune = decodeRune(source, index)
    if (rune.text === "\n" || rune.text === "\r") return
    if (escaped) {
      escaped = false
      index += rune.size
      nextOffset += rune.bytes
      continue
    }
    if (rune.text === "\\") {
      escaped = true
      index += rune.size
      nextOffset += rune.bytes
      continue
    }
    if (rune.text === "[") {
      inClass = true
      index += rune.size
      nextOffset += rune.bytes
      continue
    }
    if (rune.text === "]" && inClass) {
      inClass = false
      index += rune.size
      nextOffset += rune.bytes
      continue
    }
    if (rune.text === "/" && !inClass) {
      index += rune.size
      nextOffset += rune.bytes
      while (index < source.length) {
        const flag = decodeRune(source, index)
        if (!letter.test(flag.text)) break
        index += flag.size
        nextOffset += flag.bytes
      }
      return {
        token: { kind: TokenKind.String, text: source.slice(start, index), offset, line } satisfies Token,
        index,
        offset: nextOffset,
      }
    }
    index += rune.size
    nextOffset += rune.bytes
  }
}

function isProseApostrophe(source: string, index: number, language?: Language) {
  const word = /[\p{L}\p{Nd}]/u.test(source[index - 1] ?? "") && /[\p{L}\p{Nd}]/u.test(source[index + 1] ?? "")
  if (!word) return false
  if (language === Language.Shell) return insideShellHeredoc(source, index)
  return isECMAScriptLanguage(language) && insideJSXText(source, index)
}

function insideJSXText(source: string, index: number) {
  const before = source.slice(0, index)
  const tagEnd = before.lastIndexOf(">")
  if (tagEnd <= before.lastIndexOf("<")) return false
  if (/[{};=()]/.test(before.slice(tagEnd + 1))) return false
  const after = source.slice(index + 1)
  const nextTag = after.indexOf("<")
  const nextExpression = after.indexOf("{")
  const nextJSBoundary = [after.indexOf(";"), after.indexOf("}"), after.indexOf(")")]
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0]
  const nextJSXBoundary = [nextTag, nextExpression].filter((value) => value >= 0).sort((left, right) => left - right)[0]
  return nextJSXBoundary !== undefined && (nextJSBoundary === undefined || nextJSXBoundary < nextJSBoundary)
}

function insideShellHeredoc(source: string, index: number) {
  let delimiter: string | undefined
  for (const line of source.slice(0, source.lastIndexOf("\n", index - 1) + 1).split("\n")) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = undefined
      continue
    }
    delimiter = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1]
  }
  return delimiter !== undefined
}

type DelimitedScan = { closed: boolean; index: number; offset: number; line: number }

function lexECMAScriptTemplate(source: string, start: number, offset: number, line: number) {
  const result = scanTemplate(source, start + 1, offset + 1, line)
  if (!result.closed) throw new LexerError("unterminated template string", offset)
  return {
    token: {
      kind: TokenKind.String,
      text: source.slice(start + 1, result.index - 1),
      offset,
      line,
    } satisfies Token,
    index: result.index,
    offset: result.offset,
    line: result.line,
  }
}

function scanTemplate(source: string, start: number, offset: number, line: number): DelimitedScan {
  let index = start
  let nextOffset = offset
  let nextLine = line
  while (index < source.length) {
    const rune = decodeRune(source, index)
    if (rune.text === "\\") {
      index += rune.size
      nextOffset += rune.bytes
      if (index < source.length) {
        const escaped = decodeRune(source, index)
        if (escaped.text === "\n") nextLine++
        index += escaped.size
        nextOffset += escaped.bytes
      }
      continue
    }
    if (rune.text === "`") {
      return { closed: true, index: index + rune.size, offset: nextOffset + rune.bytes, line: nextLine }
    }
    if (rune.text === "$" && source[index + rune.size] === "{") {
      const expression: DelimitedScan = scanTemplateExpression(
        source,
        index + rune.size + 1,
        nextOffset + rune.bytes + 1,
        nextLine,
      )
      if (!expression.closed) return expression
      index = expression.index
      nextOffset = expression.offset
      nextLine = expression.line
      continue
    }
    if (rune.text === "\n") nextLine++
    index += rune.size
    nextOffset += rune.bytes
  }
  return { closed: false, index, offset: nextOffset, line: nextLine }
}

function scanTemplateExpression(source: string, start: number, offset: number, line: number): DelimitedScan {
  let index = start
  let nextOffset = offset
  let nextLine = line
  let depth = 1
  let previous = ""
  while (index < source.length) {
    const rune = decodeRune(source, index)
    if (rune.text === "'" || rune.text === '"') {
      const quoted = scanQuotedText(source, index, nextOffset, nextLine, rune.text)
      if (!quoted.closed) return quoted
      index = quoted.index
      nextOffset = quoted.offset
      nextLine = quoted.line
      continue
    }
    if (rune.text === "`") {
      const nested: DelimitedScan = scanTemplate(source, index + rune.size, nextOffset + rune.bytes, nextLine)
      if (!nested.closed) return nested
      index = nested.index
      nextOffset = nested.offset
      nextLine = nested.line
      continue
    }
    if (
      rune.text === "/" &&
      source[index + rune.size] !== "/" &&
      source[index + rune.size] !== "*" &&
      (!previous || "([{=,:;!?&|+-*%^~<>".includes(previous))
    ) {
      const regex = scanRegexText(source, index, nextOffset, nextLine)
      if (regex) {
        index = regex.index
        nextOffset = regex.offset
        nextLine = regex.line
        continue
      }
    }
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") {
        const comment = decodeRune(source, index)
        index += comment.size
        nextOffset += comment.bytes
      }
      continue
    }
    if (source.startsWith("/*", index)) {
      index += 2
      nextOffset += 2
      while (index < source.length && !source.startsWith("*/", index)) {
        const comment = decodeRune(source, index)
        if (comment.text === "\n") nextLine++
        index += comment.size
        nextOffset += comment.bytes
      }
      if (source.startsWith("*/", index)) {
        index += 2
        nextOffset += 2
      }
      continue
    }
    if (rune.text === "{") depth++
    if (rune.text === "}" && --depth === 0) {
      return { closed: true, index: index + rune.size, offset: nextOffset + rune.bytes, line: nextLine }
    }
    if (rune.text === "\n") nextLine++
    if (!whitespace.test(rune.text)) previous = rune.text
    index += rune.size
    nextOffset += rune.bytes
  }
  return { closed: false, index, offset: nextOffset, line: nextLine }
}

function scanRegexText(source: string, start: number, offset: number, line: number): DelimitedScan | undefined {
  let index = start + 1
  let nextOffset = offset + 1
  let escaped = false
  let inClass = false
  while (index < source.length) {
    const rune = decodeRune(source, index)
    if (rune.text === "\n" || rune.text === "\r") return
    if (escaped) escaped = false
    else if (rune.text === "\\") escaped = true
    else if (rune.text === "[") inClass = true
    else if (rune.text === "]") inClass = false
    else if (rune.text === "/" && !inClass) {
      index += rune.size
      nextOffset += rune.bytes
      while (index < source.length && letter.test(decodeRune(source, index).text)) {
        const flag = decodeRune(source, index)
        index += flag.size
        nextOffset += flag.bytes
      }
      return { closed: true, index, offset: nextOffset, line }
    }
    index += rune.size
    nextOffset += rune.bytes
  }
}

function scanQuotedText(source: string, start: number, offset: number, line: number, quote: string): DelimitedScan {
  let index = start + 1
  let nextOffset = offset + 1
  let nextLine = line
  let escaped = false
  while (index < source.length) {
    const rune = decodeRune(source, index)
    if (escaped) escaped = false
    else if (rune.text === "\\") escaped = true
    else if (rune.text === quote) {
      return { closed: true, index: index + rune.size, offset: nextOffset + rune.bytes, line: nextLine }
    }
    if (rune.text === "\n") nextLine++
    index += rune.size
    nextOffset += rune.bytes
  }
  return { closed: false, index, offset: nextOffset, line: nextLine }
}

function isIdentifierStart(rune: string) {
  return rune === "_" || rune === "$" || rune === "@" || letter.test(rune)
}

function isIdentifierContinue(rune: string) {
  return isIdentifierStart(rune) || digit.test(rune)
}

function decodeRune(source: string, index: number) {
  const first = source.charCodeAt(index)
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = source.charCodeAt(index + 1)
    if (second >= 0xdc00 && second <= 0xdfff) {
      return { text: source.slice(index, index + 2), size: 2, bytes: 4, valid: true }
    }
    return { text: source[index]!, size: 1, bytes: 1, valid: false }
  }
  if (first >= 0xdc00 && first <= 0xdfff) return { text: source[index]!, size: 1, bytes: 1, valid: false }
  return { text: source[index]!, size: 1, bytes: first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3, valid: true }
}

function advance(state: { index: number; offset: number }, rune: { size: number; bytes: number }) {
  state.index += rune.size
  state.offset += rune.bytes
}

function advanceASCII(state: { index: number; offset: number }, size: number) {
  state.index += size
  state.offset += size
}
