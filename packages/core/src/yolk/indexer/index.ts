import path from "path"
import type { Dirent } from "node:fs"
import { createHash } from "node:crypto"
import { open, opendir, readFile, stat } from "fs/promises"
import { EGraph, NodeLimitError, mustRewrite, type ClassAnalysis, type Rewrite, type RunnerReport } from "../egraph"
import {
  Language,
  MAX_SOURCE_FILE_BYTES,
  detectLanguage,
  isKnownUnsupportedSourcePath,
  languagePrefix,
  lexLanguage,
  pathModule,
  shouldSkipIndexDir,
  shouldSkipIndexPath,
  type Token,
} from "../language"
import { parserForLanguage } from "../parsers"

export { Language }
export type { ClassAnalysis, RunnerReport }

export type FileUnit = {
  path: string
  relativePath: string
  source: string
  language: Language
  package: string
  class: string
  imports: Map<string, string>
  staticImports: Map<string, string>
  tokens: Token[]
  functions: FunctionDecl[]
}

export type FunctionDecl = {
  symbol: string
  name: string
  receiver: string
  kind: string
  params: string[]
  body: Token[]
  file: string
  line: number
  language: Language
  visibility: "public" | "internal" | "unknown"
  unit: FileUnit
}

export type FunctionInfo = {
  decl: FunctionDecl
  semanticRoot: number
  bodyRoot: number
  originalTerm: string
  canonical: string
  fingerprint: string
  sourceHash: string
  signatureHash: string
  bodyHash: string
  confidence: string
  calls: string[]
  unresolvedCalls: string[]
}

export type IndexStats = {
  files: number
  filesSeen: number
  filesSkipped: number
  parseErrors: number
  cacheHits: number
  functions: number
  eClasses: number
  eNodes: number
  filesByLanguage: Map<Language, number>
  symbolsByLanguage: Map<Language, number>
  lexAndLowerMs: number
  saturationMs: number
  runner: RunnerReport
}

export type IndexDiagnostic = {
  file: string
  language?: Language
  kind: string
  message: string
}

export type ImpactNode = {
  symbol: string
  distance: number
}

export type BuildIndexOptions = {
  signal?: AbortSignal
  maxFiles?: number
  maxSourceBytes?: number
  maxFunctions?: number
  maxNodes?: number
  cache?: IndexCache
}

type CacheEntry = {
  sourceHash: string
  language: Language
  size: number
  modifiedAt: number
  changedAt: number
  unit: FileUnit
}

export class IndexCache {
  private readonly entries = new Map<string, CacheEntry>()

  get(file: string, sourceHash: string, language: Language) {
    const entry = this.entries.get(file)
    if (!entry || entry.sourceHash !== sourceHash || entry.language !== language) return
    return cloneUnit(entry.unit)
  }

  getByMetadata(file: string, language: Language, size: number, modifiedAt: number, changedAt: number) {
    const entry = this.entries.get(file)
    if (
      !entry ||
      entry.language !== language ||
      entry.size !== size ||
      entry.modifiedAt !== modifiedAt ||
      entry.changedAt !== changedAt
    )
      return
    return cloneUnit(entry.unit)
  }

  set(
    file: string,
    sourceHash: string,
    language: Language,
    size: number,
    modifiedAt: number,
    changedAt: number,
    unit: FileUnit,
  ) {
    this.entries.set(file, { sourceHash, language, size, modifiedAt, changedAt, unit: cloneUnit(unit) })
  }

  delete(file: string) {
    this.entries.delete(file)
  }

  retain(files: ReadonlySet<string>) {
    for (const file of this.entries.keys()) {
      if (!files.has(file)) this.entries.delete(file)
    }
  }
}

const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_FUNCTIONS = 50_000
const DEFAULT_MAX_NODES = 50_000

const emptyRunner = (): RunnerReport => ({
  iterations: 0,
  rewriteApplications: {},
  rebuildMerges: 0,
  stopReason: "iteration-limit",
  elapsedMs: 0,
})

export class CodeIndex {
  readonly root: string
  readonly graph: EGraph
  readonly units: FileUnit[]
  readonly functions: Map<string, FunctionInfo>
  readonly stats: IndexStats
  readonly diagnostics: IndexDiagnostic[]
  analysis: Map<number, ClassAnalysis>
  equivalenceGroups: Map<number, string[]>

  constructor(root: string, nodeLimit = DEFAULT_MAX_NODES) {
    this.root = root
    this.graph = new EGraph(nodeLimit)
    this.units = []
    this.functions = new Map()
    this.stats = {
      files: 0,
      filesSeen: 0,
      filesSkipped: 0,
      parseErrors: 0,
      cacheHits: 0,
      functions: 0,
      eClasses: 0,
      eNodes: 0,
      filesByLanguage: new Map(),
      symbolsByLanguage: new Map(),
      lexAndLowerMs: 0,
      saturationMs: 0,
      runner: emptyRunner(),
    }
    this.diagnostics = []
    this.analysis = new Map()
    this.equivalenceGroups = new Map()
  }

  equivalents(symbol: string) {
    const fn = this.functions.get(symbol)
    if (!fn) return []
    const group = this.equivalenceGroups.get(this.graph.find(fn.semanticRoot)) ?? []
    if (group.length <= 1) return []
    return group.filter((other) => other !== symbol)
  }

  reverseCalls() {
    const reverse = new Map<string, string[]>()
    for (const [caller, fn] of sortedEntries(this.functions)) {
      for (const callee of fn.calls) {
        const callers = reverse.get(callee) ?? []
        callers.push(caller)
        reverse.set(callee, callers)
      }
    }
    for (const callers of reverse.values()) callers.sort()
    return reverse
  }

  impact(symbol: string) {
    const reverse = this.reverseCalls()
    const seen = new Set<string>([symbol])
    const queue: ImpactNode[] = [{ symbol, distance: 0 }]
    const result: ImpactNode[] = []
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) break
      for (const caller of reverse.get(current.symbol) ?? []) {
        if (seen.has(caller)) continue
        seen.add(caller)
        const item = { symbol: caller, distance: current.distance + 1 }
        result.push(item)
        queue.push(item)
      }
    }
    return result.sort((a, b) => a.distance - b.distance || compareText(a.symbol, b.symbol))
  }

  findSymbol(query: string): string | undefined {
    if (this.functions.has(query)) return query
    const normalized = query.toLowerCase()
    const matches = [...this.functions.keys()]
      .filter((symbol) => {
        const candidate = symbol.toLowerCase()
        return candidate.endsWith(normalized) || candidate.includes(normalized)
      })
      .sort()
    if (matches.length === 1) return matches[0]
  }
}

type ParsedValue =
  | { kind: "expr"; id: number }
  | { kind: "name"; names: string[] }
  | { kind: "member"; receiver: number; member: string }

type ParsedExpr = { id: number; exact: boolean }
type BlockLowering = { semantic: number; exprs: number[]; pure: boolean; hasValue: boolean }

function tokenKind(token: Token) {
  const value = String(token.kind).toLowerCase()
  if (value === "0") return "ident"
  if (value === "1") return "string"
  if (value === "2") return "number"
  if (value === "4") return "newline"
  if (value === "5") return "eof"
  return value.replace(/^tok/, "")
}

function isKind(token: Token | undefined, kind: "ident" | "string" | "number" | "newline" | "eof") {
  return Boolean(token) && tokenKind(token!) === kind
}

function skipNewlines(tokens: Token[], index: number) {
  while (index < tokens.length && isKind(tokens[index], "newline")) index++
  return index
}

