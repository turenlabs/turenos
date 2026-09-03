import path from "path"
import { Effect, Schema } from "effect"
import { fileURLToPath, pathToFileURL } from "url"
import { LSP } from "@/lsp/lsp"
import { InstanceState } from "@/effect/instance-state"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { FSUtil } from "@turenlabs/core/fs-util"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import WORKSPACE_SYMBOL_DESCRIPTION from "./lsp-workspace-symbol.txt"
import REFERENCES_DESCRIPTION from "./lsp-references.txt"
import INCOMING_CALLS_DESCRIPTION from "./lsp-incoming-calls.txt"
import DEFINITION_DESCRIPTION from "./lsp-definition.txt"

/**
 * Name-addressed wrappers over the LSP client in `@/lsp/lsp`.
 *
 * The whole point of this module is that the model never computes a character
 * offset. It names a symbol; we resolve the name to a position and issue the
 * position-based LSP request on its behalf.
 *
 * Resolution deliberately goes through `workspace/symbol` and NOT
 * `textDocument/documentSymbol`. Measured against gopls v0.23.0 on a real Go
 * tree, `workspace/symbol` returns `location.range` spanning exactly the
 * identifier (`OpenRepository` -> line 36, chars 5..19), while
 * `documentSymbol` — which gopls answers with flat `SymbolInformation` because
 * we do not advertise hierarchical support — returns the range of the entire
 * declaration (line 36 char 0 .. line 54 char 1). Feeding that back in makes
 * gopls reply "no identifier found" / "identifier not found", which the LSP
 * client swallows into an empty array. That failure is silent and looks
 * exactly like a correct "no references" answer, so it must not be possible.
 */

/** Symbols we ask for but that are still worth naming in output. */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "func",
  13: "var",
  14: "const",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type parameter",
}

/** Rows of `path:line:col` we are willing to spend tokens on in one result. */
const MAX_ROWS = 200
/** Alternate same-named symbols listed so the model can disambiguate. */
const MAX_ALTERNATES = 8
/** Files sampled when guessing which language server a project needs. */
const BOOTSTRAP_SCAN_LIMIT = 500
/** Distinct file extensions probed before giving up on an automatic start. */
const BOOTSTRAP_EXTENSION_LIMIT = 8
/** Identifier occurrences tried when resolving a usage site to a definition. */
const MAX_USAGE_PROBES = 5

interface RawPosition {
  line: number
  character: number
}

interface RawRange {
  start: RawPosition
  end: RawPosition
}

interface RawLocation {
  uri: string
  range: RawRange
}

interface RawSymbol {
  name: string
  kind: number
  containerName?: string
  location: RawLocation
}

interface Resolved {
  file: string
  line: number
  character: number
  name: string
  kind: number
  container?: string
  alternates: RawSymbol[]
}

interface SymbolMetadata {
  count: number
  file?: string
}

/** Uniform result shape, so every branch of a tool infers the same metadata. */
function result(title: string, metadata: SymbolMetadata, lines: string[]): Tool.ExecuteResult<SymbolMetadata> {
  return { title, metadata, output: lines.join("\n") }
}

/**
 * Last dot-separated segment of an LSP symbol name.
 *
 * Servers disagree on qualification for the same symbol: gopls reports
 * `Repository.GetBranchNames` from `workspace/symbol` and
 * `(*Repository).GetBranchNames` from `documentSymbol`. Comparing tails lets a
 * model say `GetBranchNames` and still match either.
 */
function baseName(name: string) {
  const index = name.lastIndexOf(".")
  return index === -1 ? name : name.slice(index + 1)
}

function kindName(kind: number) {
  return SYMBOL_KIND_NAMES[kind] ?? `kind ${kind}`
}

function isLocation(value: unknown): value is RawLocation {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<RawLocation> & { targetUri?: string; targetSelectionRange?: RawRange }
  if (typeof candidate.uri === "string" && candidate.range) return true
  return false
}

/**
 * `textDocument/definition` may answer with `Location`, `Location[]`, or
 * `LocationLink[]`. Normalize all three rather than assuming one shape.
 */
function toLocation(value: unknown): RawLocation | undefined {
  if (isLocation(value)) return value
  if (typeof value !== "object" || value === null) return undefined
  const link = value as { targetUri?: string; targetSelectionRange?: RawRange; targetRange?: RawRange }
  const range = link.targetSelectionRange ?? link.targetRange
  if (typeof link.targetUri === "string" && range) return { uri: link.targetUri, range }
  return undefined
}

