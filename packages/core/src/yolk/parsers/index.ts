import { Language, TokenKind, lexLanguage, type Token } from "../language"
import type { FileUnit, FunctionDecl } from "../indexer"

type TokenContainer = {
  kind: string
  name: string
  open: number
  close: number
  depth: number
}

type PythonLine = {
  text: string
  trim: string
  indent: number
  number: number
}

type TokenOf<Kind extends Token["kind"]> = Token & { kind: Kind }

const isIdent = (token: Token | undefined): token is TokenOf<typeof TokenKind.Ident> => token?.kind === TokenKind.Ident
const isString = (token: Token | undefined): token is TokenOf<typeof TokenKind.String> =>
  token?.kind === TokenKind.String
const isNewline = (token: Token | undefined): token is TokenOf<typeof TokenKind.Newline> =>
  token?.kind === TokenKind.Newline
const isEOF = (token: Token | undefined): token is TokenOf<typeof TokenKind.EOF> => token?.kind === TokenKind.EOF

const token = (
  kind: typeof TokenKind.Ident | typeof TokenKind.Punct | typeof TokenKind.Newline,
  text: string,
  line: number,
): Token => ({ kind, text, offset: 0, line })

const skipNewlines = (tokens: Token[], start: number) => {
  let index = start
  while (isNewline(tokens[index])) index++
  return index
}

const findMatching = (tokens: Token[], open: number, left: string, right: string) => {
  if (tokens[open]?.text !== left) return -1
  let depth = 0
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index].text === left) depth++
    if (tokens[index].text === right && --depth === 0) return index
  }
  return -1
}

const compactTokens = (tokens: Token[]) => tokens.filter((item) => !isNewline(item) && !isEOF(item))

const cleanModuleSegment = (value: string) => value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "root"

const slash = (value: string) => value.replaceAll("\\", "/")

const relativePath = (root: string, path: string) => {
  const normalizedRoot = slash(root).replace(/\/+$/, "")
  const normalizedPath = slash(path)
  if (normalizedPath === normalizedRoot) return normalizedPath.split("/").at(-1) ?? normalizedPath
  if (normalizedPath.startsWith(normalizedRoot + "/")) return normalizedPath.slice(normalizedRoot.length + 1)
  return normalizedPath.split("/").at(-1) ?? normalizedPath
}

const extension = (path: string) => {
  const name = slash(path).split("/").at(-1) ?? path
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index) : ""
}

const pathModule = (root: string, path: string, language: Language) => {
  let rel = relativePath(root, path)
  if (language === "hcl") {
    rel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""
    if (!rel || rel === ".") return "hcl"
  } else {
    rel = rel.slice(0, rel.length - extension(rel).length)
    if ((language === "typescript" || language === "javascript" || language === "python") && rel.endsWith("/index")) {
      rel = rel.slice(0, -"/index".length)
    }
  }
  const parts = rel
    .split(/[\\/.\-]+/)
    .filter(Boolean)
    .map(cleanModuleSegment)
  return parts.length ? parts.join(".") : String(language)
}

const newFileUnit = (root: string, path: string, language: Language, source: string, tokens: Token[]) => {
  const unit: FileUnit = {
    path,
    relativePath: relativePath(root, path),
    source,
    language,
    package: pathModule(root, path, language),
    class: "",
    imports: new Map<string, string>(),
    staticImports: new Map<string, string>(),
    tokens,
    functions: [],
  }
  return unit
}

const addFunction = (unit: FileUnit, declaration: Omit<FunctionDecl, "unit" | "visibility">) => {
  unit.functions.push({ ...declaration, visibility: "unknown", unit })
}

export const normalizeModuleText = (value: string) =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replaceAll("\\", ".")
    .replaceAll("/", ".")
    .replace(/^\.+|\.+$/g, "")
    .split(/[.\-]+/)
    .filter(Boolean)
    .map(cleanModuleSegment)
    .join(".")

export const resolveModuleSpecifier = (unit: FileUnit, specifier: string) => {
  if (!specifier.startsWith(".")) return normalizeModuleText(specifier)
  const directory = unit.relativePath.includes("/")
    ? unit.relativePath.slice(0, unit.relativePath.lastIndexOf("/"))
    : ""
  const segments = (directory + "/" + specifier).split("/")
  const resolved = segments
    .reduce<string[]>((parts, part) => {
      if (!part || part === ".") return parts
      if (part === "..") return parts.slice(0, -1)
      return [...parts, part]
    }, [])
    .join("/")
  const withoutExtension = resolved.slice(0, resolved.length - extension(resolved).length).replace(/\/index$/, "")
  return normalizeModuleText(withoutExtension)
}

const depthBefore = (tokens: Token[]) => {
  let depth = 0
  return tokens.map((item) => {
    const before = depth
    if (item.text === "{") depth++
    if (item.text === "}" && depth > 0) depth--
    return before
  })
}

