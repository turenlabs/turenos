export * as PluginTrust from "./trust"

import { createHash, randomUUID } from "node:crypto"
import path from "path"
import { fileURLToPath } from "url"
import { Decision, Fingerprint, MAX_FILES, MAX_PATH_LENGTH, State, Status } from "@turenlabs/schema/plugin-trust"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Config } from "../config"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { AbsolutePath, RelativePath } from "../schema"

const MAX_MANIFEST_BYTES = 32 * 1_024 * 1_024
const MAX_SCANNED_ENTRIES = 100_000
const MAX_DEPTH = 128
const MAX_STORED_DECISIONS = 8_192
const MAX_STATE_BYTES = 4 * 1_024 * 1_024
const PRUNED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
])
const EXECUTABLE_DIRECTORIES = new Set(["plugin", "plugins", "tool", "tools"])

export type StatusInput = {
  readonly directory: string
  readonly root: string
}

export type DecideInput = StatusInput & {
  readonly fingerprint: Fingerprint
  readonly decision: Decision
}

export class StaleFingerprintError extends Schema.TaggedErrorClass<StaleFingerprintError>()(
  "PluginTrustStaleFingerprintError",
  {
    root: AbsolutePath,
    expected: Fingerprint,
    actual: Schema.optional(Fingerprint),
    status: State,
  },
) {
  override get message() {
    return `Repository plugin fingerprint is stale for ${this.root}`
  }
}

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()("PluginTrustPersistenceError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Failed to persist repository plugin trust at ${this.path}`
  }
}

export interface Interface {
  readonly status: (input: StatusInput) => Effect.Effect<Status>
  readonly decide: (input: DecideInput) => Effect.Effect<Status, StaleFingerprintError | PersistenceError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/PluginTrust") {}

const StoredDecision = Schema.Struct({
  root: AbsolutePath,
  fingerprint: Fingerprint,
  decision: Decision,
})
const StoredState = Schema.Struct({
  version: Schema.Literal(1),
  decisions: Schema.Array(StoredDecision).pipe(Schema.check(Schema.isMaxLength(MAX_STORED_DECISIONS))),
})
type StoredState = typeof StoredState.Type

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(StoredState))
const decodeStatus = Schema.decodeUnknownSync(Status)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const gate = Semaphore.makeUnsafe(1)
    const statePath = path.join(global.state, "plugin-trust.json")

    const readState = Effect.fn("PluginTrust.readState")(function* () {
      const info = yield* fs.stat(statePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info || Number(info.size) > MAX_STATE_BYTES) return emptyState()
      const text = yield* fs.readFileStringSafe(statePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!text || Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) return emptyState()
      return Option.getOrElse(decodeState(text), emptyState)
    })

    const status: Interface["status"] = Effect.fn("PluginTrust.status")(function* (input: StatusInput) {
      const lexicalRoot = AbsolutePath.make(path.resolve(input.directory, input.root))
      return yield* Effect.gen(function* () {
        const inspected = yield* inspect(fs, input)
        if (inspected.status !== "pending") return inspected
        const stored = yield* readState()
        const decisions = stored.decisions.filter(
          (item) => item.root === inspected.root && item.fingerprint === inspected.fingerprint,
        )
        const decision = decisions.some((item) => item.decision === "deny")
          ? "deny"
          : decisions.some((item) => item.decision === "allow")
            ? "allow"
            : undefined
        if (decision === "allow") return decodeStatus({ ...inspected, status: "trusted" })
        if (decision === "deny") return decodeStatus({ ...inspected, status: "denied" })
        return inspected
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed(
            decodeStatus({
              status: "invalid" as const,
              root: lexicalRoot,
              files: [],
              reason: "Unable to inspect repository plugin files",
            }),
          ),
        ),
      )
    })

    const writeState = Effect.fn("PluginTrust.writeState")(function* (state: StoredState) {
      const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* fs.ensureDir(global.state)
          yield* fs.writeFileString(temporary, JSON.stringify(state, null, 2), { flag: "wx" })
          yield* fs.chmod(temporary, 0o600)
          yield* fs.rename(temporary, statePath)
          yield* fs.chmod(statePath, 0o600)
        }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore))),
      ).pipe(Effect.mapError((cause) => new PersistenceError({ path: statePath, cause })))
    })

    const decide: Interface["decide"] = Effect.fn("PluginTrust.decide")(function* (input: DecideInput) {
      return yield* gate.withPermit(
        Effect.gen(function* () {
          const current = yield* status(input)
          if (!("fingerprint" in current) || current.fingerprint !== input.fingerprint) {
            const actual = "fingerprint" in current ? current.fingerprint : undefined
            return yield* new StaleFingerprintError({
              root: current.root,
              expected: input.fingerprint,
              ...(actual === undefined ? {} : { actual }),
              status: current.status,
            })
          }

          const stored = yield* readState()
          const decisions = stored.decisions.filter(
            (item) => item.root !== current.root || item.fingerprint !== input.fingerprint,
          )
          decisions.push({ root: current.root, fingerprint: input.fingerprint, decision: input.decision })
          yield* writeState({ version: 1, decisions: decisions.slice(-MAX_STORED_DECISIONS) })
          return decodeStatus({
            ...current,
            status: input.decision === "allow" ? ("trusted" as const) : ("denied" as const),
          })
        }),
      )
    })

    return Service.of({ status, decide })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