function localPath(uri: string) {
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

/**
 * Shortest project-relative form of `file`, or the absolute path if it lies
 * outside every root.
 *
 * Both roots are tried because a non-git project sets `worktree` to "/" (see
 * `containsPath` in project/instance-context), and `path.relative("/", file)`
 * yields an absolute path with its leading slash stripped — which is not just
 * ugly, it is a path that does not resolve.
 */
function relativeTo(roots: readonly string[], file: string) {
  let best: string | undefined
  for (const root of roots) {
    if (!root || root === "/") continue
    const relative = path.relative(root, file)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue
    if (best === undefined || relative.length < best.length) best = relative
  }
  return best ?? file
}

/** `path:line:col`, 1-based — the form editors and grep output use. */
function describe(roots: readonly string[], file: string, position: RawPosition) {
  return `${relativeTo(roots, file)}:${position.line + 1}:${position.character + 1}`
}

function locationRow(roots: readonly string[], location: RawLocation) {
  const file = localPath(location.uri)
  if (!file) return undefined
  return describe(roots, file, location.range.start)
}

function truncate<T>(rows: T[], limit = MAX_ROWS) {
  if (rows.length <= limit) return { rows, note: undefined }
  return {
    rows: rows.slice(0, limit),
    note: `(showing first ${limit} of ${rows.length}; narrow the query with the path parameter)`,
  }
}

/** Whole-word occurrences of `name` in `line`, as character offsets. */
function identifierColumns(line: string, name: string) {
  const columns: number[] = []
  let from = 0
  for (;;) {
    const index = line.indexOf(name, from)
    if (index === -1) return columns
    const before = index === 0 ? "" : line[index - 1]!
    const after = line[index + name.length] ?? ""
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) columns.push(index)
    from = index + name.length
  }
}

export const SymbolParameters = Schema.Struct({
  symbol: Schema.String.annotate({
    description:
      "The symbol name, exactly as written in the source. Bare names work ('OpenRepository'); qualify with the receiver or class when the name is common ('Repository.IsEmpty').",
  }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "Optional file path used to disambiguate when several symbols share the name. Omit it unless a previous call reported alternates.",
  }),
})

export const WorkspaceSymbolParameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "The symbol name to look for. Matching is fuzzy, so an exact name gives the best results.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "Optional file in the project whose language should be searched. Only needed in a repository with several languages.",
  }),
})

export const DefinitionParameters = Schema.Struct({
  symbol: Schema.String.annotate({
    description: "The symbol name, exactly as spelled at the usage site in `path`.",
  }),
  path: Schema.String.annotate({
    description:
      "The file where you saw the symbol used. Required: this is what lets the server resolve the specific symbol that file's imports, aliases and receivers actually bind to — the thing plain search cannot answer. Looking for a declaration by name with no usage site in mind is workspace_symbol's job, not this tool's.",
  }),
})

/**
 * Shared machinery for the four tools: automatic (lazy) server start, and
 * name -> position resolution.
 */
