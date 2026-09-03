export * as ProjectV2 from "./project"
export * as Project from "./project"

import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { AbsolutePath } from "./schema"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { makeGlobalNode } from "./effect/app-node"
import { Hash } from "./util/hash"
import { ProjectDirectories } from "./project/directories"
import { ProjectSchema } from "./project/schema"
import { Storage } from "./storage"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

export class Info extends Schema.Class<Info>("Project.Info")({
  id: ID,
}) {}

export const DirectoriesInput = ProjectDirectories.ListInput
export type DirectoriesInput = typeof DirectoriesInput.Type

export const Directories = ProjectDirectories.ListOutput
export type Directories = typeof Directories.Type

export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
}

export interface Interface {
  readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
  readonly remember: (input: { store: AbsolutePath; id: ID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/ProjectV2") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const storage = yield* Storage.Service

    const directories = Effect.fn("Project.directories")(function* (input: DirectoriesInput) {
      return yield* projectDirectories.list(input.projectID)
    })

    const legacy = Effect.fnUntraced(function* (dir: string) {
      const read = (name: string) =>
        fs.readFileString(path.join(dir, name)).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
          Effect.orDie,
        )
      const current = yield* read("forge")
      const previous = current ?? (yield* read("opencode"))
      const value = previous?.trim()
      return value ? ID.make(value) : undefined
    })

    const remembered = Effect.fnUntraced(function* (store: AbsolutePath) {
      const state = yield* storage.get({
        scope: Storage.Scope.make("internal/project-identity"),
        key: Storage.Key.make(store),
      })
      const value = state?.value.trim()
      return value ? ID.make(value) : undefined
    })

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      const origin = yield* git.remote.get(repo)
      if (!origin) return undefined
      const normalized = url(origin)
      if (!normalized) return undefined
      return ID.make(Hash.fast(`git-remote:${normalized}`))
    })

    function url(input: string) {
      const value = input.trim()
      if (!value) return undefined

      try {
        const parsed = new URL(value)
        if (parsed.protocol === "file:") return undefined
        return parts(parsed.hostname, parsed.pathname)
      } catch {
        const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
        if (scp) return parts(scp[2], scp[3])
        return undefined
      }
    }

    function parts(host: string, name: string) {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "")
      if (!host || !pathname) return undefined
      return `${host.toLowerCase()}/${pathname}`
    }

    const root = Effect.fnUntraced(function* (repo: Git.Repository) {
      const root = (yield* git.history.rootCommits(repo))[0]
      return root ? ID.make(root) : undefined
    })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const startedAt = Date.now()
      yield* Effect.logInfo("project resolve phase", { directory: input, phase: "git-discover.started" })
      const repo = yield* git.repo.discover(input)
      yield* Effect.logInfo("project resolve phase", {
        directory: input,
        phase: "git-discover.completed",
        durationMs: Date.now() - startedAt,
        found: Boolean(repo),
      })
      if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

      // SQL is the durable destination. Repo-local markers are only legacy
      // import inputs and are never consulted once the opened directory has a
      // persisted owner.
      const stored = yield* projectDirectories.find(repo.worktree)
      const previous =
        stored?.projectID ?? (yield* remembered(repo.commonDirectory)) ?? (yield* legacy(repo.commonDirectory))
      // An identity we already hold always wins. The git remote is not ours: it
      // is renamed, repointed to a fork, or rewritten to an ssh alias by people
      // and tools outside this app, and every one of those would otherwise
      // re-key a directory that never moved, splitting its Sessions and
      // Workspaces across two projects. The remote may only *seed* an identity
      // for a directory we have never seen, which still lets two fresh clones
      // of one repository converge on the same project.
      const identityAt = Date.now()
      const id = previous ?? (yield* remote(repo)) ?? (yield* root(repo))
      yield* Effect.logInfo("project resolve phase", {
        directory: input,
        phase: "identity.completed",
        durationMs: Date.now() - identityAt,
        totalDurationMs: Date.now() - startedAt,
        remembered: Boolean(previous),
      })
      // Claim a freshly minted identity immediately. Not every caller that
      // creates rows for a directory goes through the full open path that
      // records one, so without this a directory can be seeded from the remote
      // more than once and land under two ids if the remote moved in between.
      if (!previous && id) yield* remember({ store: repo.commonDirectory, id })
      return {
        previous,
        id: id ?? ID.global,
        directory: repo.worktree,
        vcs: { type: "git" as const, store: repo.commonDirectory },
      }
    })

    const remember = Effect.fn("Project.remember")(function* (input: { store: AbsolutePath; id: ID }) {
      yield* storage.set({
        scope: Storage.Scope.make("internal/project-identity"),
        key: Storage.Key.make(input.store),
        value: input.id,
      })
    })

    return Service.of({ directories, resolve, remember })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, ProjectDirectories.node, Storage.node],
})