function emptyState(): StoredState {
  return { version: 1, decisions: [] }
}

type ManifestFile = {
  readonly relative: string
  readonly bytes: Uint8Array
}

type ConfigManifest = ManifestFile & {
  readonly declaresPlugins: boolean
  readonly pluginRefs: readonly string[]
}

type Directory = {
  readonly absolute: string
  readonly relative: string
  readonly executable: boolean
  readonly depth: number
}

const inspect = Effect.fn("PluginTrust.inspect")(function* (fs: FSUtil.Interface, input: StatusInput) {
  const root = AbsolutePath.make(yield* fs.resolve(path.resolve(input.directory, input.root)))
  // Never walk the filesystem root. It is what `ProjectV2.resolve` reports as the directory of the
  // global project, and what `Project.fromDirectory` carries through as a "/" worktree, so a caller
  // that forwards either without substituting the opened directory arrives here asking for the
  // whole disk. Scanning it reads every readable file on the machine to reach a verdict it can
  // never deliver -- EACCES or the entry cap -- so refuse it outright instead, and say what to pass
  // rather than reporting the scan failure the caller would otherwise be left to interpret.
  if (path.parse(root).root === root) {
    return decodeStatus({
      status: "invalid",
      root,
      files: [],
      reason: "Repository root is the filesystem root; inspect the opened directory instead",
    })
  }
  const rootInfo = yield* fs.stat(root)
  if (rootInfo.type !== "Directory") {
    return decodeStatus({
      status: "invalid",
      root,
      files: [],
      reason: "Repository root is not a directory",
    })
  }

  const directories: Directory[] = [{ absolute: root, relative: "", executable: false, depth: 0 }]
  const manifest = new Map<string, ManifestFile>()
  const configs = new Map<string, ConfigManifest>()
  const executable = new Map<string, ManifestFile>()
  let scannedEntries = 0
  let manifestBytes = 0

  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!
    const entries = yield* fs.readDirectoryEntries(directory.absolute)
    for (const entry of entries) {
      scannedEntries++
      const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name
      const absolute = path.join(directory.absolute, entry.name)
      const config = entry.name === "forge.json" || entry.name === "forge.jsonc"
      const forgeDirectory = entry.name === ".forge"
      const insideForge = directory.relative === ".forge" || directory.relative.endsWith("/.forge")
      const executableDirectory = insideForge && EXECUTABLE_DIRECTORIES.has(entry.name)
      const relevant = directory.executable || config || forgeDirectory || executableDirectory

      if (scannedEntries > MAX_SCANNED_ENTRIES) {
        return decodeStatus({ status: "invalid", root, files: [], reason: "Repository scan is too large" })
      }
      if (relative.length > MAX_PATH_LENGTH) {
        return decodeStatus({ status: "invalid", root, files: [], reason: "Repository plugin path is too long" })
      }
      if ((entry.type === "symlink" || entry.type === "other") && relevant) {
        // Relevant links are rejected rather than followed so approval always covers the bytes executed.
        return decodeStatus({
          status: "invalid",
          root,
          files: [],
          reason: `Unsafe repository plugin path: ${relative}`,
        })
      }
      if (
        (config && entry.type !== "file") ||
        ((forgeDirectory || executableDirectory) && entry.type !== "directory")
      ) {
        return decodeStatus({
          status: "invalid",
          root,
          files: [],
          reason: `Invalid repository plugin path: ${relative}`,
        })
      }
      if (entry.type === "directory") {
        if (PRUNED_DIRECTORIES.has(entry.name.toLowerCase())) continue
        if (directory.depth >= MAX_DEPTH) {
          return decodeStatus({ status: "invalid", root, files: [], reason: "Repository scan is too deep" })
        }
        directories.push({
          absolute,
          relative,
          executable: directory.executable || executableDirectory,
          depth: directory.depth + 1,
        })
        continue
      }
      if (entry.type !== "file" || (!config && !directory.executable)) continue

      const info = yield* fs.stat(absolute)
      const size = Number(info.size)
      if (
        info.type !== "File" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (!manifest.has(relative) && (manifest.size >= MAX_FILES || manifestBytes + size > MAX_MANIFEST_BYTES))
      ) {
        return decodeStatus({ status: "invalid", root, files: [], reason: "Repository plugin manifest is too large" })
      }
      const bytes = yield* fs.readFile(absolute)
      const file = { relative, bytes }
      if (!manifest.has(relative)) {
        manifest.set(relative, file)
        manifestBytes += bytes.byteLength
      }
      if (manifest.size > MAX_FILES || manifestBytes > MAX_MANIFEST_BYTES) {
        return decodeStatus({ status: "invalid", root, files: [], reason: "Repository plugin manifest is too large" })
      }
      if (config) {
        const document = Config.decodeDocument(new TextDecoder().decode(bytes), absolute)
        configs.set(relative, {
          ...file,
          declaresPlugins: Boolean(document?.info.plugins?.length),
          pluginRefs: (document?.info.plugins ?? []).map((plugin) =>
            typeof plugin === "string" ? plugin : plugin.package,
          ),
        })
      }
      if (directory.executable) executable.set(relative, file)
    }
  }

  const invalidReference = yield* collectReferencedPlugins({ fs, root, configs, manifest, executable, manifestBytes })
  if (invalidReference) return invalidReference

  const selected = new Map<string, ManifestFile>()
  if (executable.size > 0) {
    for (const file of configs.values()) selected.set(file.relative, file)
    for (const file of executable.values()) selected.set(file.relative, file)
  } else {
    const declaresPlugins = [...configs.values()].some((file) => file.declaresPlugins)
    if (declaresPlugins) for (const file of configs.values()) selected.set(file.relative, file)
  }
  if (selected.size === 0) return decodeStatus({ status: "none", root, files: [] })

  const names = [...selected.keys()].sort()
  const hash = createHash("sha256").update("forge-plugin-trust\0v1\0")
  for (const name of names) {
    const file = selected.get(name)
    if (!file) continue
    const bytes = file.bytes
    hash.update(name).update("\0").update(String(bytes.byteLength)).update("\0").update(bytes).update("\0")
  }

  return decodeStatus({
    status: "pending",
    root,
    fingerprint: Fingerprint.make(hash.digest("hex")),
    files: names.map((name) => RelativePath.make(name)),
  })
})

