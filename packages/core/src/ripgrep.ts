export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@turenlabs/schema/filesystem"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"
import { Protected } from "./filesystem/protected"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface LinesInput {
  readonly cwd: string
  readonly files: readonly string[]
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly lines: (input: LinesInput) => Effect.Effect<ReadonlyMap<string, number>, Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

// Windows caps a whole command line at 32767 characters and POSIX caps argv plus
// the environment; a few hundred long paths reach either. Split explicit path
// lists into batches that stay well inside both, keeping a single overlong path
// in a batch of its own rather than dropping it.
const ARGV_BUDGET_BYTES = process.platform === "win32" ? 30_000 : 120_000

const argvBatches = (files: readonly string[]) => {
  const batches: string[][] = []
  let batch: string[] = []
  let bytes = 0
  for (const file of files) {
    const cost = Buffer.byteLength(file, "utf8") + 1
    if (batch.length > 0 && bytes + cost > ARGV_BUDGET_BYTES) {
      batches.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(file)
    bytes += cost
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated) return { items: rows.slice(0, input.limit), truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: code === 1 ? [] : rows, truncated: false, partial: code === 2 }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ...Protected.under(input.cwd).map((relative) => `--glob=!${relative}/**`),
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      lines: (input) =>
        Effect.forEach(
          argvBatches(input.files),
          (files) =>
            run<readonly [string, number]>({
              cwd: input.cwd,
              limit: files.length,
              signal: input.signal,
              // `^` matches once per line, so a per-file match count is its line count.
              // Explicit paths keep the cost proportional to the requested files rather
              // than the tree; ripgrep always searches a path it was handed, so binary
              // files report the lines found before NUL detection stopped the scan.
              args: ["--no-config", "--count", "--include-zero", "--no-messages", "--", "^", ...files],
              parse: (line) => {
                const separator = line.lastIndexOf(":")
                const count = separator < 0 ? Number.NaN : Number(line.slice(separator + 1))
                if (!Number.isSafeInteger(count) || count < 0) return Effect.succeed(undefined)
                return Effect.succeed([line.slice(0, separator), count] as const)
              },
            }).pipe(Effect.map((result) => result.items)),
          { concurrency: 4 },
        ).pipe(
          Effect.map((batches) => new Map(batches.flat())),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ...Protected.under(input.cwd).map((relative) => `--glob=!${relative}/**`),
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      grep: (input) =>
        run<RawMatchData>({
          ...input,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            ...Protected.under(input.cwd).map((relative) => `--glob=!${relative}/**`),
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
              ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
              : Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                })
            ).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((match) => {
              const relative = match.path.text
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/")
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(relative),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text: match.lines.text.length > 2_000 ? match.lines.text.slice(0, 2_000) + "..." : match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              })
            }),
          ),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