function findMatching(tokens: Token[], open: number, left: string, right: string): number | undefined {
  if (tokens[open]?.text !== left) return
  let depth = 0
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index]?.text === left) depth++
    if (tokens[index]?.text !== right) continue
    depth--
    if (depth === 0) return index
  }
}

function compactTokens(tokens: Token[]) {
  return tokens.filter((token) => !isKind(token, "newline") && !isKind(token, "eof"))
}

function tokenTexts(tokens: Token[]) {
  return compactTokens(tokens)
    .map((token) => token.text)
    .join(" ")
}

function pythonDecoratorStart(tokens: Token[], declarationStart: number) {
  let lineEnd = declarationStart - 2
  let depth = 0
  let candidate = declarationStart
  let found = false
  while (lineEnd >= 0) {
    while (lineEnd >= 0 && isKind(tokens[lineEnd], "newline")) lineEnd--
    if (lineEnd < 0) break
    let lineStart = lineEnd
    while (lineStart > 0 && !isKind(tokens[lineStart - 1], "newline")) lineStart--
    for (let index = lineEnd; index >= lineStart; index--) {
      const text = tokens[index]?.text
      if (text === ")" || text === "]" || text === "}") depth++
      if (text === "(" || text === "[" || text === "{") depth--
    }
    candidate = lineStart
    if (depth === 0) {
      if (!tokens[lineStart]?.text.startsWith("@"))
        return found ? candidateAfterLine(tokens, lineEnd) : declarationStart
      found = true
    }
    lineEnd = lineStart - 2
  }
  return found ? candidate : declarationStart
}

function candidateAfterLine(tokens: Token[], lineEnd: number) {
  let start = lineEnd + 1
  while (start < tokens.length && isKind(tokens[start], "newline")) start++
  return start
}

function signatureText(fn: FunctionDecl) {
  const tokens = fn.unit.tokens
  const nameAt = tokens.findIndex((token) => token.line === fn.line && token.text === fn.name)
  if (nameAt < 0) return [fn.kind, fn.receiver, fn.name, ...fn.params].join(" ")

  let start = nameAt
  while (
    start > 0 &&
    (fn.language !== Language.Python || !isKind(tokens[start - 1], "newline")) &&
    tokens[start - 1]?.text !== ";" &&
    tokens[start - 1]?.text !== "}" &&
    tokens[start - 1]?.text !== "{"
  ) {
    start--
  }
  if (fn.language === Language.Python) start = pythonDecoratorStart(tokens, start)

  let parentheses = 0
  let brackets = 0
  let end = nameAt
  for (let index = nameAt; index < tokens.length; index++) {
    const text = tokens[index]?.text
    if (text === "(") parentheses++
    if (text === ")" && parentheses > 0) parentheses--
    if (text === "[") brackets++
    if (text === "]" && brackets > 0) brackets--
    end = index
    if (parentheses || brackets) continue
    if (
      text === "{" ||
      text === "=>" ||
      (fn.language === Language.Python && text === ":") ||
      isKind(tokens[index], "newline")
    )
      break
  }
  return tokenTexts(tokens.slice(start, end + 1))
}

function baseImportName(value: string) {
  const trimmed = value.replace(/\/$/, "")
  return trimmed.slice(trimmed.lastIndexOf("/") + 1)
}

function emptyUnit(file: string, language: Language, tokens: Token[]): FileUnit {
  return {
    path: file,
    relativePath: "",
    source: "",
    language,
    package: "",
    class: "",
    imports: new Map(),
    staticImports: new Map(),
    tokens,
    functions: [],
  }
}

export function parseGoUnit(file: string, tokens: Token[]) {
  const unit = emptyUnit(file, "go", tokens)
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index]?.text !== "package") continue
    const next = skipNewlines(tokens, index + 1)
    if (isKind(tokens[next], "ident")) unit.package = tokens[next]!.text
    break
  }
  if (!unit.package) throw new Error(`${file}: missing Go package`)

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.text !== "import") continue
    let next = skipNewlines(tokens, index + 1)
    if (tokens[next]?.text === "(") {
      const end = findMatching(tokens, next, "(", ")")
      if (end === undefined) continue
      let cursor = next + 1
      while (cursor < end) {
        cursor = skipNewlines(tokens, cursor)
        let alias = ""
        if (isKind(tokens[cursor], "ident") && isKind(tokens[cursor + 1], "string")) {
          alias = tokens[cursor]!.text
          cursor++
        }
        if (isKind(tokens[cursor], "string")) {
          const imported = tokens[cursor]!.text
          alias ||= baseImportName(imported)
          if (alias !== "_" && alias !== ".") unit.imports.set(alias, baseImportName(imported))
        }
        while (cursor < end && !isKind(tokens[cursor], "newline")) cursor++
      }
      index = end
      continue
    }
    let alias = ""
    if (isKind(tokens[next], "ident") && isKind(tokens[next + 1], "string")) {
      alias = tokens[next]!.text
      next++
    }
    if (!isKind(tokens[next], "string")) continue
    const imported = tokens[next]!.text
    alias ||= baseImportName(imported)
    if (alias !== "_" && alias !== ".") unit.imports.set(alias, baseImportName(imported))
  }

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.text !== "func") continue
    let next = skipNewlines(tokens, index + 1)
    let receiver = ""
    if (tokens[next]?.text === "(") {
      const endReceiver = findMatching(tokens, next, "(", ")")
      if (endReceiver === undefined) continue
      for (let cursor = endReceiver - 1; cursor > next; cursor--) {
        if (!isKind(tokens[cursor], "ident")) continue
        receiver = tokens[cursor]!.text
        break
      }
      next = skipNewlines(tokens, endReceiver + 1)
    }
    if (!isKind(tokens[next], "ident")) continue
    const name = tokens[next]!.text
    next = skipNewlines(tokens, next + 1)
    if (tokens[next]?.text !== "(") continue
    const endParams = findMatching(tokens, next, "(", ")")
    if (endParams === undefined) continue
    let bodyStart = skipNewlines(tokens, endParams + 1)
    while (bodyStart < tokens.length && tokens[bodyStart]?.text !== "{" && !isKind(tokens[bodyStart], "eof"))
      bodyStart++
    if (tokens[bodyStart]?.text !== "{") continue
    const bodyEnd = findMatching(tokens, bodyStart, "{", "}")
    if (bodyEnd === undefined) continue
    const symbol = receiver ? `${unit.package}.${receiver}.${name}` : `${unit.package}.${name}`
    unit.functions.push({
      symbol,
      name,
      receiver,
      kind: receiver ? "method" : "function",
      params: parseGoParams(tokens.slice(next + 1, endParams)),
      body: tokens.slice(bodyStart + 1, bodyEnd),
      file,
      line: tokens[index]!.line,
      language: "go",
      visibility: /^[A-Z]/.test(name) ? "public" : "internal",
      unit,
    })
    index = bodyEnd
  }
  return unit
}

function parseGoParams(tokens: Token[]) {
  const compact = compactTokens(tokens)
  const params: string[] = []
  let start = 0
  let depth = 0
  const flush = (end: number) => {
    const token = compact
      .slice(start, end)
      .find((candidate) => isKind(candidate, "ident") && !["map", "chan", "func"].includes(candidate.text))
    if (token) params.push(token.text)
  }
  compact.forEach((token, index) => {
    if (["(", "[", "{"].includes(token.text)) depth++
    if ([")", "]", "}"].includes(token.text)) depth--
    if (token.text !== "," || depth !== 0) return
    flush(index)
    start = index + 1
  })
  if (start < compact.length) flush(compact.length)
  return params
}

