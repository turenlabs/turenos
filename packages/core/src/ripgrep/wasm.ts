export * as RipgrepWasm from "./wasm"

import { Context, Effect, Layer } from "effect"
import fs from "node:fs"
import { Entry, Match } from "@turenlabs/schema/filesystem"
import { makeGlobalNode } from "../effect/app-node"
import { RelativePath } from "../schema"
import { Protected } from "../filesystem/protected"
import type { FindInput, GlobInput, Interface } from "../ripgrep"
import { Error as RipgrepError, InvalidPatternError } from "../ripgrep"
import { instantiate, nodeFs } from "./wasm/host"
import { startPool, WASM_FLAGS, type Pool } from "./wasm/runtime"

// WASM ripgrep backend: actual libripgrep crates (ignore/grep-regex/
// grep-searcher/globset) compiled to wasm32, driving a node:fs host ABI and a
// worker_threads pool. Drop-in for the spawned-rg implementation — selected
// when the wasm asset resolves and FORGE_RIPGREP_WASM is not "0".

const failure = (message: string, cause?: unknown) => new RipgrepError({ message, cause })

const abortError = (signal: AbortSignal) => {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason
  if (reason instanceof Error) return reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export interface WasmService {
  readonly enabled: boolean
  readonly iface: Interface
}

export class Service extends Context.Service<Service, WasmService>()("@forge/v2/RipgrepWasm") {}

const relativize = (root: string, p: string) =>
  (p.startsWith(root + "/") ? p.slice(root.length + 1) : p)
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/")

// Native spawns rg with cwd=input.cwd — a missing cwd fails the spawn, so the
// wasm path must fail too rather than return empty results.
const checkCwd = (cwd: string) => {
  try {
    if (fs.statSync(cwd).isDirectory()) return undefined
    return failure(`ripgrep cwd is not a directory: ${cwd}`)
  } catch (cause) {
    return failure(`ripgrep cwd does not exist: ${cwd}`, cause)
  }
}

const makeInterface = (pool: Pool): Interface => {
  const runCollect = (input: FindInput | GlobInput, pattern: string | undefined) => {
    const cwdError = checkCwd(input.cwd)
    if (cwdError) return Effect.fail(cwdError)
    const globs = [
      ...(pattern ? [pattern] : []),
      "!**/.git/**",
      ...Protected.under(input.cwd).map((relative) => `!${relative}/**`),
    ]
    const flags =
      (input.hidden ? WASM_FLAGS.hidden : 0) | (input.follow ? WASM_FLAGS.follow : 0)
    return Effect.tryPromise({
      try: () => pool.collect(input.cwd, globs, flags, input.limit, input.signal),
      catch: (cause) => failure("ripgrep wasm collect failed", cause),
    }).pipe(
      Effect.flatMap((result) => {
        if (result.cancelled && input.signal) return Effect.fail(failure("aborted", abortError(input.signal)))
        const entries = result.paths.slice(0, input.limit).map((p) =>
          Entry.make({
            path: RelativePath.make(relativize(input.cwd.replaceAll("\\", "/"), p)),
            type: "file",
          }),
        )
        return Effect.succeed(entries)
      }),
    )
  }

  return {
    find: (input) =>
      runCollect(input, input.pattern === "*" ? undefined : input.pattern).pipe(
        Effect.tap((entries) =>
          input.onEntry ? Effect.forEach(entries, input.onEntry, { discard: true }) : Effect.void,
        ),
      ),
    glob: (input) => runCollect(input, input.pattern),
    lines: (input) => {
      const cwdError = checkCwd(input.cwd)
      if (cwdError) return Effect.fail(cwdError)
      return Effect.tryPromise({
        try: () =>
          pool.lineCount(
            input.files.map((f) => (f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f) ? f : `${input.cwd}/${f}`)),
            input.signal,
          ),
        catch: (cause) => failure("ripgrep wasm line count failed", cause),
      }).pipe(
        Effect.flatMap((result) => {
          if (result.cancelled && input.signal) return Effect.fail(failure("aborted", abortError(input.signal)))
          // Re-key absolute paths back to the caller's original strings.
          const byAbs = new Map(result.counts)
          const out = new Map<string, number>()
          for (const f of input.files) {
            const abs = f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f) ? f : `${input.cwd}/${f}`
            const count = byAbs.get(abs.replaceAll("\\", "/"))
            // rg --include-zero emits no row for unreadable/missing files.
            if (count !== undefined) out.set(f, count)
          }
          return Effect.succeed(out)
        }),
      )
    },
    grep: (input) => {
      const cwdError = checkCwd(input.cwd)
      if (cwdError) return Effect.fail(cwdError)
      const root = input.file
        ? input.file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input.file)
          ? input.file
          : `${input.cwd}/${input.file}`
        : input.cwd
      const globs = [
        ...(input.include ? [input.include] : []),
        "!**/.git/**",
        ...Protected.under(input.cwd).map((relative) => `!${relative}/**`),
      ]
      return Effect.tryPromise({
        try: () => pool.grep(input.pattern, root, globs, WASM_FLAGS.hidden, input.limit, input.signal),
        catch: (cause) => failure("ripgrep wasm grep failed", cause),
      }).pipe(
        Effect.flatMap(
          (result): Effect.Effect<readonly Match[], RipgrepError | InvalidPatternError> => {
          if (result.invalidPattern !== undefined) {
            return Effect.fail(
              new InvalidPatternError({ pattern: input.pattern, message: result.invalidPattern }),
            )
          }
          if (result.cancelled && input.signal) {
            return Effect.fail(failure("aborted", abortError(input.signal)))
          }
          const base = input.cwd.replaceAll("\\", "/")
          return Effect.succeed(
            result.matches.slice(0, input.limit).map((match) =>
              Match.make({
                entry: Entry.make({
                  path: RelativePath.make(relativize(base, match.path)),
                  type: "file",
                }),
                line: match.line,
                offset: match.offset,
                text: match.text.length > 2_000 ? match.text.slice(0, 2_000) + "..." : match.text,
                submatches: match.submatches,
              }),
            ),
          )
          },
        ),
      )
    },
  }
}

const disabled = Service.of({ enabled: false, iface: undefined as unknown as Interface })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Instantiate once here so a corrupt/malformed asset disables the backend
    // and the caller falls back to the spawned rg instead of failing per-request.
    const ready = yield* Effect.tryPromise({
      try: () => instantiate(nodeFs),
      catch: (cause) => failure("ripgrep wasm module failed to instantiate", cause),
    })
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => startPool(undefined, ready)),
      (p) => Effect.promise(() => p.stop()),
    )
    // Warm worker wasm tiers in the background so the first real query isn't
    // interpreted-mode slow.
    yield* Effect.forkDetach(
      Effect.promise(() => pool.warm([], WASM_FLAGS.hidden)).pipe(Effect.ignore),
    )
    return Service.of({ enabled: true, iface: makeInterface(pool) })
  }).pipe(Effect.catch(() => Effect.succeed(disabled))),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