const findContainers = (tokens: Token[], keywords: ReadonlyMap<string, string>) => {
  const depths = depthBefore(tokens)
  const containers: TokenContainer[] = []
  for (let index = 0; index < tokens.length - 1; index++) {
    const kind = keywords.get(tokens[index].text)
    if (!kind) continue
    let nameAt = skipNewlines(tokens, index + 1)
    if (tokens[index].text === "record" && ["class", "struct"].includes(tokens[nameAt]?.text))
      nameAt = skipNewlines(tokens, nameAt + 1)
    if (!isIdent(tokens[nameAt])) continue
    const name = tokens[nameAt].text.replace(/^@/, "")
    let open = nameAt
    while (open < tokens.length && tokens[open].text !== "{" && tokens[open].text !== ";") open++
    if (tokens[open]?.text !== "{") continue
    const close = findMatching(tokens, open, "{", "}")
    if (close < 0) continue
    containers.push({ kind, name, open, close, depth: depths[open] })
  }
  return containers.sort((left, right) => left.open - right.open || left.close - right.close)
}

const assignedClassName = (tokens: Token[], classAt: number) => {
  let equals = -1
  for (let index = classAt - 1; index >= 0; index--) {
    if (tokens[index].text === "=") {
      equals = index
      break
    }
    if (
      tokens[index].text === ";" ||
      isNewline(tokens[index]) ||
      tokens[index].text === "{" ||
      tokens[index].text === "}"
    )
      break
  }
  if (equals >= 0) {
    for (let index = equals - 1; index >= 0; index--) {
      if (isIdent(tokens[index]) && !["const", "let", "var"].includes(tokens[index].text)) return tokens[index].text
      if (tokens[index].text === ";" || isNewline(tokens[index])) break
    }
  }
  for (let index = classAt - 1; index >= 0 && classAt - index <= 3; index--) {
    if (tokens[index].text === "default") return "default"
  }
  return ""
}

const findECMAScriptContainers = (tokens: Token[]) => {
  const containers = findContainers(tokens, new Map([["class", "class"]]))
  const seen = new Set(containers.map((item) => item.open))
  const depths = depthBefore(tokens)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== "class") continue
    const afterClass = skipNewlines(tokens, index + 1)
    if (isIdent(tokens[afterClass])) continue
    let open = afterClass
    while (open < tokens.length && tokens[open].text !== "{" && tokens[open].text !== ";" && !isNewline(tokens[open]))
      open++
    if (tokens[open]?.text !== "{" || seen.has(open)) continue
    const close = findMatching(tokens, open, "{", "}")
    if (close < 0) continue
    containers.push({
      kind: "class",
      name: assignedClassName(tokens, index) || `anonymous${tokens[index].line}`,
      open,
      close,
      depth: depths[open],
    })
    seen.add(open)
  }
  return containers.sort((left, right) => left.open - right.open || left.close - right.close)
}

const innermostContainer = (containers: TokenContainer[], position: number, kind = "") =>
  containers
    .filter((item) => item.open < position && position < item.close && (!kind || item.kind === kind))
    .sort((left, right) => right.open - left.open)[0]

const splitTopLevel = (tokens: Token[], separator: string) => {
  const output: Token[][] = []
  let start = 0
  let paren = 0
  let bracket = 0
  let brace = 0
  let angle = 0
  tokens.forEach((item, index) => {
    if (item.text === "(") paren++
    if (item.text === ")" && paren > 0) paren--
    if (item.text === "[") bracket++
    if (item.text === "]" && bracket > 0) bracket--
    if (item.text === "{") brace++
    if (item.text === "}" && brace > 0) brace--
    if (item.text === "<") angle++
    if (item.text === ">" && angle > 0) angle--
    if (item.text === separator && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      output.push(tokens.slice(start, index))
      start = index + 1
    }
  })
  output.push(tokens.slice(start))
  return output
}

const parameterNoise = new Set([
  "const",
  "final",
  "readonly",
  "ref",
  "out",
  "in",
  "params",
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "unsigned",
  "signed",
  "volatile",
  "mutable",
  "string",
  "bool",
  "boolean",
  "int",
  "long",
  "short",
  "double",
  "float",
  "char",
  "byte",
  "object",
  "var",
  "str",
  "bytes",
  "list",
  "dict",
  "tuple",
  "set",
  "auto",
  "typename",
  "class",
  "struct",
  "self",
  "cls",
])

const parseGenericParams = (tokens: Token[], preferDollar: boolean) =>
  splitTopLevel(compactTokens(tokens), ",").flatMap((original) => {
    const equals = original.findIndex((item) => item.text === "=")
    const segment = equals < 0 ? original : original.slice(0, equals)
    const preferred = segment.findLast(
      (item) =>
        isIdent(item) &&
        !parameterNoise.has(item.text.replace(/^\$/, "").toLowerCase()) &&
        (!preferDollar || item.text.startsWith("$")),
    )
    const candidate = preferred ?? (preferDollar ? segment.findLast(isIdent) : undefined)
    return candidate && candidate.text !== "self" && candidate.text !== "cls" ? [candidate.text] : []
  })

const firstLine = (tokens: Token[]) => tokens.find((item) => item.line > 0)?.line ?? 1

const syntheticReturn = (expression: Token[], language: Language) => [
  token(TokenKind.Ident, "return", firstLine(expression)),
  ...expression,
  ...(["go", "python", "shell"].includes(String(language)) ? [] : [token(TokenKind.Punct, ";", firstLine(expression))]),
  token(TokenKind.Newline, "\n", firstLine(expression)),
]