function joinDotted(tokens: Token[]) {
  return tokens
    .filter((token) => isKind(token, "ident") || token.text === "." || token.text === "*")
    .map((token) => token.text)
    .join("")
}

export function parseJavaUnit(file: string, tokens: Token[]) {
  const unit = emptyUnit(file, "java", tokens)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.text === "package") {
      let end = index + 1
      while (end < tokens.length && tokens[end]?.text !== ";") end++
      unit.package = joinDotted(tokens.slice(index + 1, end))
      index = end
      continue
    }
    if (tokens[index]?.text !== "import") continue
    let next = skipNewlines(tokens, index + 1)
    const isStatic = tokens[next]?.text === "static"
    if (isStatic) next++
    let end = next
    while (end < tokens.length && tokens[end]?.text !== ";") end++
    const imported = joinDotted(tokens.slice(next, end))
    if (imported && !imported.endsWith(".*")) {
      const simple = imported.slice(imported.lastIndexOf(".") + 1)
      if (isStatic) unit.staticImports.set(simple, imported)
      if (!isStatic) unit.imports.set(simple, imported)
    }
    index = end
  }

  let classStart = -1
  for (let index = 0; index < tokens.length - 1; index++) {
    if (!["class", "interface", "record", "enum"].includes(tokens[index]?.text ?? "")) continue
    let next = skipNewlines(tokens, index + 1)
    if (!isKind(tokens[next], "ident")) continue
    unit.class = tokens[next]!.text
    while (next < tokens.length && tokens[next]?.text !== "{") next++
    if (next < tokens.length) classStart = next
    break
  }
  if (!unit.class || classStart < 0) throw new Error(`${file}: missing Java class`)
  const classEnd = findMatching(tokens, classStart, "{", "}")
  if (classEnd === undefined) throw new Error(`${file}: unbalanced Java class`)

  let depth = 1
  for (let index = classStart + 1; index < classEnd; index++) {
    if (tokens[index]?.text === "{") depth++
    if (tokens[index]?.text === "}") depth--
    if (depth !== 1 || tokens[index]?.text !== "(" || index === 0) continue
    let nameIndex = index - 1
    while (nameIndex > classStart && isKind(tokens[nameIndex], "newline")) nameIndex--
    if (!isKind(tokens[nameIndex], "ident") || isControlKeyword(tokens[nameIndex]!.text)) continue
    const endParams = findMatching(tokens, index, "(", ")")
    if (endParams === undefined) continue
    let bodyStart = skipNewlines(tokens, endParams + 1)
    let angle = 0
    while (bodyStart < classEnd) {
      if (tokens[bodyStart]?.text === "<") angle++
      if (tokens[bodyStart]?.text === ">" && angle > 0) angle--
      if (angle === 0 && ["{", ";"].includes(tokens[bodyStart]?.text ?? "")) break
      bodyStart++
    }
    if (tokens[bodyStart]?.text !== "{" || !looksLikeJavaDeclaration(tokens, classStart + 1, nameIndex)) continue
    const bodyEnd = findMatching(tokens, bodyStart, "{", "}")
    if (bodyEnd === undefined) continue
    const name = tokens[nameIndex]!.text
    const prefix = unit.package ? `${unit.package}.${unit.class}` : unit.class
    unit.functions.push({
      symbol: `${prefix}.${name}`,
      name,
      receiver: unit.class,
      kind: "method",
      params: parseJavaParams(tokens.slice(index + 1, endParams)),
      body: tokens.slice(bodyStart + 1, bodyEnd),
      file,
      line: tokens[nameIndex]!.line,
      language: "java",
      visibility: "unknown",
      unit,
    })
    index = bodyEnd
    depth = 1
  }
  return unit
}

function isControlKeyword(value: string) {
  return ["if", "for", "while", "switch", "catch", "return", "new", "synchronized", "try", "do"].includes(value)
}

function looksLikeJavaDeclaration(tokens: Token[], start: number, nameIndex: number) {
  let identifiers = 0
  for (let index = nameIndex - 1; index >= start; index--) {
    if ([";", "}", "{"].includes(tokens[index]?.text ?? "")) break
    if (isKind(tokens[index], "ident")) identifiers++
  }
  return identifiers > 0
}

function parseJavaParams(tokens: Token[]) {
  const compact = compactTokens(tokens)
  const params: string[] = []
  let start = 0
  let depth = 0
  const flush = (end: number) => {
    const segment = compact.slice(start, end)
    const token = segment.findLast((candidate) => isKind(candidate, "ident") && candidate.text !== "final")
    if (token) params.push(token.text)
  }
  compact.forEach((token, index) => {
    if (["(", "[", "{", "<"].includes(token.text)) depth++
    if ([")", "]", "}", ">"].includes(token.text) && depth > 0) depth--
    if (token.text !== "," || depth !== 0) return
    flush(index)
    start = index + 1
  })
  if (start < compact.length) flush(compact.length)
  return params
}

class ExprParser {
  private readonly tokens: Token[]
  private position = 0
  exact = true

  constructor(
    private readonly graph: EGraph,
    tokens: Token[],
    private readonly fn: FunctionDecl,
    private readonly env: Map<string, number>,
  ) {
    this.tokens = compactTokens(tokens)
  }

  get done() {
    return this.position === this.tokens.length
  }

  parse(minimumPrecedence: number): ParsedValue {
    let left = this.parsePrefix()
    while (true) {
      const operator = this.peek()
      const currentPrecedence = precedence(operator)
      if (currentPrecedence < minimumPrecedence) break
      this.take()
      const right = this.parse(operator === "**" ? currentPrecedence : currentPrecedence + 1)
      const lhs = this.materialize(left)
      const rhs = this.materialize(right)
      const op = binaryOperator(operator, this.fn.language)
      if (op === "not-eq") left = { kind: "expr", id: this.graph.add("not", this.graph.add("eq", lhs, rhs)) }
      else if (op === "contains-reversed") left = { kind: "expr", id: this.graph.add("contains", rhs, lhs) }
      else {
        if (op.startsWith("opaque:")) this.exact = false
        left = { kind: "expr", id: this.graph.add(op, lhs, rhs) }
      }
    }
    return left
  }

  materialize(value: ParsedValue): number {
    if (value.kind === "expr") return value.id
    if (value.kind === "member") {
      if (["typescript", "javascript"].includes(this.fn.language) && value.member === "length") {
        return this.graph.add(`${languagePrefix(this.fn.language)}-length`, value.receiver)
      }
      return this.graph.add(`select:${value.member}`, value.receiver)
    }
    if (value.names.length === 1) {
      const name = value.names[0]!
      if (name.toLowerCase() === "true") return this.graph.add("true")
      if (name.toLowerCase() === "false") return this.graph.add("false")
      if (["null", "nil", "none", "undefined"].includes(name.toLowerCase())) return this.graph.add("null")
      const bound = this.env.get(name)
      if (bound !== undefined) return bound
    }
    this.exact = false
    return this.graph.add(`name:${value.names.join(".")}`)
  }

  private peek() {
    return this.tokens[this.position]?.text ?? ""
  }

  private take() {
    return this.tokens[this.position++]
  }