const collectReferencedPlugins = Effect.fn("PluginTrust.collectReferencedPlugins")(function* (input: {
  readonly fs: FSUtil.Interface
  readonly root: AbsolutePath
  readonly configs: ReadonlyMap<string, ConfigManifest>
  readonly manifest: Map<string, ManifestFile>
  readonly executable: Map<string, ManifestFile>
  readonly manifestBytes: number
}) {
  let manifestBytes = input.manifestBytes
  for (const config of input.configs.values()) {
    for (const ref of config.pluginRefs) {
      if (!ref.startsWith(".") && !ref.startsWith("/") && !ref.startsWith("file://")) continue
      const lexical = path.resolve(
        path.dirname(path.join(input.root, config.relative)),
        ref.startsWith("file://") ? fileURLToPath(ref) : ref,
      )
      const relative = path.relative(input.root, lexical).replaceAll("\\", "/")
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) continue
      if ((yield* input.fs.resolve(lexical)) !== lexical) return invalidPath(input.root, relative)
      const info = yield* input.fs.stat(lexical).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info) continue
      if (info.type !== "File" && info.type !== "Directory") return invalidPath(input.root, relative)

      const referenced: Directory[] =
        info.type === "Directory" ? [{ absolute: lexical, relative, executable: true, depth: 0 }] : []
      if (info.type === "File") {
        const bytes = yield* input.fs.readFile(lexical)
        if (input.manifest.size >= MAX_FILES || manifestBytes + bytes.byteLength > MAX_MANIFEST_BYTES) {
          return manifestTooLarge(input.root)
        }
        const file = { relative, bytes }
        if (!input.manifest.has(relative)) {
          input.manifest.set(relative, file)
          manifestBytes += bytes.byteLength
        }
        input.executable.set(relative, file)
      }

      for (let index = 0; index < referenced.length; index++) {
        const directory = referenced[index]!
        if (directory.depth >= MAX_DEPTH) {
          return decodeStatus({ status: "invalid", root: input.root, files: [], reason: "Repository scan is too deep" })
        }
        for (const entry of yield* input.fs.readDirectoryEntries(directory.absolute)) {
          const childRelative = `${directory.relative}/${entry.name}`
          if (entry.type === "symlink" || entry.type === "other") return invalidPath(input.root, childRelative)
          if (entry.type === "directory") {
            if (!PRUNED_DIRECTORIES.has(entry.name.toLowerCase())) {
              referenced.push({
                absolute: path.join(directory.absolute, entry.name),
                relative: childRelative,
                executable: true,
                depth: directory.depth + 1,
              })
            }
            continue
          }
          if (entry.type !== "file") continue
          const bytes = yield* input.fs.readFile(path.join(directory.absolute, entry.name))
          if (
            !input.manifest.has(childRelative) &&
            (input.manifest.size >= MAX_FILES || manifestBytes + bytes.byteLength > MAX_MANIFEST_BYTES)
          ) {
            return manifestTooLarge(input.root)
          }
          const file = { relative: childRelative, bytes }
          if (!input.manifest.has(childRelative)) {
            input.manifest.set(childRelative, file)
            manifestBytes += bytes.byteLength
          }
          input.executable.set(childRelative, file)
        }
      }
    }
  }
})

function invalidPath(root: AbsolutePath, relative: string) {
  return decodeStatus({ status: "invalid", root, files: [], reason: `Unsafe repository plugin path: ${relative}` })
}

function manifestTooLarge(root: AbsolutePath) {
  return decodeStatus({ status: "invalid", root, files: [], reason: "Repository plugin manifest is too large" })
}
