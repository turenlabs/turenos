import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { FSUtil } from "@turenlabs/core/fs-util"
import { Global } from "@turenlabs/core/global"
import { InstructionContext } from "@turenlabs/core/instruction-context"
import { Location } from "@turenlabs/core/location"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SystemContext } from "@turenlabs/core/system-context"
import { SystemContextRegistry } from "@turenlabs/core/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
}) =>
  AppNodeBuilder.build(LayerNode.group([SystemContextRegistry.node, InstructionContext.node]), [
    [Global.node, Global.layerWith({ config: input.config, home: input.config })],
    [Location.node, input.locationServiceLayer],
    ...(input.filesystemLayer ? [[FSUtil.node, input.filesystemLayer] as const] : []),
  ])

describe("InstructionContext", () => {
  it.live("loads AGENTS.md with CLAUDE.md fallback as one aggregate context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "packages", "core")
          const outside = path.join(tmp.path, "AGENTS.md")
          const globalFile = path.join(global, "AGENTS.md")
          const globalClaudeFile = path.join(global, ".claude", "CLAUDE.md")
          const projectFile = path.join(project, "AGENTS.md")
          const projectClaudeFile = path.join(project, "CLAUDE.md")
          const packageFile = path.join(directory, "AGENTS.md")
          const packageClaudeFile = path.join(directory, "CLAUDE.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.dirname(globalClaudeFile), { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(globalClaudeFile, "global claude")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(projectClaudeFile, "project claude")
            await fs.writeFile(packageFile, "package")
            await fs.writeFile(packageClaudeFile, "package claude")
          })

          const load = SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          const initialized = yield* SystemContext.initialize(yield* load)
          expect(initialized.baseline).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
          )
          expect(initialized.baseline).not.toContain("outside")
          expect(initialized.baseline).not.toContain("claude")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toMatchObject({
            _tag: "Updated",
            text: expect.stringContaining(`Instructions from: ${packageFile}\nchanged`),
          })

          yield* Effect.promise(() => fs.rm(packageFile))
          const partial = yield* SystemContext.reconcile(yield* load, initialized.snapshot)
          expect(partial).toEqual({
            _tag: "Updated",
            text: [
              "These instructions replace all previously loaded ambient instructions.",
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${projectFile}\nproject`,
            ].join("\n\n"),
            snapshot: expect.any(Object),
          })

          yield* Effect.promise(() => Promise.all([fs.rm(globalFile), fs.rm(projectFile)]))
          const fallback = yield* SystemContext.initialize(yield* load)
          expect(fallback.baseline).toBe(
            [
              `Instructions from: ${globalClaudeFile}\nglobal claude`,
              `Instructions from: ${packageClaudeFile}\npackage claude`,
              `Instructions from: ${projectClaudeFile}\nproject claude`,
            ].join("\n\n"),
          )

          yield* Effect.promise(() =>
            Promise.all([fs.rm(globalClaudeFile), fs.rm(projectClaudeFile), fs.rm(packageClaudeFile)]),
          )
          expect(yield* SystemContext.reconcile(yield* load, fallback.snapshot)).toEqual({
            _tag: "Updated",
            text: "Previously loaded instructions no longer apply.",
            snapshot: {},
          })
        }),
      ),
    ),
  )

  it.effect("does not read the global CLAUDE.md fallback when AGENTS.md is available", () =>
    Effect.gen(function* () {
      const globalFile = AbsolutePath.make(FSUtil.resolve("/global/AGENTS.md"))
      let claudeRead = false
      const filesystem = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([]),
              readFileStringSafe: (path) =>
                Effect.sync(() => {
                  if (path === globalFile) return "global"
                  claudeRead = true
                  throw new Error("unused CLAUDE.md fallback was read")
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: filesystem,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect((yield* SystemContext.initialize(context)).baseline).toBe(`Instructions from: ${globalFile}\nglobal`)
      expect(claudeRead).toBe(false)
    }),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: path.join(tmp.path, "global"),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          expect((yield* SystemContext.initialize(context)).baseline).toBe(`Instructions from: ${file}\n`)
        }),
      ),
    ),
  )

  it.effect("preserves admitted instructions while observation is unavailable", () =>
    Effect.gen(function* () {
      const failingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: "/repo/AGENTS.md", content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("preserves admitted instructions when a discovered file disappears before read", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const racingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([file]),
              readFileStringSafe: () => Effect.succeed(undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: file, content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("canonicalizes upward discovery boundaries", () =>
    Effect.gen(function* () {
      let observed: { targets: string[]; start: string; stop?: string } | undefined
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                Effect.sync(() => {
                  observed = options
                  return []
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )

      expect(observed).toEqual({
        targets: ["AGENTS.md", "CLAUDE.md"],
        start: FSUtil.resolve("/repo"),
        stop: FSUtil.resolve("/repo"),
      })
    }),
  )

  it.effect("honors the project instruction opt-out", () =>
    Effect.gen(function* () {
      const previous = process.env.FORGE_DISABLE_PROJECT_CONFIG
      let scanned = false
      process.env.FORGE_DISABLE_PROJECT_CONFIG = "1"

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.FORGE_DISABLE_PROJECT_CONFIG
            else process.env.FORGE_DISABLE_PROJECT_CONFIG = previous
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.live("honors the Claude instruction opt-out", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const previous = process.env.FORGE_DISABLE_CLAUDE_CODE_PROMPT
        process.env.FORGE_DISABLE_CLAUDE_CODE_PROMPT = "1"

        return Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, ".claude"), { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(global, ".claude", "CLAUDE.md"), "global claude")
            await fs.writeFile(path.join(project, "CLAUDE.md"), "project claude")
          })

          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                ),
              }),
            ),
          )

          expect((yield* SystemContext.initialize(context)).baseline).toBe("")
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env.FORGE_DISABLE_CLAUDE_CODE_PROMPT
              else process.env.FORGE_DISABLE_CLAUDE_CODE_PROMPT = previous
            }),
          ),
        )
      }),
    ),
  )

  it.effect("does not discover project instructions outside the canonical project root", () =>
    Effect.gen(function* () {
      let scanned = false
      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("does not read project instructions that resolve outside the canonical project root", () =>
    Effect.gen(function* () {
      const candidate = AbsolutePath.make(FSUtil.resolve("/repo/CLAUDE.md"))
      const outside = AbsolutePath.make(FSUtil.resolve("/outside/secret"))
      let outsideRead = false
      const filesystem = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([candidate]),
              resolve: (path) => Effect.succeed(path === candidate ? outside : FSUtil.resolve(path)),
              readFileStringSafe: (path) =>
                Effect.sync(() => {
                  if (path !== outside) return undefined
                  outsideRead = true
                  return "secret"
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: filesystem,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect((yield* SystemContext.initialize(context)).baseline).toBe("")
      expect(outsideRead).toBe(false)
    }),
  )
})