  private parsePrefix(): ParsedValue {
    const token = this.take()
    if (!token) {
      this.exact = false
      return { kind: "expr", id: this.graph.add("opaque:token:") }
    }
    let value: ParsedValue
    if (token.text === "!" || token.text === "not")
      value = { kind: "expr", id: this.graph.add("not", this.materialize(this.parsePrefix())) }
    else if (token.text === "-")
      value = { kind: "expr", id: this.graph.add("neg", this.materialize(this.parsePrefix())) }
    else if (token.text === "+") value = this.parsePrefix()
    else if (token.text === "await") {
      this.exact = false
      value = {
        kind: "expr",
        id: this.graph.add(`${languagePrefix(this.fn.language)}-await`, this.materialize(this.parsePrefix())),
      }
    } else if (token.text === "(") {
      value = this.parse(0)
      if (this.peek() === ")") this.take()
    } else if (isKind(token, "string")) value = { kind: "expr", id: this.graph.add(`str:${token.text}`) }
    else if (isKind(token, "number")) value = { kind: "expr", id: this.graph.add(`num:${token.text}`) }
    else if (isKind(token, "ident")) {
      const bound = this.env.get(token.text)
      value = bound === undefined ? { kind: "name", names: [token.text] } : { kind: "expr", id: bound }
    } else {
      this.exact = false
      value = { kind: "expr", id: this.graph.add(`opaque:token:${token.text}`) }
    }

    while (true) {
      if (isMemberSeparator(this.peek(), this.fn.language)) {
        this.take()
        const member = this.take()
        if (!isKind(member, "ident")) return value
        if (value.kind === "name") value.names.push(member!.text)
        else value = { kind: "member", receiver: this.materialize(value), member: member!.text }
        continue
      }
      if (this.peek() === "(") {
        this.take()
        const args: number[] = []
        if (this.peek() !== ")") {
          while (true) {
            args.push(this.materialize(this.parse(0)))
            if (this.peek() !== ",") break
            this.take()
          }
        }
        if (this.peek() === ")") this.take()
        if (value.kind === "name") value = { kind: "expr", id: this.resolveNamedCall(value.names, args) }
        else if (value.kind === "member")
          value = { kind: "expr", id: this.resolveMethodCall(value.receiver, value.member, args) }
        else {
          this.exact = false
          value = { kind: "expr", id: this.graph.add("apply", value.id, ...args) }
        }
        continue
      }
      if (this.peek() !== "[") return value
      this.take()
      const index = this.materialize(this.parse(0))
      if (this.peek() === "]") this.take()
      this.exact = false
      value = { kind: "expr", id: this.graph.add("index", this.materialize(value), index) }
    }
  }

  private intrinsicNamedCall(names: string[], args: number[]) {
    const joined = names.join(".")
    const intrinsic = namedIntrinsic(this.fn.language, joined, args.length)
    if (!intrinsic) return
    if (intrinsic === "csharp-eq") return this.graph.add(intrinsic, args[0]!, args[1]!)
    return this.graph.add(
      intrinsic,
      ...args.slice(
        0,
        intrinsic.endsWith("-lower") ||
          intrinsic.endsWith("-trim") ||
          intrinsic.endsWith("-length") ||
          intrinsic.endsWith("-string") ||
          intrinsic.endsWith("-is-empty")
          ? 1
          : undefined,
      ),
    )
  }

  private localPrefix() {
    if (["java", "csharp"].includes(this.fn.language)) {
      const receiver = this.fn.receiver || this.fn.unit.class
      return [this.fn.unit.package, receiver].filter(Boolean).join(".")
    }
    if (this.fn.language === "php" && this.fn.receiver)
      return [this.fn.unit.package, this.fn.receiver].filter(Boolean).join(".")
    return this.fn.unit.package.replace(/^\.+|\.+$/g, "")
  }

  private resolveNamedCall(names: string[], args: number[]) {
    const intrinsic = this.intrinsicNamedCall(names, args)
    if (intrinsic !== undefined) return intrinsic
    if (names.length === 0) {
      this.exact = false
      return this.graph.add("invoke-unresolved:empty", ...args)
    }
    if (names.length === 1) {
      const name = names[0]!
      const staticImport = this.fn.unit.staticImports.get(name)
      if (staticImport) return this.graph.add(`invoke:${staticImport}`, ...args)
      if (this.fn.language === "go" && goBuiltins.has(name)) return this.graph.add(`go-builtin:${name}`, ...args)
      const prefix = this.localPrefix()
      return this.graph.add(`invoke:${prefix ? `${prefix}.` : ""}${name}`, ...args)
    }
    const first = names[0]!.replace(/^\$/, "")
    if (["self", "cls", "this"].includes(first) && this.fn.receiver) {
      return this.graph.add(
        `invoke:${[this.fn.unit.package, this.fn.receiver, ...names.slice(1)].filter(Boolean).join(".")}`,
        ...args,
      )
    }
    const imported = this.fn.unit.imports.get(first)
    if (imported) return this.graph.add(`invoke:${imported}.${names.slice(1).join(".")}`, ...args)
    const joined = names.join(".")
    if (["go", "cpp"].includes(this.fn.language)) return this.graph.add(`invoke:${joined}`, ...args)
    if (["java", "csharp"].includes(this.fn.language)) {
      const className =
        names.length === 2 && this.fn.unit.package
          ? `${this.fn.unit.package}.${names[0]}`
          : names.slice(0, -1).join(".")
      return this.graph.add(`invoke:${className}.${names.at(-1)}`, ...args)
    }
    if (["typescript", "javascript", "python", "php"].includes(this.fn.language)) {
      return this.graph.add(`invoke:${[this.fn.unit.package, joined].filter(Boolean).join(".")}`, ...args)
    }
    this.exact = false
    return this.graph.add(`invoke-unresolved:${joined}`, ...args)
  }

  private resolveMethodCall(receiver: number, method: string, args: number[]) {
    const intrinsic = methodIntrinsic(this.fn.language, method, args.length)
    if (intrinsic)
      return this.graph.add(
        intrinsic,
        receiver,
        ...args.slice(
          0,
          intrinsic.endsWith("-suffix") ||
            intrinsic.endsWith("-prefix") ||
            intrinsic.endsWith("-contains") ||
            intrinsic.endsWith("-eq")
            ? 1
            : 0,
        ),
      )
    this.exact = false
    return this.graph.add(`invoke-unresolved-method:${method}`, receiver, ...args)
  }
}

function precedence(operator: string) {
  if (["||", "or"].includes(operator)) return 1
  if (operator === "??") return 2
  if (["&&", "and"].includes(operator)) return 3
  if (["==", "===", "!=", "!==", "is", "in", "<", ">", "<=", ">="].includes(operator)) return 4
  if (["+", "-", "."].includes(operator)) return 5
  if (["*", "/", "%"].includes(operator)) return 6
  if (operator === "**") return 7
  return -1
}

function binaryOperator(operator: string, language: Language) {
  const operators: Record<string, string> = {
    "||": "or",
    or: "or",
    "&&": "and",
    and: "and",
    "??": "coalesce",
    "==": "eq",
    "===": "eq",
    is: "eq",
    "!=": "not-eq",
    "!==": "not-eq",
    in: "contains-reversed",
    "<": "lt",
    ">": "gt",
    "<=": "le",
    ">=": "ge",
    "+": "add",
    "-": "sub",
    "*": "mul",
    "/": "div",
    "%": "mod",
    "**": "pow",
  }
  if (operator === ".") return language === "php" ? "concat" : "opaque:dot"
  return operators[operator] ?? `opaque:binary:${operator}`
}

function isMemberSeparator(operator: string, language: Language) {
  if ([".", "?."].includes(operator)) return language !== "php"
  if (operator === "::") return ["cpp", "php", "csharp"].includes(language)
  return operator === "->" && ["cpp", "php"].includes(language)
}