const nextBodyOrArrow = (tokens: Token[], start: number, limit: number): ["block" | "arrow" | "decl" | "", number] => {
  let paren = 0
  let bracket = 0
  let angle = 0
  for (let index = start; index < limit; index++) {
    if (tokens[index].text === "(") paren++
    if (tokens[index].text === ")" && paren > 0) paren--
    if (tokens[index].text === "[") bracket++
    if (tokens[index].text === "]" && bracket > 0) bracket--
    if (tokens[index].text === "<") angle++
    if (tokens[index].text === ">" && angle > 0) angle--
    if (paren || bracket || angle) continue
    if (tokens[index].text === "{") return ["block", index]
    if (tokens[index].text === "=>") return ["arrow", index]
    if (tokens[index].text === ";") return ["decl", index]
  }
  return ["", -1]
}

const expressionEnd = (tokens: Token[], start: number) => {
  let paren = 0
  let bracket = 0
  let brace = 0
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].text === "(") paren++
    if (tokens[index].text === ")" && paren > 0) paren--
    if (tokens[index].text === "[") bracket++
    if (tokens[index].text === "]" && bracket > 0) bracket--
    if (tokens[index].text === "{") brace++
    if (tokens[index].text === "}" && brace > 0) brace--
    if (!paren && !bracket && !brace && (tokens[index].text === ";" || isNewline(tokens[index]))) return index
  }
  return tokens.length
}

const isControlKeyword = (value: string) =>
  new Set(["if", "for", "while", "switch", "catch", "return", "new", "synchronized", "try", "do"]).has(value)

export const parseECMAScriptImports = (unit: FileUnit) => {
  const tokens = unit.tokens
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== "import") continue
    const start = skipNewlines(tokens, index + 1)
    if (start >= tokens.length || isString(tokens[start])) continue
    let end = start
    while (end < tokens.length && tokens[end].text !== ";" && !isNewline(tokens[end])) end++
    const from = tokens.slice(start, end).findIndex((item) => item.text === "from")
    const fromAt = from < 0 ? -1 : start + from
    if (fromAt < 0 || !isString(tokens[fromAt + 1])) continue
    const module = resolveModuleSpecifier(unit, tokens[fromAt + 1].text)
    if (tokens[start].text === "{") {
      const close = findMatching(tokens, start, "{", "}")
      if (close < 0 || close > fromAt) continue
      splitTopLevel(tokens.slice(start + 1, close), ",")
        .map(compactTokens)
        .forEach((segment) => {
          if (!isIdent(segment[0])) return
          const aliasAt = segment.findIndex((item) => item.text === "as")
          unit.staticImports.set(
            aliasAt >= 0 && isIdent(segment[aliasAt + 1]) ? segment[aliasAt + 1].text : segment[0].text,
            `${module}.${segment[0].text}`,
          )
        })
    } else if (tokens[start].text === "*" && tokens[start + 1]?.text === "as" && isIdent(tokens[start + 2])) {
      unit.imports.set(tokens[start + 2].text, module)
    } else if (isIdent(tokens[start])) {
      unit.imports.set(tokens[start].text, module)
    }
    index = end
  }
  for (let index = 0; index + 5 < tokens.length; index++) {
    if (!["const", "let", "var"].includes(tokens[index].text)) continue
    if (
      isIdent(tokens[index + 1]) &&
      tokens[index + 2].text === "=" &&
      tokens[index + 3].text === "require" &&
      tokens[index + 4].text === "(" &&
      isString(tokens[index + 5])
    ) {
      unit.imports.set(tokens[index + 1].text, resolveModuleSpecifier(unit, tokens[index + 5].text))
    }
  }
}