const make = Effect.gen(function* () {
  const lsp = yield* LSP.Service
  const ripgrep = yield* Ripgrep.Service
  const fs = yield* FSUtil.Service

  const resolvePath = Effect.fnUntraced(function* (input: string) {
    const instance = yield* InstanceState.context
    return path.isAbsolute(input) ? input : path.join(instance.directory, input)
  })

  /**
   * Start a language server for this project if none is running yet.
   *
   * Nothing about this is user-visible: no prompt, no setting, no progress UI.
   * With an explicit file we let the LSP service pick the server for that
   * file's language. Without one we sample the tree, rank extensions by how
   * common they are, and open the first file whose language has a server
   * configured — which generalises to every server in the registry instead of
   * hardcoding a language table.
   */
  const ensureStarted = Effect.fnUntraced(function* (hint?: string) {
    if (hint) {
      yield* lsp.touchFile(hint)
      return
    }
    const running = yield* lsp.status()
    if (running.length > 0) return

    const instance = yield* InstanceState.context
    const entries = yield* ripgrep
      .glob({ cwd: instance.directory, pattern: "**/*", limit: BOOTSTRAP_SCAN_LIMIT })
      .pipe(Effect.orElseSucceed(() => [] as readonly { path: string }[]))

    const counts = new Map<string, number>()
    const sample = new Map<string, string>()
    for (const entry of entries) {
      const extension = path.extname(entry.path)
      if (!extension) continue
      counts.set(extension, (counts.get(extension) ?? 0) + 1)
      if (!sample.has(extension)) sample.set(extension, entry.path)
    }

    const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, BOOTSTRAP_EXTENSION_LIMIT)

    for (const [extension] of ranked) {
      const candidate = path.resolve(instance.directory, sample.get(extension)!)
      if (!(yield* lsp.hasClients(candidate))) continue
      yield* lsp.touchFile(candidate)
      return
    }
  })

  const query = Effect.fnUntraced(function* (name: string) {
    return (yield* lsp.workspaceSymbol(name)) as unknown as RawSymbol[]
  })

  /**
   * Confirm the reported column really lands on the identifier, and repair it
   * from the source line if it does not.
   *
   * gopls gets this right, but the LSP spec lets a server return the whole
   * declaration range here, and a position that is one character off makes the
   * follow-up request fail *silently* as an empty result. Reading one line is
   * cheap insurance against a wrong-looking-but-plausible answer.
   */
  const verifyColumn = Effect.fnUntraced(function* (file: string, position: RawPosition, name: string) {
    const text = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    if (!text) return position
    const line = text.split(/\r\n|\r|\n/)[position.line]
    if (line === undefined) return position
    const wanted = baseName(name)
    if (line.slice(position.character, position.character + wanted.length) === wanted) return position
    const columns = identifierColumns(line, wanted)
    if (!columns.length) return position
    return { line: position.line, character: columns[0]! }
  })

  const resolve = Effect.fnUntraced(function* (symbol: string, hint?: string) {
    yield* ensureStarted(hint)
    const symbols = yield* query(symbol)

    const wanted = baseName(symbol)
    const scoped = hint ? symbols.filter((entry) => localPath(entry.location.uri) === hint) : symbols
    const pool = scoped.length ? scoped : symbols

    const exact = pool.filter((entry) => entry.name === symbol)
    const tail = pool.filter((entry) => baseName(entry.name) === wanted)
    const matches = exact.length ? exact : tail

    if (!matches.length) {
      return { matches: [] as RawSymbol[], near: pool, resolved: undefined as Resolved | undefined }
    }

    const primary = matches[0]!
    const file = localPath(primary.location.uri)
    if (!file) return { matches, near: pool, resolved: undefined as Resolved | undefined }

    const position = yield* verifyColumn(file, primary.location.range.start, primary.name)
    return {
      matches,
      near: pool,
      resolved: {
        file,
        line: position.line,
        character: position.character,
        name: primary.name,
        kind: primary.kind,
        container: primary.containerName,
        alternates: matches.slice(1),
      } satisfies Resolved,
    }
  })

  /** Ask permission once, under the existing `lsp` key. No new permission surface. */
  const authorize = Effect.fnUntraced(function* (
    ctx: Tool.Context,
    operation: string,
    detail: Record<string, unknown>,
  ) {
    yield* ctx.ask({
      permission: "lsp",
      patterns: ["*"],
      always: ["*"],
      metadata: { operation, ...detail },
    })
  })

  const alternateLines = (roots: readonly string[], alternates: RawSymbol[]) => {
    if (!alternates.length) return []
    const shown = alternates.slice(0, MAX_ALTERNATES)
    return [
      "",
      `${alternates.length} other symbol${alternates.length === 1 ? "" : "s"} share this name; pass \`path\` to pick one:`,
      ...shown.map((entry) => {
        const file = localPath(entry.location.uri)
        const where = file ? describe(roots, file, entry.location.range.start) : entry.location.uri
        return `  ${entry.name} (${kindName(entry.kind)}) ${where}`
      }),
    ]
  }

  const notFound = (roots: readonly string[], symbol: string, near: RawSymbol[]) => {
    const lines = [`No symbol named "${symbol}" found by the language server.`]
    if (near.length) {
      lines.push("", "Closest names it did return:")
      for (const entry of near.slice(0, MAX_ALTERNATES)) {
        const file = localPath(entry.location.uri)
        const where = file ? describe(roots, file, entry.location.range.start) : entry.location.uri
        lines.push(`  ${entry.name} (${kindName(entry.kind)}) ${where}`)
      }
    } else {
      lines.push("", "The language server may not cover this project's language. Use grep instead.")
    }
    return lines.join("\n")
  }

  return { lsp, fs, resolve, ensureStarted, query, resolvePath, authorize, alternateLines, notFound }
})

