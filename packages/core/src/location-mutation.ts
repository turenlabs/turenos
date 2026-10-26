export * as LocationMutation from "./location-mutation"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, PlatformError, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Location } from "./location"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

/**
 * Mutation paths do not accept project references. Relative paths must stay
 * inside the active Location. Absolute paths outside it require separate
 * `external_directory` approval.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export class PathError extends Schema.TaggedErrorClass<PathError>()("LocationMutation.PathError", {
  path: Schema.String,
  reason: Schema.Literals(["relative_escape", "location_escape", "non_directory_ancestor"]),
}) {}

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Canonical existing directory used as the external approval boundary. */
  readonly directory: string
  /** `external_directory` permission resource. */
  readonly resource: string
  readonly save: string
}

export const externalDirectoryPermission = (input: ExternalDirectoryAuthorization) => ({
  action: input.action,
  resources: [input.resource],
  save: [input.save],
})

export interface Target {
  /** Canonical existing path, or missing path below a canonical directory. */
  readonly canonical: string
  /** Permission resource: Location-relative for internal paths, canonical for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export interface Interface {
  /**
   * Resolve a path and derive its permission resources. Relative paths must
   * stay inside the Location. Absolute paths outside it require separate
   * `external_directory` approval. This does not approve the mutation.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, PathError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/LocationMutation") {}

interface ResolvedPath {
  readonly canonical: string
  readonly type?:
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"
  readonly directory: string
}

const slash = (value: string) => value.replaceAll("\\", "/")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const locationRoot = yield* fs.realPath(location.directory)

    function notFound<A>(effect: Effect.Effect<A, FSUtil.Error>) {
      return effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
    }

    const resolvePath = Effect.fnUntraced(function* (
      absolute: string,
      links = 0,
    ): Effect.fn.Return<ResolvedPath, PathError | FSUtil.Error> {
      const existing = yield* notFound(fs.realPath(absolute))
      if (existing !== undefined) {
        const info = yield* fs.stat(existing)
        return {
          canonical: existing,
          type: info.type,
          directory: info.type === "Directory" ? existing : path.dirname(existing),
        } satisfies ResolvedPath
      }

      let anchor = path.dirname(absolute)
      let child = absolute
      while (true) {
        const canonical = yield* notFound(fs.realPath(anchor))
        if (canonical !== undefined) {
          const info = yield* fs.stat(canonical)
          if (info.type !== "Directory") {
            return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
          }
          // realPath reports a dangling symlink as missing, but a write through it creates the link's target,
          // so resolve that target instead of the link itself.
          const link = yield* notFound(fs.readLink(path.join(canonical, path.basename(child))))
          if (link !== undefined) {
            // A target through a missing directory resolves lexically past it, which can cycle where the kernel
            // would not; 32 matches macOS MAXSYMLINKS.
            if (links === 32) {
              return yield* PlatformError.systemError({
                _tag: "BadResource",
                module: "LocationMutation",
                method: "resolve",
                pathOrDescriptor: absolute,
                description: "Too many symbolic links",
              })
            }
            // realPath normalizes `..` lexically before it resolves anything, but the kernel follows a symlinked
            // directory before the `..` that comes after it, so walk the target's directory one component at a time.
            let directory = path.isAbsolute(link) ? path.parse(link).root : canonical
            for (const part of path.dirname(link).slice(path.parse(link).root.length).split(path.sep)) {
              const next = path.join(directory, part)
              directory = part === ".." ? next : ((yield* notFound(fs.realPath(next))) ?? next)
            }
            return yield* resolvePath(
              path.resolve(directory, path.basename(link), path.relative(child, absolute)),
              links + 1,
            )
          }
          return {
            canonical: path.resolve(canonical, path.relative(anchor, absolute)),
            directory: canonical,
          } satisfies ResolvedPath
        }
        const parent = path.dirname(anchor)
        if (parent === anchor) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        child = anchor
        anchor = parent
      }
    })

    const resolve = Effect.fn("LocationMutation.resolve")(function* (input: ResolveInput) {
      const relative = !path.isAbsolute(input.path)
      const absolute = path.resolve(location.directory, input.path)
      const lexicallyInternal = FSUtil.contains(location.directory, absolute)
      if (relative && !lexicallyInternal) return yield* new PathError({ path: input.path, reason: "relative_escape" })

      const resolved = yield* resolvePath(absolute)
      if (lexicallyInternal && !FSUtil.contains(locationRoot, resolved.canonical)) {
        return yield* new PathError({ path: input.path, reason: "location_escape" })
      }

      const external = !lexicallyInternal
      const resource = external
        ? slash(resolved.canonical)
        : slash(path.relative(locationRoot, resolved.canonical) || ".")
      const externalDirectory =
        input.kind === "directory" && resolved.type === "Directory" ? resolved.canonical : resolved.directory
      const externalResource = slash(path.join(externalDirectory, "*"))
      return {
        canonical: resolved.canonical,
        resource,
        externalDirectory: external
          ? {
              action: "external_directory",
              directory: externalDirectory,
              resource: externalResource,
              save: externalResource,
            }
          : undefined,
      } satisfies Target
    })

    return Service.of({ resolve })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Location.node],
})