export const parseECMAScriptUnit = (
  root: string,
  path: string,
  language: Language,
  source: string,
  tokens: Token[],
) => {
  const unit = newFileUnit(root, path, language, source, tokens)
  parseECMAScriptImports(unit)
  const classes = findECMAScriptContainers(tokens)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== "function") continue
    let nameAt = skipNewlines(tokens, index + 1)
    if (tokens[nameAt]?.text === "*") nameAt = skipNewlines(tokens, nameAt + 1)
    if (!isIdent(tokens[nameAt])) continue
    const name = tokens[nameAt].text
    const paramsAt = skipNewlines(tokens, nameAt + 1)
    if (tokens[paramsAt]?.text !== "(") continue
    const paramsEnd = findMatching(tokens, paramsAt, "(", ")")
    if (paramsEnd < 0) continue
    const [kind, bodyAt] = nextBodyOrArrow(tokens, paramsEnd + 1, tokens.length)
    if (kind !== "block") continue
    const bodyEnd = findMatching(tokens, bodyAt, "{", "}")
    if (bodyEnd < 0) continue
    const container = innermostContainer(classes, index, "class")
    addFunction(unit, {
      symbol: container ? `${unit.package}.${container.name}.${name}` : `${unit.package}.${name}`,
      name,
      receiver: container?.name ?? "",
      kind: "function",
      params: parseGenericParams(tokens.slice(paramsAt + 1, paramsEnd), false),
      body: tokens.slice(bodyAt + 1, bodyEnd),
      file: path,
      line: tokens[index].line,
      language,
    })
    index = bodyEnd
  }

  const depths = depthBefore(tokens)
  for (let index = 0; index < tokens.length - 3; index++) {
    if (depths[index] !== 0 || !["const", "let", "var"].includes(tokens[index].text)) continue
    const nameAt = skipNewlines(tokens, index + 1)
    if (!isIdent(tokens[nameAt])) continue
    const name = tokens[nameAt].text
    let equals = nameAt + 1
    while (
      equals < tokens.length &&
      tokens[equals].text !== "=" &&
      tokens[equals].text !== ";" &&
      !isNewline(tokens[equals])
    )
      equals++
    if (tokens[equals]?.text !== "=") continue
    let start = skipNewlines(tokens, equals + 1)
    if (tokens[start]?.text === "async") start = skipNewlines(tokens, start + 1)
    if (tokens[start]?.text === "function") {
      start = skipNewlines(tokens, start + 1)
      if (isIdent(tokens[start])) start = skipNewlines(tokens, start + 1)
      if (tokens[start]?.text !== "(") continue
      const paramsEnd = findMatching(tokens, start, "(", ")")
      if (paramsEnd < 0) continue
      const [kind, bodyAt] = nextBodyOrArrow(tokens, paramsEnd + 1, tokens.length)
      if (kind !== "block") continue
      const bodyEnd = findMatching(tokens, bodyAt, "{", "}")
      if (bodyEnd < 0) continue
      addFunction(unit, {
        symbol: `${unit.package}.${name}`,
        name,
        receiver: "",
        kind: "function",
        params: parseGenericParams(tokens.slice(start + 1, paramsEnd), false),
        body: tokens.slice(bodyAt + 1, bodyEnd),
        file: path,
        line: tokens[index].line,
        language,
      })
      index = bodyEnd
      continue
    }
    let params: string[] = []
    let arrow = -1
    if (tokens[start]?.text === "(") {
      const paramsEnd = findMatching(tokens, start, "(", ")")
      if (paramsEnd < 0) continue
      params = parseGenericParams(tokens.slice(start + 1, paramsEnd), false)
      for (
        let cursor = paramsEnd + 1;
        cursor < tokens.length && tokens[cursor].text !== ";" && !isNewline(tokens[cursor]);
        cursor++
      ) {
        if (tokens[cursor].text === "=>") {
          arrow = cursor
          break
        }
      }
    } else if (isIdent(tokens[start])) {
      params = [tokens[start].text]
      const cursor = skipNewlines(tokens, start + 1)
      if (tokens[cursor]?.text === "=>") arrow = cursor
    }
    if (arrow < 0) continue
    const bodyAt = skipNewlines(tokens, arrow + 1)
    const blockEnd = tokens[bodyAt]?.text === "{" ? findMatching(tokens, bodyAt, "{", "}") : -1
    const bodyEnd = blockEnd >= 0 ? blockEnd : expressionEnd(tokens, bodyAt)
    const body =
      blockEnd >= 0 ? tokens.slice(bodyAt + 1, bodyEnd) : syntheticReturn(tokens.slice(bodyAt, bodyEnd), language)
    addFunction(unit, {
      symbol: `${unit.package}.${name}`,
      name,
      receiver: "",
      kind: "function",
      params,
      body,
      file: path,
      line: tokens[index].line,
      language,
    })
    index = bodyEnd
  }

  const classDepths = depthBefore(tokens)
  classes.forEach((container) => {
    for (let index = container.open + 1; index < container.close; index++) {
      if (classDepths[index] !== classDepths[container.open] + 1 || tokens[index].text !== "(" || index === 0) continue
      let nameAt = index - 1
      while (nameAt > container.open && isNewline(tokens[nameAt])) nameAt--
      if (!isIdent(tokens[nameAt]) || isControlKeyword(tokens[nameAt].text) || tokens[nameAt].text === "function")
        continue
      const name = tokens[nameAt].text
      const paramsEnd = findMatching(tokens, index, "(", ")")
      if (paramsEnd < 0) continue
      const [kind, bodyAt] = nextBodyOrArrow(tokens, paramsEnd + 1, container.close)
      if (!kind || kind === "decl") continue
      const bodyEnd = kind === "block" ? findMatching(tokens, bodyAt, "{", "}") : expressionEnd(tokens, bodyAt + 1)
      if (bodyEnd < 0) continue
      addFunction(unit, {
        symbol: `${unit.package}.${container.name}.${name}`,
        name,
        receiver: container.name,
        kind: "method",
        params: parseGenericParams(tokens.slice(index + 1, paramsEnd), false),
        body:
          kind === "block"
            ? tokens.slice(bodyAt + 1, bodyEnd)
            : syntheticReturn(tokens.slice(bodyAt + 1, bodyEnd), language),
        file: path,
        line: tokens[nameAt].line,
        language,
      })
      index = bodyEnd
    }
  })
  return unit
}

const joinDotted = (tokens: Token[]) =>
  tokens
    .filter((item) => isIdent(item) || item.text === "." || item.text === "*")
    .map((item) => item.text)
    .join("")