const goBuiltins = new Set([
  "string",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
  "float32",
  "float64",
  "complex64",
  "complex128",
  "bool",
  "byte",
  "rune",
  "make",
  "append",
  "copy",
  "cap",
  "close",
  "complex",
  "delete",
  "imag",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
  "clear",
  "min",
  "max",
])

function namedIntrinsic(language: Language, name: string, arity: number) {
  const lower = name.toLowerCase()
  if (language === "go") {
    if (name === "strings.ToLower" && arity === 1) return "go-lower"
    if (name === "strings.TrimSpace" && arity === 1) return "go-trim"
    if (name === "strings.HasSuffix" && arity === 2) return "go-suffix"
    if (name === "strings.HasPrefix" && arity === 2) return "go-prefix"
    if (name === "len" && arity === 1) return "go-length"
  }
  if (language === "python" && name === "len" && arity === 1) return "py-length"
  if (language === "python" && name === "str" && arity === 1) return "py-string"
  if (language === "csharp" && lower === "string.equals" && arity >= 2) return "csharp-eq"
  if (language === "csharp" && lower === "string.isnullorempty" && arity === 1) return "csharp-is-empty"
  if (language === "php" && ["strtolower", "mb_strtolower"].includes(lower) && arity >= 1) return "php-lower"
  if (language === "php" && lower === "trim" && arity >= 1) return "php-trim"
  if (language === "php" && lower === "str_ends_with" && arity === 2) return "php-suffix"
  if (language === "php" && lower === "str_starts_with" && arity === 2) return "php-prefix"
  if (language === "php" && ["strlen", "mb_strlen"].includes(lower) && arity >= 1) return "php-length"
  if (language === "cpp" && ["lower", "to_lower", "strings.to_lower", "yolk.lower"].includes(lower) && arity === 1)
    return "cpp-lower"
  if (language === "cpp" && ["trim", "trim_copy", "strings.trim", "yolk.trim"].includes(lower) && arity === 1)
    return "cpp-trim"
  if (language === "cpp" && ["ends_with", "strings.ends_with", "yolk.ends_with"].includes(lower) && arity === 2)
    return "cpp-suffix"
  if (language === "cpp" && ["starts_with", "strings.starts_with", "yolk.starts_with"].includes(lower) && arity === 2)
    return "cpp-prefix"
  if (language === "hcl" && lower === "lower" && arity === 1) return "hcl-lower"
  if (language === "hcl" && ["trimspace", "trim"].includes(lower) && arity >= 1) return "hcl-trim"
  if (language === "hcl" && lower === "endswith" && arity === 2) return "hcl-suffix"
  if (language === "hcl" && lower === "startswith" && arity === 2) return "hcl-prefix"
  if (language === "hcl" && lower === "length" && arity === 1) return "hcl-length"
  if (["typescript", "javascript"].includes(language) && name === "String" && arity === 1)
    return `${languagePrefix(language)}-string`
}

function methodIntrinsic(language: Language, method: string, arity: number) {
  const prefix = languagePrefix(language)
  const unary: Record<string, string[]> = {
    "java-lower": ["toLowerCase"],
    "java-trim": ["trim", "strip"],
    "java-is-empty": ["isEmpty"],
    "java-length": ["length"],
    "ts-lower": ["toLowerCase"],
    "ts-trim": ["trim"],
    "js-lower": ["toLowerCase"],
    "js-trim": ["trim"],
    "py-lower": ["lower"],
    "py-casefold": ["casefold"],
    "py-trim": ["strip"],
    "csharp-lower": ["ToLower", "ToLowerInvariant"],
    "csharp-trim": ["Trim"],
    "cpp-is-empty": ["empty"],
    "cpp-length": ["size", "length"],
  }
  if (arity === 0) {
    const match = Object.entries(unary).find(
      ([operation, names]) => operation.startsWith(`${prefix}-`) && names.includes(method),
    )
    if (match) return match[0]
  }
  const binary: Record<string, string[]> = {
    "java-suffix": ["endsWith"],
    "java-prefix": ["startsWith"],
    "java-eq": ["equals", "contentEquals"],
    "ts-suffix": ["endsWith"],
    "ts-prefix": ["startsWith"],
    "ts-contains": ["includes"],
    "js-suffix": ["endsWith"],
    "js-prefix": ["startsWith"],
    "js-contains": ["includes"],
    "py-suffix": ["endswith"],
    "py-prefix": ["startswith"],
    "csharp-suffix": ["EndsWith"],
    "csharp-prefix": ["StartsWith"],
    "csharp-eq": ["Equals"],
    "cpp-suffix": ["ends_with"],
    "cpp-prefix": ["starts_with"],
  }
  if (arity >= 1) {
    const match = Object.entries(binary).find(
      ([operation, names]) => operation.startsWith(`${prefix}-`) && names.includes(method),
    )
    if (match) return match[0]
  }
}

function parseExpr(graph: EGraph, tokens: Token[], fn: FunctionDecl, env: Map<string, number>): ParsedExpr {
  const parser = new ExprParser(graph, tokens, fn, env)
  if (compactTokens(tokens).length === 0) return { id: graph.add("null"), exact: true }
  const id = parser.materialize(parser.parse(0))
  return { id, exact: parser.exact && parser.done }
}

function usesNewlineStatements(language: Language) {
  return ["go", "python", "typescript", "javascript", "shell", "hcl"].includes(language)
}

function statementEnd(tokens: Token[], start: number, language: Language) {
  let paren = 0
  let bracket = 0
  for (let index = start; index < tokens.length; index++) {
    const text = tokens[index]!.text
    if (text === "(") paren++
    if (text === ")" && paren > 0) paren--
    if (text === "[") bracket++
    if (text === "]" && bracket > 0) bracket--
    if ([";", "}"].includes(text) && paren === 0 && bracket === 0) return index
    if (usesNewlineStatements(language) && isKind(tokens[index], "newline") && paren === 0 && bracket === 0)
      return index
  }
  return tokens.length
}

function findAssignment(tokens: Token[], start: number, end: number) {
  let paren = 0
  let bracket = 0
  for (let index = start; index < end; index++) {
    const text = tokens[index]!.text
    if (text === "(") paren++
    if (text === ")" && paren > 0) paren--
    if (text === "[") bracket++
    if (text === "]" && bracket > 0) bracket--
    if (["=", ":="].includes(text) && paren === 0 && bracket === 0) return index
  }
  return -1
}