export const WorkspaceSymbolTool = Tool.define(
  "workspace_symbol",
  Effect.gen(function* () {
    const shared = yield* make
    return {
      description: WORKSPACE_SYMBOL_DESCRIPTION,
      parameters: WorkspaceSymbolParameters,
      execute: (args: Schema.Schema.Type<typeof WorkspaceSymbolParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const roots = [instance.directory, instance.worktree]
          yield* shared.authorize(ctx, "workspace_symbol", { name: args.name })

          let hint: string | undefined
          if (args.path) {
            hint = yield* shared.resolvePath(args.path)
            yield* assertExternalDirectoryEffect(ctx, hint)
          }

          yield* shared.ensureStarted(hint)
          const symbols = yield* shared.query(args.name)
          if (!symbols.length) {
            return result(`workspace_symbol ${args.name}`, { count: 0 }, [shared.notFound(roots, args.name, [])])
          }

          const { rows, note } = truncate(
            symbols.map((entry) => {
              const file = localPath(entry.location.uri)
              const where = file ? describe(roots, file, entry.location.range.start) : entry.location.uri
              const container = entry.containerName ? `  (${entry.containerName})` : ""
              return `${kindName(entry.kind)} ${entry.name}  ${where}${container}`
            }),
          )

          return result(`workspace_symbol ${args.name}`, { count: symbols.length }, [
            `${symbols.length} symbol${symbols.length === 1 ? "" : "s"} matching "${args.name}"`,
            ...rows,
            ...(note ? [note] : []),
          ])
        }).pipe(Effect.orDie),
    }
  }),
)

export const ReferencesTool = Tool.define(
  "references",
  Effect.gen(function* () {
    const shared = yield* make
    return {
      description: REFERENCES_DESCRIPTION,
      parameters: SymbolParameters,
      execute: (args: Schema.Schema.Type<typeof SymbolParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const roots = [instance.directory, instance.worktree]
          yield* shared.authorize(ctx, "references", { symbol: args.symbol, path: args.path })

          let hint: string | undefined
          if (args.path) {
            hint = yield* shared.resolvePath(args.path)
            yield* assertExternalDirectoryEffect(ctx, hint)
          }

          const { resolved, near } = yield* shared.resolve(args.symbol, hint)
          if (!resolved) {
            return result(`references ${args.symbol}`, { count: 0 }, [shared.notFound(roots, args.symbol, near)])
          }

          const declared = describe(roots, resolved.file, {
            line: resolved.line,
            character: resolved.character,
          })
          const raw = (yield* shared.lsp.references({
            file: resolved.file,
            line: resolved.line,
            character: resolved.character,
          })) as unknown[]

          const rowsAll = raw
            .map((entry) => toLocation(entry))
            .filter((entry): entry is RawLocation => Boolean(entry))
            .map((entry) => locationRow(roots, entry))
            .filter((entry): entry is string => Boolean(entry))
          const { rows, note } = truncate(rowsAll)

          const header = rowsAll.length
            ? `${rowsAll.length} reference${rowsAll.length === 1 ? "" : "s"} to ${resolved.name} (declared ${declared})`
            : `No references to ${resolved.name} (declared ${declared})`

          return result(`references ${resolved.name}`, { count: rowsAll.length, file: resolved.file }, [
            header,
            ...rows,
            ...(note ? [note] : []),
            ...shared.alternateLines(roots, resolved.alternates),
          ])
        }).pipe(Effect.orDie),
    }
  }),
)