export const parseCSharpUnit = (root: string, path: string, source: string, tokens: Token[]) => {
  const language = Language.CSharp
  const unit = newFileUnit(root, path, language, source, tokens)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== "namespace") continue
    let end = index + 1
    while (end < tokens.length && tokens[end].text !== "{" && tokens[end].text !== ";") end++
    unit.package = joinDotted(tokens.slice(index + 1, end)) || unit.package
    break
  }
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== "using") continue
    let start = skipNewlines(tokens, index + 1)
    let end = start
    while (end < tokens.length && tokens[end].text !== ";") end++
    if (tokens[start]?.text === "static") start++
    const equals = tokens.slice(start, end).findIndex((item) => item.text === "=")
    if (equals >= 0 && isIdent(tokens[start]))
      unit.imports.set(tokens[start].text, joinDotted(tokens.slice(start + equals + 1, end)))
    else {
      const full = joinDotted(tokens.slice(start, end))
      if (full) unit.imports.set(full.split(".").at(-1) ?? full, full)
    }
    index = end
  }
  const containers = findContainers(
    tokens,
    new Map([
      ["class", "class"],
      ["record", "class"],
      ["struct", "class"],
      ["interface", "class"],
    ]),
  )
  const depths = depthBefore(tokens)
  containers.forEach((container) => {
    for (let index = container.open + 1; index < container.close; index++) {
      if (depths[index] !== depths[container.open] + 1 || tokens[index].text !== "(" || index === 0) continue
      let nameAt = index - 1
      while (nameAt > container.open && isNewline(tokens[nameAt])) nameAt--
      if (!isIdent(tokens[nameAt]) || isControlKeyword(tokens[nameAt].text)) continue
      const name = tokens[nameAt].text.replace(/^@/, "")
      const paramsEnd = findMatching(tokens, index, "(", ")")
      if (paramsEnd < 0) continue
      const [kind, bodyAt] = nextBodyOrArrow(tokens, paramsEnd + 1, container.close)
      if (!kind || kind === "decl") continue
      const bodyEnd = kind === "block" ? findMatching(tokens, bodyAt, "{", "}") : expressionEnd(tokens, bodyAt + 1)
      if (bodyEnd < 0) continue
      const prefix = unit.package ? `${unit.package}.${container.name}` : container.name
      addFunction(unit, {
        symbol: `${prefix}.${name}`,
        name,
        receiver: container.name,
        kind: "method",
        params: parseGenericParams(tokens.slice(index + 1, paramsEnd), false),
        body:
          kind === "block"
            ? tokens.slice(bodyAt + 1, bodyEnd)
            : syntheticReturn(tokens.slice(bodyAt + 1, bodyEnd), language),
        file: path,
        line: tokens[nameAt].line,
        language,
      })
      index = bodyEnd
    }
  })
  return unit
}

const joinNamespaceTokens = (tokens: Token[]) =>
  tokens
    .filter(isIdent)
    .map((item) => item.text.replace(/^\\/, ""))
    .join(".")

export const parsePHPUnit = (root: string, path: string, source: string, tokens: Token[]) => {
  const language = Language.PHP
  const unit = newFileUnit(root, path, language, source, tokens)
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text === "namespace") {
      let end = index + 1
      while (end < tokens.length && tokens[end].text !== ";" && tokens[end].text !== "{") end++
      unit.package = joinNamespaceTokens(tokens.slice(index + 1, end)) || unit.package
    }
    if (tokens[index].text !== "use") continue
    let start = skipNewlines(tokens, index + 1)
    const isFunction = tokens[start]?.text === "function"
    if (isFunction) start++
    let end = start
    while (end < tokens.length && tokens[end].text !== ";") end++
    const asOffset = tokens.slice(start, end).findIndex((item) => item.text === "as")
    const asAt = asOffset < 0 ? -1 : start + asOffset
    const full = joinNamespaceTokens(tokens.slice(start, asAt < 0 ? end : asAt))
    const alias =
      asAt >= 0 && tokens[asAt + 1] ? tokens[asAt + 1].text.replace(/^\$/, "") : (full.split(".").at(-1) ?? "")
    if (full && alias) (isFunction ? unit.staticImports : unit.imports).set(alias, full)
    index = end
  }
  const containers = findContainers(
    tokens,
    new Map([
      ["class", "class"],
      ["trait", "class"],
      ["interface", "class"],
      ["enum", "class"],
    ]),
  )
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== "function") continue
    let nameAt = skipNewlines(tokens, index + 1)
    if (tokens[nameAt]?.text === "&") nameAt++
    if (!isIdent(tokens[nameAt]) || tokens[nameAt].text.startsWith("$")) continue
    const name = tokens[nameAt].text
    const paramsAt = skipNewlines(tokens, nameAt + 1)
    if (tokens[paramsAt]?.text !== "(") continue
    const paramsEnd = findMatching(tokens, paramsAt, "(", ")")
    if (paramsEnd < 0) continue
    const [kind, bodyAt] = nextBodyOrArrow(tokens, paramsEnd + 1, tokens.length)
    if (kind !== "block") continue
    const bodyEnd = findMatching(tokens, bodyAt, "{", "}")
    if (bodyEnd < 0) continue
    const container = innermostContainer(containers, index, "class")
    const symbol = [unit.package, container?.name, name].filter(Boolean).join(".")
    addFunction(unit, {
      symbol,
      name,
      receiver: container?.name ?? "",
      kind: container ? "method" : "function",
      params: parseGenericParams(tokens.slice(paramsAt + 1, paramsEnd), true),
      body: tokens.slice(bodyAt + 1, bodyEnd),
      file: path,
      line: tokens[index].line,
      language,
    })
    index = bodyEnd
  }
  return unit
}

const isCPPNonFunctionKeyword = (name: string) =>
  new Set([
    "alignas",
    "alignof",
    "asm",
    "concept",
    "decltype",
    "defined",
    "explicit",
    "noexcept",
    "requires",
    "sizeof",
    "static_assert",
    "typeid",
    "typeof",
    "__alignof__",
    "__attribute__",
    "__builtin_offsetof",
    "__decltype",
    "__typeof__",
  ]).has(name)