function lowerBlock(graph: EGraph, tokens: Token[], fn: FunctionDecl, env: Map<string, number>): BlockLowering {
  const result: BlockLowering = { semantic: 0, exprs: [], pure: true, hasValue: false }
  const conditional: { condition: number; then: number }[] = []
  let final = 0
  let hasFinal = false
  let index = 0
  while (index < tokens.length) {
    index = skipNewlines(tokens, index)
    while (tokens[index]?.text === ";") index++
    if (index >= tokens.length || isKind(tokens[index], "eof")) break
    if (tokens[index]?.text === "return") {
      const end = statementEnd(tokens, index + 1, fn.language)
      const expression = parseExpr(graph, tokens.slice(index + 1, end), fn, env)
      result.exprs.push(expression.id)
      result.pure &&= expression.exact
      final = expression.id
      hasFinal = true
      break
    }
    if (tokens[index]?.text === "if") {
      let conditionStart = skipNewlines(tokens, index + 1)
      let conditionEnd = -1
      let brace = -1
      if (tokens[conditionStart]?.text === "(") {
        const end = findMatching(tokens, conditionStart, "(", ")")
        if (end === undefined) {
          result.pure = false
          break
        }
        conditionStart++
        conditionEnd = end
        brace = skipNewlines(tokens, end + 1)
      } else {
        const found = tokens.findIndex((token, candidate) => candidate >= conditionStart && token.text === "{")
        conditionEnd = found
        brace = found
      }
      if (brace < 0 || tokens[brace]?.text !== "{") {
        result.pure = false
        index++
        continue
      }
      const blockEnd = findMatching(tokens, brace, "{", "}")
      if (blockEnd === undefined) {
        result.pure = false
        break
      }
      const condition = parseExpr(graph, tokens.slice(conditionStart, conditionEnd), fn, env)
      const thenResult = lowerBlock(graph, tokens.slice(brace + 1, blockEnd), fn, new Map(env))
      result.exprs.push(condition.id, ...thenResult.exprs)
      result.pure &&= condition.exact && thenResult.pure
      const next = skipNewlines(tokens, blockEnd + 1)
      if (tokens[next]?.text === "else") {
        const elseStart = skipNewlines(tokens, next + 1)
        if (tokens[elseStart]?.text === "{") {
          const elseEnd = findMatching(tokens, elseStart, "{", "}")
          if (elseEnd !== undefined) {
            const elseResult = lowerBlock(graph, tokens.slice(elseStart + 1, elseEnd), fn, new Map(env))
            result.exprs.push(...elseResult.exprs)
            result.pure &&= elseResult.pure
            if (thenResult.hasValue && elseResult.hasValue) {
              final = graph.add("if", condition.id, thenResult.semantic, elseResult.semantic)
              hasFinal = true
              break
            }
            index = elseEnd + 1
            continue
          }
        }
      }
      if (thenResult.hasValue) conditional.push({ condition: condition.id, then: thenResult.semantic })
      else result.pure = false
      index = blockEnd + 1
      continue
    }
    const end = statementEnd(tokens, index, fn.language)
    if (end <= index) {
      index++
      continue
    }
    const assignment = findAssignment(tokens, index, end)
    if (assignment >= 0) {
      const left = tokens.slice(index, assignment)
      const candidate = [...left].reverse().find((token) => isKind(token, "ident"))
      const hasComma = left.some((token) => token.text === ",")
      const rhs = parseExpr(graph, tokens.slice(assignment + 1, end), fn, env)
      result.exprs.push(rhs.id)
      result.pure &&= rhs.exact
      if (candidate && !hasComma) env.set(candidate.text, rhs.id)
      else result.pure = false
      index = end + 1
      continue
    }
    result.exprs.push(parseExpr(graph, tokens.slice(index, end), fn, env).id)
    result.pure = false
    index = end + 1
  }
  if (!hasFinal) return result
  let semantic = final
  for (const item of conditional.reverse()) semantic = graph.add("if", item.condition, item.then, semantic)
  result.semantic = semantic
  result.hasValue = true
  return result
}

function shellDependencyTerms(graph: EGraph, fn: FunctionDecl) {
  const known = new Map(fn.unit.functions.map((candidate) => [candidate.name, candidate.symbol]))
  const seen = new Set<string>()
  const result: number[] = []
  let boundary = true
  for (const token of fn.body) {
    if (isKind(token, "newline") || [";", "{", "}", "&&", "||", "then", "do"].includes(token.text)) {
      boundary = true
      continue
    }
    if (!boundary) continue
    boundary = false
    if (!isKind(token, "ident") || token.text.includes("=") || token.text.startsWith("$")) continue
    const target = known.get(token.text)
    if (!target || seen.has(target)) continue
    seen.add(target)
    result.push(graph.add(`invoke:${target}`))
  }
  return result
}

function hclDependencyTerms(graph: EGraph, fn: FunctionDecl) {
  const tokens = compactTokens(fn.body)
  const seen = new Set<string>()
  const result: number[] = []
  for (let index = 0; index < tokens.length; index++) {
    if (!isKind(tokens[index], "ident")) continue
    const names = [tokens[index]!.text]
    let cursor = index + 1
    while (tokens[cursor]?.text === "." && isKind(tokens[cursor + 1], "ident")) {
      names.push(tokens[cursor + 1]!.text)
      cursor += 2
    }
    if (names.length < 2 || tokens[cursor]?.text === "(") continue
    const target = hclDependencyTarget(fn, names)
    if (target && target !== fn.symbol && !seen.has(target)) {
      seen.add(target)
      result.push(graph.add(`invoke:${target}`))
    }
    index = cursor - 1
  }
  return result
}

function hclDependencyTarget(fn: FunctionDecl, names: string[]) {
  const first = names[0]
  if (first === "local") return `${fn.unit.package}.local.${names[1]}`
  if (first === "var") return `${fn.unit.package}.variable.${names[1]}`
  if (first === "module") return `${fn.unit.package}.module.${names[1]}`
  if (first === "data" && names.length >= 3) return `${fn.unit.package}.data.${names[1]}.${names[2]}`
  if (["path", "terraform", "each", "count"].includes(first!)) return ""
  return `${fn.unit.package}.resource.${first}.${names[1]}`
}

function lowerFunction(graph: EGraph, fn: FunctionDecl) {
  const env = new Map(fn.params.map((name, index) => [name, graph.add(`arg:${index}`)]))
  if (fn.receiver) {
    const receiver = graph.add("receiver")
    if (fn.language === "python") {
      env.set("self", receiver)
      env.set("cls", receiver)
    } else if (fn.language === "php") env.set("$this", receiver)
    else env.set("this", receiver)
  }
  const lowered = lowerBlock(graph, fn.body, fn, env)
  const dependencies =
    fn.language === "shell"
      ? shellDependencyTerms(graph, fn)
      : fn.language === "hcl"
        ? hclDependencyTerms(graph, fn)
        : []
  const semantic = lowered.hasValue ? lowered.semantic : graph.add(`opaque:${fn.symbol}`)
  const confidence = lowered.hasValue
    ? lowered.pure
      ? "pure-expression"
      : "partial"
    : dependencies.length
      ? "dependency-only"
      : "opaque"
  return { semantic, body: graph.add("body", semantic, ...lowered.exprs, ...dependencies), confidence }
}

function defaultRewrites() {
  const rules: Rewrite[] = []
  for (const prefix of ["go", "java", "ts", "js", "py", "csharp", "php", "cpp", "hcl"]) {
    for (const [name, arity] of [
      ["lower", 1],
      ["trim", 1],
      ["suffix", 2],
      ["prefix", 2],
      ["contains", 2],
      ["length", 1],
      ["is-empty", 1],
    ] as const) {
      const variables = arity === 1 ? "?x" : "?x ?y"
      rules.push(mustRewrite(`${prefix}-${name}`, `(${prefix}-${name} ${variables})`, `(${name} ${variables})`))
    }
  }
  rules.push(
    mustRewrite("java-eq", "(java-eq ?x ?y)", "(eq ?x ?y)"),
    mustRewrite("csharp-eq", "(csharp-eq ?x ?y)", "(eq ?x ?y)"),
  )
  for (const [name, variables] of [
    ["suffix", "?x ?y"],
    ["prefix", "?x ?y"],
    ["contains", "?x ?y"],
    ["eq", "?x ?y"],
    ["is-empty", "?x"],
  ] as const) {
    rules.push(
      mustRewrite(`if-${name}`, `(if (${name} ${variables}) true false)`, `(${name} ${variables})`),
      mustRewrite(`if-neg-${name}`, `(if (not (${name} ${variables})) false true)`, `(${name} ${variables})`),
    )
  }
  return rules
}

