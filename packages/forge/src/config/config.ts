import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { serviceUse } from "@turenlabs/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@turenlabs/core/global"
import fsNode from "fs/promises"
import { Flag } from "@turenlabs/core/flag/flag"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync } from "fs"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@turenlabs/core/v1/config/console-state"
import { FSUtil } from "@turenlabs/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Fiber, Layer, Schema, Semaphore } from "effect"
import { EffectFlock } from "@turenlabs/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { Config as ConfigV2 } from "@turenlabs/core/config"
import { ConfigV1 } from "@turenlabs/core/v1/config/config"
import { ConfigMcpLegacyV1 } from "@turenlabs/core/v1/config/mcp-legacy"
import { ConfigPermissionV1 } from "@turenlabs/core/v1/config/permission"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPlugin } from "./plugin"
import { ConfigPluginV1 } from "@turenlabs/core/v1/config/plugin"
import { ConfigPaths } from "./paths"
import { ConfigVariable } from "./variable"

// One `forge.json` is read by both config services, and v2 owns top-level keys this v1 schema has
// never heard of -- `providers` above all, which specs/v2/config.md:201 makes the only spelling of
// provider config in v2. The unrecognized-key guard is a typo check, so a key a sibling schema
// defines has to pass it: this reader is on the session turn path, and rejecting the document there
// fails every prompt with ConfigInvalidError before the provider stream ever opens. Read-only on
// purpose -- `updateGlobalUnlocked` rewrites the file from its v1 decode, so tolerating unknown keys
// there would delete them instead.
const V2_ONLY_KEYS = Object.keys(ConfigV2.Info.fields).filter((key) => !(key in ConfigV1.Info.fields))

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  // `mergeDeep` replaces arrays, which would drop every legacy MCP entry seen by an earlier
  // document the moment a later one carries its own. Accumulate first, then let `dedupe` apply
  // normal config precedence (last document wins per server name).
  const legacy = [...(target.mcp_legacy ?? []), ...(source.mcp_legacy ?? [])]
  const merged = mergeDeep(target, source) as Info
  if (legacy.length) merged.mcp_legacy = ConfigMcpLegacyV1.dedupe(legacy)
  return merged
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  return mergeConfig(target, source)
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
  // mcp_legacy is derived state too: the classification of a retired root `mcp` block, carried so the
  // migration in ./mcp-legacy.ts can activate the extensions that replaced those servers. Never written
  // back to disk -- `writable` strips it, and the raw block stays in the user's file untouched.
  mcp_legacy?: ConfigMcpLegacyV1.Entry[]
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(
  config: T,
  filepath: string,
): Promise<T> {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

const updateGlobalLock = Semaphore.makeUnsafe(1)

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly removeGlobalProvider: (providerID: string) => Effect.Effect<boolean>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/Config") {}

export const use = serviceUse(Service)

function globalConfigDirectory() {
  return Flag.FORGE_CONFIG_DIR ?? Global.Path.config
}

function globalConfigFile() {
  const candidates = ["forge.jsonc", "forge.json", "config.json"].map((file) =>
    path.join(globalConfigDirectory(), file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, mcp_legacy: _mcp_legacy, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const env = yield* Env.Service
    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      // The retired `mcp` block comes off before the unrecognized-key guard runs, so a config that
      // still declares MCP servers loads instead of failing every project with ConfigInvalidError.
      // Applied on read only: the user's file is never rewritten, so nothing can be lost by it.
      const legacy = ConfigMcpLegacyV1.split(parsed)
      const data: Info = ConfigParse.schema(ConfigV1.Info, legacy.config, source, { allow: V2_ONLY_KEYS })
      if (legacy.servers) {
        const entries = ConfigMcpLegacyV1.classify(legacy.servers)
        if (entries.length) data.mcp_legacy = entries
        for (const warning of ConfigMcpLegacyV1.warnings(entries)) {
          yield* Effect.logWarning(warning, { path: source })
        }
      }
      if (!("path" in options)) return data

      if (!data.$schema) {
        data.$schema = "https://github.com/turenlabs/forge/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://github.com/turenlabs/forge/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      const loaded = yield* loadConfig(text, { path: filepath }, env)
      return yield* Effect.promise(() => resolveLoadedPlugins(loaded, filepath))
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.FORGE_CONFIG && !Flag.FORGE_CONFIG_DIR && !Flag.FORGE_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://github.com/turenlabs/forge/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      const directory = globalConfigDirectory()
      result = mergeConfig(result, yield* loadFile(path.join(directory, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(directory, "forge.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(directory, "forge.jsonc"), env))

      const legacy = path.join(directory, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://github.com/turenlabs/forge/config.json"
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(directory, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        let result: Info = {}

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "FORGE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // Raw specs from one config source, before provenance for this merge step is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config
          // should behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity
          // while keeping the winning source/scope metadata for downstream installs and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        const globalConfig = yield* getGlobal()
        yield* merge(globalConfigDirectory(), globalConfig, "global")

        if (Flag.FORGE_CONFIG) {
          yield* merge(Flag.FORGE_CONFIG, yield* loadFile(Flag.FORGE_CONFIG))
          yield* Effect.logDebug("loaded custom config", { path: Flag.FORGE_CONFIG })
        }

        if (!Flag.FORGE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("forge", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.FORGE_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from FORGE_CONFIG_DIR", { path: Flag.FORGE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".forge") || dir === Flag.FORGE_CONFIG_DIR) {
            for (const file of ["forge.json", "forge.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source))
              result.agent ??= {}
              result.mode ??= {}
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.forge/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.FORGE_CONFIG_CONTENT) {
          const source = "FORGE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.FORGE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from FORGE_CONFIG_CONTENT")
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["forge.json", "forge.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.FORGE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.FORGE_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("FORGE_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (Flag.FORGE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.FORGE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: [],
            activeOrgName: undefined,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    /**
     * Re-attaches the retired root keys `loadConfig` strips.
     *
     * Every writer here serialises a *decoded* document back over the user's file, so a key the v1
     * schema does not declare is deleted unless it is put back by hand. Before this change the
     * unrecognized-key guard made that impossible by failing the write outright; now that a legacy
     * `mcp` block loads, it has to be carried through the write too, or the migration would destroy
     * the very servers it is meant to preserve. Read from the target file so one file's servers can
     * never be copied into another.
     */
    const retainRetired = Effect.fnUntraced(function* (file: string, merged: Record<string, unknown>) {
      const before = yield* readConfigFile(file)
      if (!before) return merged
      const servers = ConfigMcpLegacyV1.split(ConfigParse.jsonc(before, file)).servers
      if (!servers || !Object.keys(servers).length) return merged
      return { ...merged, [ConfigMcpLegacyV1.KEY]: servers }
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      const merged = yield* retainRetired(file, mergeDeep(writable(existing), writable(config)))
      yield* fs.writeFileString(file, JSON.stringify(merged, null, 2)).pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobalUnlocked = Effect.fn("Config.updateGlobalUnlocked")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const legacy = ConfigMcpLegacyV1.split(ConfigParse.jsonc(before, file))
        const existing = ConfigParse.schema(ConfigV1.Info, legacy.config, file)
        const merged = mergeDeep(writable(existing), patch)
        // A whole-file rewrite, so the retired block has to be written back explicitly.
        const serialized = JSON.stringify(
          legacy.servers && Object.keys(legacy.servers).length
            ? { ...merged, [ConfigMcpLegacyV1.KEY]: legacy.servers }
            : merged,
          null,
          2,
        )
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        // `patchJsonc` edits in place, so comments and every undeclared key survive on disk untouched.
        // Only the re-decode has to skip the retired block.
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigMcpLegacyV1.split(ConfigParse.jsonc(updated, file)).config, file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })
    const updateGlobal = Effect.fn("Config.updateGlobal")((config: Info) =>
      updateGlobalLock.withPermit(updateGlobalUnlocked(config)),
    )

    const removeGlobalProvider = Effect.fn("Config.removeGlobalProvider")((providerID: string) =>
      updateGlobalLock.withPermit(
        Effect.gen(function* () {
          const file = globalConfigFile()
          const before = (yield* readConfigFile(file)) ?? "{}"
          // `modify` deletes a property when the replacement is undefined, so both the legacy
          // `provider.<id>` and the v2 `providers.<id>` spellings are dropped while comments and
          // undeclared keys in the rest of the file survive untouched. It throws when the parent
          // path is absent though, so only keys actually in the document may be patched.
          const document = ConfigParse.jsonc(before, file)
          const patch = (["provider", "providers"] as const).flatMap((key) => {
            const section = isRecord(document) ? document[key] : undefined
            if (!isRecord(section) || !(providerID in section)) return []
            // Drop the whole section when the removed entry is its only member so the file
            // is not left holding an empty "provider": {}.
            return [Object.keys(section).length === 1 ? { [key]: undefined } : { [key]: { [providerID]: undefined } }]
          })
          if (patch.length === 0) return false
          const updated = patch.reduce((result, section) => patchJsonc(result, section), before)
          yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
          yield* invalidate()
          return true
        }),
      ),
    )

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      removeGlobalProvider,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Env.node],
})

export * as Config from "./config"