const looksLikeCPPMacroName = (name: string) =>
  /[A-Z]/.test(name) && !/[a-z]/.test(name) && /^[A-Z0-9_]+$/.test(name) && (name.includes("_") || name.startsWith("_"))

const looksLikeCPPDeclaration = (tokens: Token[], nameAt: number, depth: number) => {
  let identifiers = 0
  for (let index = nameAt - 1; index >= 0; index--) {
    if (
      tokens[index].text === ";" ||
      tokens[index].text === "}" ||
      tokens[index].text === "{" ||
      isNewline(tokens[index])
    )
      break
    if (isIdent(tokens[index])) identifiers++
  }
  return identifiers > 0 || depth > 0
}

export const parseCPPUnit = (root: string, path: string, source: string, tokens: Token[]) => {
  const language = Language.CPP
  const unit = newFileUnit(root, path, language, source, tokens)
  const containers = findContainers(
    tokens,
    new Map([
      ["namespace", "namespace"],
      ["class", "class"],
      ["struct", "class"],
    ]),
  )
  const depths = depthBefore(tokens)
  for (let index = 1; index < tokens.length; index++) {
    if (tokens[index].text !== "(") continue
    const nameAt = index - 1
    if (
      !isIdent(tokens[nameAt]) ||
      isControlKeyword(tokens[nameAt].text) ||
      isCPPNonFunctionKeyword(tokens[nameAt].text) ||
      looksLikeCPPMacroName(tokens[nameAt].text)
    )
      continue
    if (nameAt > 0 && [".", "->"].includes(tokens[nameAt - 1].text)) continue
    const container = innermostContainer(containers, index)
    const allowedDepth = container ? depths[container.open] + 1 : 0
    if (depths[index] !== allowedDepth) continue
    const paramsEnd = findMatching(tokens, index, "(", ")")
    if (paramsEnd < 0) continue
    const [kind, bodyAt] = nextBodyOrArrow(tokens, paramsEnd + 1, tokens.length)
    if (kind !== "block") continue
    const bodyEnd = findMatching(tokens, bodyAt, "{", "}")
    if (bodyEnd < 0 || !looksLikeCPPDeclaration(tokens, nameAt, depths[index])) continue
    let name = tokens[nameAt].text
    const qualified = [name]
    for (
      let cursor = nameAt - 1;
      cursor >= 1 && tokens[cursor].text === "::" && isIdent(tokens[cursor - 1]);
      cursor -= 2
    )
      qualified.unshift(tokens[cursor - 1].text)
    const containing = containers.filter((item) => item.open < index && index < item.close)
    const namespaces = containing.filter((item) => item.kind === "namespace").map((item) => item.name)
    let className = containing.filter((item) => item.kind === "class").at(-1)?.name ?? ""
    let prefix = namespaces.length ? namespaces.join(".") : unit.package
    if (qualified.length > 1) {
      className = qualified.slice(0, -1).join(".")
      name = qualified.at(-1) ?? name
    }
    if (className) prefix = [prefix, className].filter(Boolean).join(".")
    addFunction(unit, {
      symbol: [prefix, name].filter(Boolean).join("."),
      name,
      receiver: className,
      kind: className ? "method" : "function",
      params: parseGenericParams(tokens.slice(index + 1, paramsEnd), false),
      body: tokens.slice(bodyAt + 1, bodyEnd),
      file: path,
      line: tokens[nameAt].line,
      language,
    })
    index = bodyEnd
  }
  return unit
}

const sourcePythonLines = (source: string) =>
  source.split("\n").map((text, index): PythonLine => {
    let indent = 0
    for (const char of text) {
      if (char === " ") indent++
      else if (char === "\t") indent += 4
      else break
    }
    return { text, trim: text.trim(), indent, number: index + 1 }
  })

const findBalancedText = (value: string, open: number, left: string, right: string) => {
  if (open < 0 || open >= value.length) return -1
  let depth = 0
  let quote = ""
  let escaped = false
  for (let index = open; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === left) depth++
    if (char === right && --depth === 0) return index
  }
  return -1
}

const pythonResolveModule = (unit: FileUnit, specifier: string) => {
  const dots = specifier.match(/^\.+/)?.[0].length ?? 0
  if (!dots) return normalizeModuleText(specifier)
  let base = unit.package.split(".").slice(0, -1)
  for (let index = 1; index < dots && base.length; index++) base = base.slice(0, -1)
  const tail = normalizeModuleText(specifier.slice(dots))
  return [...base, ...(tail ? tail.split(".") : [])].join(".")
}

export const parsePythonImports = (unit: FileUnit, lines: PythonLine[]) => {
  lines.forEach((line) => {
    const text = line.trim.split("#")[0].trim()
    if (text.startsWith("import ")) {
      text
        .slice("import ".length)
        .split(",")
        .forEach((item) => {
          const words = item.trim().split(/\s+/)
          if (!words[0]) return
          const module = normalizeModuleText(words[0])
          const alias = words.length >= 3 && words[1] === "as" ? words[2] : (module.split(".").at(-1) ?? module)
          unit.imports.set(alias, module)
        })
      return
    }
    if (!text.startsWith("from ")) return
    const parts = text.slice("from ".length).split(" import ")
    if (parts.length !== 2) return
    const module = pythonResolveModule(unit, parts[0].trim())
    parts[1].split(",").forEach((item) => {
      const words = item
        .trim()
        .replace(/^\(|\)$/g, "")
        .split(/\s+/)
      if (!words[0] || words[0] === "*") return
      const alias = words.length >= 3 && words[1] === "as" ? words[2] : words[0]
      unit.staticImports.set(alias, `${module}.${words[0]}`)
    })
  })
}