async function walkRepository(
  root: string,
  diagnostics: IndexDiagnostic[],
  options: { signal?: AbortSignal; maxFiles: number },
) {
  const files: string[] = []
  const state = { entries: 0, limited: false }
  const visit = async (directory: string): Promise<boolean> => {
    options.signal?.throwIfAborted()
    const entries = await (async () => {
      const result: Dirent[] = []
      try {
        for await (const entry of await opendir(directory)) {
          options.signal?.throwIfAborted()
          if (entry.isDirectory() && shouldSkipIndexDir(entry.name)) continue
          state.entries++
          if (state.entries > options.maxFiles) {
            state.limited = true
            break
          }
          result.push(entry)
        }
      } catch (error) {
        if (options.signal?.aborted) throw error
        diagnostics.push({ file: directory, kind: "walk-error", message: errorMessage(error) })
      }
      return result
    })()
    entries.sort((a, b) => compareText(a.name, b.name))
    for (const entry of entries) {
      options.signal?.throwIfAborted()
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (await visit(file)) return true
        continue
      }
      if (entry.isFile()) files.push(file)
    }
    if (!state.limited) return false
    diagnostics.push({
      file: root,
      kind: "repository-limit",
      message: `repository entry limit reached (${options.maxFiles})`,
    })
    return true
  }
  await visit(root)
  return files
}

function initializeUnit(
  root: string,
  file: string,
  source: string,
  language: Language,
  tokens: Token[],
  unit: FileUnit,
) {
  unit.path = file
  unit.relativePath = path.relative(root, file).split(path.sep).join("/") || path.basename(file)
  unit.source = source
  unit.language = language
  unit.tokens = tokens
  unit.imports ??= new Map()
  unit.staticImports ??= new Map()
  unit.package ||= pathModule(root, file, language)
  for (const fn of unit.functions) {
    fn.unit = unit
    fn.file = file
    fn.language = language
    fn.kind ||= fn.receiver ? "method" : "function"
    if (fn.visibility === "unknown") fn.visibility = functionVisibility(fn)
  }
}

function functionVisibility(fn: FunctionDecl): FunctionDecl["visibility"] {
  const declaration = fn.unit.tokens.filter((token) => token.line === fn.line).map((token) => token.text)
  if (["typescript", "javascript"].includes(fn.language)) return declaration.includes("export") ? "public" : "internal"
  if (fn.language === "python") return fn.name.startsWith("_") ? "internal" : "public"
  if (fn.language === "go") return /^[A-Z]/.test(fn.name) ? "public" : "internal"
  if (["java", "csharp", "php"].includes(fn.language)) {
    if (declaration.includes("private") || declaration.includes("protected") || declaration.includes("internal"))
      return "internal"
    return declaration.includes("public") ? "public" : "unknown"
  }
  if (fn.language === "hcl")
    return ["output", "module", "variable", "provider"].includes(fn.kind) ? "public" : "internal"
  return "unknown"
}

function cloneUnit(source: FileUnit): FileUnit {
  const unit: FileUnit = {
    path: source.path,
    relativePath: source.relativePath,
    source: source.source,
    language: source.language,
    package: source.package,
    class: source.class,
    imports: new Map(source.imports),
    staticImports: new Map(source.staticImports),
    tokens: source.tokens,
    functions: [],
  }
  unit.functions = source.functions.map((fn) => ({
    symbol: fn.symbol,
    name: fn.name,
    receiver: fn.receiver,
    kind: fn.kind,
    params: [...fn.params],
    body: fn.body,
    file: fn.file,
    line: fn.line,
    language: fn.language,
    visibility: fn.visibility,
    unit,
  }))
  return unit
}

function indexedCallsByName(index: CodeIndex) {
  const result = new Map<string, string[]>()
  for (const symbol of index.functions.keys()) {
    const name = symbol.split(".").at(-1)
    if (name) result.set(name, [...(result.get(name) ?? []), symbol])
  }
  return result
}

