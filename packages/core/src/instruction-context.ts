export * as InstructionContext from "./instruction-context"

import { Effect, Layer, Schema } from "effect"
import { basename, isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service

    const read = (path: string) =>
      fs
        .readFileStringSafe(path)
        .pipe(
          Effect.map((content) =>
            content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
          ),
        )

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const claudeInstructions = !Flag.FORGE_DISABLE_CLAUDE_CODE_PROMPT
      const candidatePaths =
        Flag.FORGE_DISABLE_PROJECT_CONFIG || !isWithin(stop, start)
          ? []
          : yield* fs.up({
              targets: ["AGENTS.md", ...(claudeInstructions ? ["CLAUDE.md"] : [])],
              start,
              stop,
            })
      const candidates = yield* Effect.forEach(candidatePaths, (path) =>
        fs.resolve(path).pipe(Effect.map((resolved) => ({ name: basename(path), path: resolved }))),
      )
      const eligible = candidates.filter((candidate) => isWithin(stop, candidate.path))
      const agents = eligible.filter((candidate) => candidate.name === "AGENTS.md")
      const discovered = new Set((agents.length > 0 ? agents : eligible).map((candidate) => candidate.path))
      const globalAgent = yield* fs.resolve(join(global.config, "AGENTS.md")).pipe(Effect.flatMap(read))
      const globalFile =
        globalAgent ??
        (claudeInstructions
          ? yield* fs.resolve(join(global.home, ".claude", "CLAUDE.md")).pipe(Effect.flatMap(read))
          : undefined)
      const paths = [...discovered].filter((path) => path !== globalFile?.path)
      const files = yield* Effect.forEach(paths, read, { concurrency: "unbounded" })
      if (files.some((file) => file === undefined)) return SystemContext.unavailable
      return [globalFile, ...files].filter((file): file is File => file !== undefined)
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node, SystemContextRegistry.node],
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

function isWithin(root: string, target: string) {
  const fromRoot = relative(root, target)
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}