const pythonBlockTokens = (lines: PythonLine[]) => {
  const language = Language.Python
  const nonblank = lines.flatMap((line) => {
    const trim = line.text.split("#")[0].trim()
    return trim ? [{ ...line, trim }] : []
  })
  if (!nonblank.length) return []
  const emit = (start: number, indent: number): [Token[], number] => {
    const output: Token[] = []
    let index = start
    while (index < nonblank.length) {
      const line = nonblank[index]
      if (line.indent < indent) break
      if (line.indent > indent) {
        index++
        continue
      }
      if (line.trim.startsWith("if ") && line.trim.endsWith(":")) {
        const condition = line.trim.slice(3, -1).trim()
        output.push(
          token(TokenKind.Ident, "if", line.number),
          ...compactTokens(lexLanguage(condition, language)),
          token(TokenKind.Punct, "{", line.number),
          token(TokenKind.Newline, "\n", line.number),
        )
        const childIndent = (nonblank[index + 1]?.indent ?? -1) > indent ? nonblank[index + 1].indent : indent + 4
        const [child, next] = emit(index + 1, childIndent)
        output.push(...child, token(TokenKind.Punct, "}", line.number), token(TokenKind.Newline, "\n", line.number))
        index = next
        if (nonblank[index]?.indent === indent && nonblank[index].trim.startsWith("else:")) {
          const elseLine = nonblank[index]
          output.push(
            token(TokenKind.Ident, "else", elseLine.number),
            token(TokenKind.Punct, "{", elseLine.number),
            token(TokenKind.Newline, "\n", elseLine.number),
          )
          const elseIndent = (nonblank[index + 1]?.indent ?? -1) > indent ? nonblank[index + 1].indent : indent + 4
          const [elseChild, elseNext] = emit(index + 1, elseIndent)
          output.push(
            ...elseChild,
            token(TokenKind.Punct, "}", elseLine.number),
            token(TokenKind.Newline, "\n", elseLine.number),
          )
          index = elseNext
        }
        continue
      }
      output.push(...compactTokens(lexLanguage(line.trim, language)), token(TokenKind.Newline, "\n", line.number))
      index++
    }
    return [output, index]
  }
  return emit(0, nonblank[0].indent)[0]
}

export const parsePythonUnit = (root: string, path: string, source: string, tokens: Token[]) => {
  const language = Language.Python
  const unit = newFileUnit(root, path, language, source, tokens)
  const lines = sourcePythonLines(source)
  parsePythonImports(unit, lines)
  const classes: Array<{ name: string; indent: number }> = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim || line.trim.startsWith("#")) continue
    while (classes.length && line.indent <= classes.at(-1)!.indent) classes.pop()
    const classMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line.trim)
    if (classMatch && line.trim.split("#")[0].endsWith(":")) {
      classes.push({ name: classMatch[1], indent: line.indent })
      continue
    }
    const match = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line.trim)
    if (!match) continue
    const name = match[1]
    const open = line.trim.indexOf("(")
    const close = findBalancedText(line.trim, open, "(", ")")
    if (close < 0) continue
    const params = parseGenericParams(lexLanguage(line.trim.slice(open + 1, close), language), false)
    const colonOffset = line.trim.slice(close + 1).indexOf(":")
    if (colonOffset < 0) continue
    const tail = line.trim.slice(close + 1 + colonOffset + 1).trim()
    let end = index + 1
    while (
      end < lines.length &&
      (!lines[end].trim || lines[end].trim.startsWith("#") || lines[end].indent > line.indent)
    )
      end++
    const bodyLines = tail
      ? [{ text: " ".repeat(line.indent + 4) + tail, trim: tail, indent: line.indent + 4, number: line.number }]
      : lines.slice(index + 1, end)
    const receiver = classes.at(-1)?.name ?? ""
    addFunction(unit, {
      symbol: [unit.package, receiver, name].filter(Boolean).join("."),
      name,
      receiver,
      kind: receiver ? "method" : "function",
      params,
      body: pythonBlockTokens(bodyLines),
      file: path,
      line: line.number,
      language,
    })
    index = end - 1
  }
  return unit
}

const inferShellParams = (tokens: Token[]) => {
  const maximum = tokens.reduce((max, item) => {
    const value = Number(item.text.replace(/^\$/, ""))
    return Number.isInteger(value) && value > max && value <= 32 ? value : max
  }, 0)
  return Array.from({ length: maximum }, (_, index) => `$${index + 1}`)
}

export const parseShellUnit = (root: string, path: string, source: string, tokens: Token[]) => {
  const language = Language.Shell
  const unit = newFileUnit(root, path, language, source, tokens)
  for (let index = 0; index < tokens.length; index++) {
    let name = ""
    let open = -1
    if (tokens[index].text === "function") {
      let cursor = skipNewlines(tokens, index + 1)
      if (isIdent(tokens[cursor])) {
        name = tokens[cursor].text
        cursor = skipNewlines(tokens, cursor + 1)
        if (tokens[cursor]?.text === "(") {
          const end = findMatching(tokens, cursor, "(", ")")
          if (end >= 0) cursor = skipNewlines(tokens, end + 1)
        }
        if (tokens[cursor]?.text === "{") open = cursor
      }
    } else if (isIdent(tokens[index]) && tokens[index + 1]?.text === "(" && tokens[index + 2]?.text === ")") {
      const cursor = skipNewlines(tokens, index + 3)
      if (tokens[cursor]?.text === "{") {
        name = tokens[index].text
        open = cursor
      }
    }
    if (!name || open < 0) continue
    const end = findMatching(tokens, open, "{", "}")
    if (end < 0) continue
    const body = tokens.slice(open + 1, end)
    addFunction(unit, {
      symbol: `${unit.package}.${name}`,
      name,
      receiver: "",
      kind: "function",
      params: inferShellParams(body),
      body,
      file: path,
      line: tokens[index].line,
      language,
    })
    index = end
  }
  return unit
}