function resolveIndexedCall(
  index: CodeIndex,
  callsByName: ReadonlyMap<string, ReadonlyArray<string>>,
  caller: string,
  raw: string,
): string | undefined {
  if (index.functions.has(raw)) return raw
  const matches = new Set<string>()
  const name = raw.split(".").at(-1)
  if (!name) return
  const callerPrefix = caller.slice(0, Math.max(0, caller.lastIndexOf(".")))
  for (const symbol of callsByName.get(name) ?? []) {
    if (symbol.endsWith(`.${raw}`) || raw.endsWith(`.${symbol}`)) {
      matches.add(symbol)
      continue
    }
    if (symbol.startsWith(`${callerPrefix}.`)) matches.add(symbol)
  }
  const ordered = [...matches].sort()
  if (ordered.length === 1) return ordered[0]
  const byName = callsByName.get(name) ?? []
  if (byName.length === 1) return byName[0]
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function cancellationCheckpoint(signal?: AbortSignal) {
  signal?.throwIfAborted()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  signal?.throwIfAborted()
}

function compareText(a: string, b: string) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

async function detectFileLanguage(file: string, signal?: AbortSignal) {
  const detected = detectLanguage(file)
  if (detected || path.extname(file)) return detected
  signal?.throwIfAborted()
  const handle = await open(file, "r")
  try {
    const prefix = Buffer.alloc(256)
    const result = await handle.read(prefix, 0, prefix.byteLength, 0)
    return detectLanguage(file, prefix.subarray(0, result.bytesRead))
  } finally {
    await handle.close()
  }
}

function sortedEntries<V>(map: Map<string, V>) {
  return [...map.entries()].sort(([a], [b]) => compareText(a, b))
}

function sourcePriority(root: string, file: string) {
  const parts = path.relative(root, file).split(path.sep)
  if (parts.some((part) => part === "src" || part === "lib" || part === "source")) return 0
  if (parts.some((part) => part === "test" || part === "tests" || part === "__tests__")) return 2
  return 1
}

export async function buildIndex(root: string, options: BuildIndexOptions = {}): Promise<CodeIndex> {
  const started = performance.now()
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    maxFunctions: options.maxFunctions ?? DEFAULT_MAX_FUNCTIONS,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
  }
  options.signal?.throwIfAborted()
  const absolute = path.resolve(root)
  const metadata = await stat(absolute)
  if (!metadata.isDirectory()) throw new Error(`${root}: not a directory`)
  const index = new CodeIndex(absolute, limits.maxNodes)
  let sourceBytes = 0
  let sourceLimitReported = false
  const files = await walkRepository(absolute, index.diagnostics, {
    signal: options.signal,
    maxFiles: limits.maxFiles,
  })
  options.cache?.retain(new Set(files))
  files.sort((a, b) => sourcePriority(absolute, a) - sourcePriority(absolute, b) || compareText(a, b))
  for (const file of files) {
    options.signal?.throwIfAborted()
    if (shouldSkipIndexPath(file)) continue
    if (isKnownUnsupportedSourcePath(file)) {
      index.stats.filesSeen++
      index.stats.filesSkipped++
      if (index.diagnostics.filter((item) => item.kind === "unsupported-language").length < 20) {
        index.diagnostics.push({
          file: path.relative(absolute, file).split(path.sep).join("/"),
          kind: "unsupported-language",
          message: "source language is outside Yolk's supported top-ten profile",
        })
      }
      continue
    }
    const extensionLanguage = await detectFileLanguage(file, options.signal).catch(() => undefined)
    if (!extensionLanguage) continue
    const fileMetadata = await stat(file).catch(() => undefined)
    if (!fileMetadata?.isFile()) continue
    if (fileMetadata.size > MAX_SOURCE_FILE_BYTES) {
      if (extensionLanguage) {
        index.stats.filesSeen++
        index.stats.filesSkipped++
        index.diagnostics.push({
          file: path.relative(absolute, file).split(path.sep).join("/"),
          language: extensionLanguage,
          kind: "file-too-large",
          message: "source file exceeds 8 MiB",
        })
      }
      continue
    }
    if (sourceBytes + fileMetadata.size > limits.maxSourceBytes) {
      if (extensionLanguage) {
        index.stats.filesSeen++
        index.stats.filesSkipped++
      }
      if (!sourceLimitReported) {
        index.diagnostics.push({
          file: path.relative(absolute, file).split(path.sep).join("/"),
          kind: "repository-limit",
          message: `repository source byte limit reached (${limits.maxSourceBytes})`,
        })
        sourceLimitReported = true
      }
      continue
    }
    sourceBytes += fileMetadata.size
    const raw = await readFile(file, { signal: options.signal }).catch((error: unknown) => {
      if (options.signal?.aborted) throw error
      index.diagnostics.push({ file, kind: "read-error", message: errorMessage(error) })
      return undefined
    })
    if (!raw) continue
    if (raw.includes(0)) {
      sourceBytes -= fileMetadata.size
      options.cache?.delete(file)
      index.stats.filesSeen++
      index.stats.filesSkipped++
      continue
    }
    const language = detectLanguage(file, raw)
    if (!language) continue
    index.stats.filesSeen++
    const source = raw.toString("utf8")
    const sourceHash = hash(source)
    const cached = options.cache?.get(file, sourceHash, language)
    if (cached) {
      index.stats.cacheHits++
      options.cache?.set(
        file,
        sourceHash,
        language,
        fileMetadata.size,
        fileMetadata.mtimeMs,
        fileMetadata.ctimeMs,
        cached,
      )
    }
    let unit = cached
    if (!unit) {
      let tokens: Token[]
      try {
        tokens = lexLanguage(source, language)
      } catch (error) {
        index.stats.parseErrors++
        index.diagnostics.push({
          file: path.relative(absolute, file).split(path.sep).join("/"),
          language,
          kind: "lex-error",
          message: errorMessage(error),
        })
        continue
      }
      try {
        unit =
          language === "go"
            ? parseGoUnit(file, tokens)
            : language === "java"
              ? parseJavaUnit(file, tokens)
              : parserForLanguage(absolute, file, language, source, tokens)
      } catch (error) {
        index.stats.parseErrors++
        index.diagnostics.push({
          file: path.relative(absolute, file).split(path.sep).join("/"),
          language,
          kind: "parse-error",
          message: errorMessage(error),
        })
        continue
      }
      initializeUnit(absolute, file, source, language, tokens, unit)
      options.cache?.set(
        file,
        sourceHash,
        language,
        fileMetadata.size,
        fileMetadata.mtimeMs,
        fileMetadata.ctimeMs,
        unit,
      )
    }
    index.units.push(unit)
    index.stats.filesByLanguage.set(language, (index.stats.filesByLanguage.get(language) ?? 0) + 1)
  }

  index.units.sort((a, b) => compareText(a.path, b.path))
  let functionLimitReached = false
  for (const unit of index.units) {
    for (const fn of unit.functions) {
      if (index.functions.size > 0 && index.functions.size % 64 === 0) {
        await cancellationCheckpoint(options.signal)
      }
      options.signal?.throwIfAborted()
      if (index.functions.size >= limits.maxFunctions) {
        index.diagnostics.push({
          file: path.relative(absolute, fn.file).split(path.sep).join("/"),
          language: fn.language,
          kind: "repository-limit",
          message: `repository function limit reached (${limits.maxFunctions})`,
        })
        functionLimitReached = true
        break
      }
      if (index.functions.has(fn.symbol))
        fn.symbol = `${fn.symbol}@${path.relative(absolute, fn.file).split(path.sep).join("/")}:${fn.line}`
      try {
        const lowered = lowerFunction(index.graph, fn)
        const bodyHash = hash(tokenTexts(fn.body))
        const signatureHash = hash(signatureText(fn))
        index.functions.set(fn.symbol, {
          decl: fn,
          semanticRoot: lowered.semantic,
          bodyRoot: lowered.body,
          originalTerm: "",
          canonical: "",
          fingerprint: "",
          sourceHash: hash(`${signatureHash}\0${bodyHash}`),
          signatureHash,
          bodyHash,
          confidence: lowered.confidence,
          calls: [],
          unresolvedCalls: [],
        })
        index.stats.symbolsByLanguage.set(fn.language, (index.stats.symbolsByLanguage.get(fn.language) ?? 0) + 1)
      } catch (error) {
        if (!(error instanceof NodeLimitError)) throw error
        index.diagnostics.push({
          file: path.relative(absolute, fn.file).split(path.sep).join("/"),
          language: fn.language,
          kind: "repository-limit",
          message: error.message,
        })
        functionLimitReached = true
        break
      }
    }
    if (functionLimitReached) break
  }
  options.signal?.throwIfAborted()
  index.graph.rebuild()
  const before = index.graph.extractAll()
  for (const fn of index.functions.values()) {
    const extracted = before.get(index.graph.find(fn.semanticRoot))
    if (extracted?.ok) fn.originalTerm = extracted.text
  }
  index.stats.files = index.units.length
  index.stats.functions = index.functions.size
  index.stats.lexAndLowerMs = performance.now() - started

  const saturationStarted = performance.now()
  options.signal?.throwIfAborted()
  index.stats.runner = await index.graph.run(defaultRewrites(), {
    iterations: 12,
    nodeLimit: limits.maxNodes,
    timeLimitMs: 2_000,
    signal: options.signal,
  })
  index.stats.saturationMs = performance.now() - saturationStarted
  index.stats.eClasses = index.graph.numClasses()
  index.stats.eNodes = index.graph.numNodes()
  index.analysis = index.graph.analyze()
  const extracted = index.graph.extractAll()
  const callsByName = indexedCallsByName(index)
  const groups = new Map<number, string[]>()
  let callResolutionCount = 0
  for (const [symbol, fn] of sortedEntries(index.functions)) {
    if (callResolutionCount++ % 64 === 0) await cancellationCheckpoint(options.signal)
    fn.semanticRoot = index.graph.find(fn.semanticRoot)
    fn.bodyRoot = index.graph.find(fn.bodyRoot)
    const canonical = extracted.get(fn.semanticRoot)
    if (canonical?.ok) {
      fn.canonical = canonical.text
      fn.fingerprint = hash(canonical.text)
    }
    const data = index.analysis.get(fn.bodyRoot)
    for (const call of [...(data?.calls ?? [])].sort()) {
      const resolved = resolveIndexedCall(index, callsByName, symbol, call)
      if (resolved) fn.calls.push(resolved)
      else fn.unresolvedCalls.push(call)
    }
    fn.unresolvedCalls.push(...[...(data?.unresolvedCalls ?? [])].sort())
    fn.calls = [...new Set(fn.calls)].sort()
    fn.unresolvedCalls = [...new Set(fn.unresolvedCalls)].sort()
    if (fn.confidence === "pure-expression")
      groups.set(fn.semanticRoot, [...(groups.get(fn.semanticRoot) ?? []), symbol])
  }
  for (const symbols of groups.values()) symbols.sort()
  index.equivalenceGroups = groups
  return index
}