export const IncomingCallsTool = Tool.define(
  "incoming_calls",
  Effect.gen(function* () {
    const shared = yield* make
    return {
      description: INCOMING_CALLS_DESCRIPTION,
      parameters: SymbolParameters,
      execute: (args: Schema.Schema.Type<typeof SymbolParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const roots = [instance.directory, instance.worktree]
          yield* shared.authorize(ctx, "incoming_calls", { symbol: args.symbol, path: args.path })

          let hint: string | undefined
          if (args.path) {
            hint = yield* shared.resolvePath(args.path)
            yield* assertExternalDirectoryEffect(ctx, hint)
          }

          const { resolved, near } = yield* shared.resolve(args.symbol, hint)
          if (!resolved) {
            return result(`incoming_calls ${args.symbol}`, { count: 0 }, [shared.notFound(roots, args.symbol, near)])
          }

          const declared = describe(roots, resolved.file, {
            line: resolved.line,
            character: resolved.character,
          })
          const calls = (yield* shared.lsp.incomingCalls({
            file: resolved.file,
            line: resolved.line,
            character: resolved.character,
          })) as {
            from?: { name?: string; kind?: number; uri?: string; selectionRange?: RawRange; range?: RawRange }
            fromRanges?: RawRange[]
          }[]

          // A call hierarchy only exists for functions and methods. gopls
          // rejects anything else outright ("Renderer is not a function"), and
          // the LSP client turns that rejection into an empty array — so say
          // what happened instead of implying the symbol has no callers.
          if (!calls.length) {
            const callable = resolved.kind === 12 || resolved.kind === 6 || resolved.kind === 9
            return result(`incoming_calls ${resolved.name}`, { count: 0, file: resolved.file }, [
              callable
                ? `No callers of ${resolved.name} (declared ${declared}). It may be an entry point, or only reached through a function value the compiler cannot trace.`
                : `${resolved.name} is a ${kindName(resolved.kind)}, not a function or method, so it has no call hierarchy. Use references to find where it is used.`,
              ...shared.alternateLines(roots, resolved.alternates),
            ])
          }

          const rowsAll = calls.map((call) => {
            const from = call.from ?? {}
            const file = from.uri ? localPath(from.uri) : undefined
            const start = (from.selectionRange ?? from.range)?.start
            const where = file && start ? describe(roots, file, start) : (from.uri ?? "unknown")
            const sites = (call.fromRanges ?? []).map((range) => range.start.line + 1)
            const at = sites.length ? `  calls at ${sites.join(", ")}` : ""
            return `${from.name ?? "?"}  ${where}${at}`
          })
          const { rows, note } = truncate(rowsAll)

          return result(`incoming_calls ${resolved.name}`, { count: rowsAll.length, file: resolved.file }, [
            `${rowsAll.length} caller${rowsAll.length === 1 ? "" : "s"} of ${resolved.name} (declared ${declared})`,
            ...rows,
            ...(note ? [note] : []),
            ...shared.alternateLines(roots, resolved.alternates),
          ])
        }).pipe(Effect.orDie),
    }
  }),
)

export const DefinitionTool = Tool.define(
  "definition",
  Effect.gen(function* () {
    const shared = yield* make
    return {
      description: DEFINITION_DESCRIPTION,
      parameters: DefinitionParameters,
      execute: (args: Schema.Schema.Type<typeof DefinitionParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const roots = [instance.directory, instance.worktree]
          yield* shared.authorize(ctx, "definition", { symbol: args.symbol, path: args.path })

          const wanted = baseName(args.symbol)

          const file = yield* shared.resolvePath(args.path)
          yield* assertExternalDirectoryEffect(ctx, file)
          const exists = yield* shared.fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${file}`)

          yield* shared.ensureStarted(file)
          const text = yield* shared.fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
          const lines = text?.split(/\r\n|\r|\n/) ?? []

          // Walk the usage sites in the file until the server binds one.
          // Occurrences inside comments and strings resolve to nothing, so
          // trying only the first would report a spurious miss.
          const probes: RawPosition[] = []
          for (let line = 0; line < lines.length && probes.length < MAX_USAGE_PROBES; line++) {
            for (const character of identifierColumns(lines[line]!, wanted)) {
              probes.push({ line, character })
              if (probes.length >= MAX_USAGE_PROBES) break
            }
          }

          for (const probe of probes) {
            const raw = (yield* shared.lsp.definition({
              file,
              line: probe.line,
              character: probe.character,
            })) as unknown[]
            const locations = raw
              .map((entry) => toLocation(entry))
              .filter((entry): entry is RawLocation => Boolean(entry))
            if (!locations.length) continue
            const rows = locations
              .map((entry) => locationRow(roots, entry))
              .filter((entry): entry is string => Boolean(entry))
            return result(`definition ${args.symbol}`, { count: rows.length, file }, [
              `${args.symbol} as used in ${relativeTo(roots, file)}:${probe.line + 1} is defined at:`,
              ...rows,
            ])
          }

          if (probes.length) {
            return result(`definition ${args.symbol}`, { count: 0, file }, [
              `The language server could not bind "${args.symbol}" at any of its ${probes.length} occurrence(s) in ${relativeTo(roots, file)}. It may only appear in comments or strings.`,
            ])
          }

          return result(`definition ${args.symbol}`, { count: 0, file }, [
            `"${args.symbol}" does not appear as an identifier in ${relativeTo(roots, file)}. Check the spelling, or pass the file where you actually saw it used.`,
          ])
        }).pipe(Effect.orDie),
    }
  }),
)

export const __test = { baseName, identifierColumns, toLocation, describe, truncate, relativeTo }