const statementEnd = (tokens: Token[], start: number, language: Language) => {
  let paren = 0
  let bracket = 0
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].text === "(") paren++
    if (tokens[index].text === ")" && paren > 0) paren--
    if (tokens[index].text === "[") bracket++
    if (tokens[index].text === "]" && bracket > 0) bracket--
    if (
      !paren &&
      !bracket &&
      (tokens[index].text === ";" ||
        tokens[index].text === "}" ||
        (["go", "python", "typescript", "javascript", "shell", "hcl"].includes(String(language)) &&
          isNewline(tokens[index])))
    )
      return index
  }
  return tokens.length
}

const findHCLAttribute = (body: Token[], name: string) => {
  let depth = 0
  for (let index = 0; index < body.length - 1; index++) {
    if (["{", "[", "("].includes(body[index].text)) depth++
    if (["}", "]", ")"].includes(body[index].text) && depth > 0) depth--
    if (depth || body[index].text !== name) continue
    const equals = skipNewlines(body, index + 1)
    if (body[equals]?.text === "=") return body.slice(equals + 1, statementEnd(body, equals + 1, Language.HCL))
  }
  return []
}

const parseHCLLocals = (unit: FileUnit, body: Token[]) => {
  const language = Language.HCL
  let depth = 0
  for (let index = 0; index < body.length - 1; index++) {
    if (["{", "[", "("].includes(body[index].text)) depth++
    if (["}", "]", ")"].includes(body[index].text) && depth > 0) depth--
    if (depth || !isIdent(body[index])) continue
    const equals = skipNewlines(body, index + 1)
    if (body[equals]?.text !== "=") continue
    const end = statementEnd(body, equals + 1, language)
    const name = body[index].text
    addFunction(unit, {
      symbol: `${unit.package}.local.${name}`,
      name,
      receiver: "local",
      kind: "local",
      params: [],
      body: syntheticReturn(body.slice(equals + 1, end), language),
      file: unit.path,
      line: body[index].line,
      language,
    })
    index = end
  }
}

export const parseHCLUnit = (root: string, path: string, source: string, tokens: Token[]) => {
  const language = Language.HCL
  const unit = newFileUnit(root, path, language, source, tokens)
  const depths = depthBefore(tokens)
  const blockKinds = new Set(["variable", "output", "module", "resource", "data", "provider", "terraform"])
  for (let index = 0; index < tokens.length; index++) {
    if (depths[index] !== 0 || !isIdent(tokens[index])) continue
    const kind = tokens[index].text
    if (kind === "locals") {
      const open = skipNewlines(tokens, index + 1)
      if (tokens[open]?.text !== "{") continue
      const end = findMatching(tokens, open, "{", "}")
      if (end < 0) continue
      parseHCLLocals(unit, tokens.slice(open + 1, end))
      index = end
      continue
    }
    if (!blockKinds.has(kind)) continue
    let open = skipNewlines(tokens, index + 1)
    const labels: string[] = []
    while (open < tokens.length && tokens[open].text !== "{" && !isEOF(tokens[open])) {
      if (isString(tokens[open]) || isIdent(tokens[open])) labels.push(cleanModuleSegment(tokens[open].text))
      open++
    }
    if (tokens[open]?.text !== "{") continue
    const end = findMatching(tokens, open, "{", "}")
    if (end < 0) continue
    let body = tokens.slice(open + 1, end)
    const primary = kind === "variable" ? "default" : kind === "output" ? "value" : ""
    const expression = primary ? findHCLAttribute(body, primary) : []
    if (expression.length) body = syntheticReturn(expression, language)
    addFunction(unit, {
      symbol: [unit.package, kind, ...labels].join("."),
      name: labels.join("."),
      receiver: kind,
      kind,
      params: [],
      body,
      file: path,
      line: tokens[index].line,
      language,
    })
    index = end
  }
  return unit
}

export const parseUnit = (
  root: string,
  path: string,
  language: Language,
  source: string,
  tokens: Token[],
): FileUnit => {
  if (language === "typescript" || language === "javascript")
    return parseECMAScriptUnit(root, path, language, source, tokens)
  if (language === "python") return parsePythonUnit(root, path, source, tokens)
  if (language === "csharp") return parseCSharpUnit(root, path, source, tokens)
  if (language === "php") return parsePHPUnit(root, path, source, tokens)
  if (language === "cpp") return parseCPPUnit(root, path, source, tokens)
  if (language === "shell") return parseShellUnit(root, path, source, tokens)
  if (language === "hcl") return parseHCLUnit(root, path, source, tokens)
  throw new Error(`unsupported language ${JSON.stringify(language)}`)
}

export const parserForLanguage = parseUnit
