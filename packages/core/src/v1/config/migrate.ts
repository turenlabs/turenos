export * as ConfigMigrateV1 from "./migrate"

import { ConfigV1 } from "./config"
import { ConfigAgentV1 } from "./agent"
import { ConfigPermissionV1 } from "./permission"
import { ConfigProviderV1 } from "./provider"
import { ConfigProviderOptionsV1 } from "./provider-options"

/**
 * Top-level keys that only ever appear in a v1 file, used to classify a whole
 * document as v1 before decoding it.
 *
 * A key belongs here only if current code can never write it into a v2 file.
 * Classification is all-or-nothing: once a document is treated as v1 it is
 * decoded against {@link ConfigV1.Info}, so every v2-named block in it
 * (`agents`, `commands`, `permissions`, ...) is dropped as an excess property.
 * `disabled_providers` is deliberately absent for that reason -- the desktop
 * app writes it when a provider is disconnected, and a key that shipped code
 * still writes cannot serve as a version discriminator.
 */
export const keys = new Set([
  "logLevel",
  "server",
  "command",
  "plugin",
  "snapshot",
  "small_model",
  "mode",
  "agent",
  "permission",
  "tools",
  "attachment",
  "layout",
])

/**
 * Detection keys that {@link migrate} intentionally does not carry into v2,
 * with the reason each was retired. Anything in {@link keys} that is neither
 * carried through nor listed here is an accidental drop.
 */
export const retired: Record<string, string> = {
  logLevel: "specs/v2/config.md:33 - no config consumer exists; logging initializes from CLI input.",
  server: "specs/v2/config.md:34 - location config is loaded after the server is already running.",
  small_model: "specs/v2/config.md:174 - superseded by an explicit `title` agent model override.",
  layout: "specs/v2/config.md:372 - deprecated in v1 already; the stretch layout is always used.",
}

export function isV1(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return Object.keys(record).some((key) => keys.has(key))
}

/**
 * A non-negative integer, or nothing.
 *
 * `ConfigCompaction` carries no range check on purpose -- `Config.loadFile` drops any document it
 * cannot decode, so a bounded `Schema` on a user-facing value silently deletes the rest of the
 * user's config on a typo. Forwarding an unchecked v1 alias into a v2 key would reintroduce
 * exactly that failure, so anything that is not already a valid `NonNegativeInt` is left behind
 * and the document still loads, as it does today.
 */
function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Lowers v1's compaction knobs onto their v2 names inside an otherwise-v2 document.
 *
 * `compaction` is spelled the same in both versions and so are `auto` and `prune`, so a v1-shaped
 * block decodes as v2 with those two booleans intact and every preservation knob dropped as an
 * excess property. That is the worst possible direction: `prune: true` survives -- the setting
 * that clears tool output -- while `tail_turns`, `preserve_recent_tokens` and `reserved`, the
 * settings that bound how much prune and compaction may take, silently fall back to defaults.
 *
 * Classification cannot fix it. `compaction` is a key current code writes, so it can never be a
 * version discriminator ({@link keys}), and shape-based detection is all-or-nothing: a v2 file
 * that happened to carry `tail_turns` would be decoded against the v1 schema and lose every
 * v2-only block. Lowering the three aliases in place leaves classification untouched, exactly as
 *
 * Authored v2 keys win over their v1 alias, since only the v1 name is ambiguous about intent.
 * Returns `undefined` when there is nothing to lower.
 */
export function compactionAliases(input: unknown) {
  if (!isRecord(input)) return undefined
  const keep = input["keep"]
  // A malformed `keep` is left exactly as authored so this cannot turn a document that fails to
  // decode today into one that loads with settings the user never wrote.
  if (keep !== undefined && !isRecord(keep)) return undefined
  const tokens = count(input["preserve_recent_tokens"])
  const turns = count(input["tail_turns"])
  const buffer = count(input["reserved"])
  if (tokens === undefined && turns === undefined && buffer === undefined) return undefined
  const lowered: Record<string, unknown> = {
    ...input,
    keep: {
      ...keep,
      ...(tokens !== undefined && keep?.["tokens"] === undefined ? { tokens } : {}),
      ...(turns !== undefined && keep?.["turns"] === undefined ? { turns } : {}),
    },
  }
  if (buffer !== undefined && input["buffer"] === undefined) lowered["buffer"] = buffer
  return lowered
}

const PROVIDER_USE = "provider.use" as const

type ProviderPolicy = { action: typeof PROVIDER_USE; effect: "allow" | "deny"; resource: string }

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
}

/**
 * v2 has no top-level provider allow/deny list. `experimental.policies` is its
 * representation (specs/v2/config.md:171-172), and the v2 catalog is what reads
 * it, so both the v1 migration and the v2 decode path lower these keys here.
 *
 * `Policy.evaluate` takes the *last* matching statement, so the broad deny that
 * implements an allowlist has to precede the entries it carves out, and the
 * disabled list has to come last to keep v1 precedence, where an explicitly
 * disabled provider stays disabled even if it is also in `enabled_providers`.
 */
export function providerPolicies(disabled: unknown, enabled: unknown) {
  const statements: ProviderPolicy[] = []
  const allowlist = strings(enabled)
  if (allowlist) {
    statements.push({ action: PROVIDER_USE, effect: "deny", resource: "*" })
    for (const id of allowlist) statements.push({ action: PROVIDER_USE, effect: "allow", resource: id })
  }
  for (const id of strings(disabled) ?? []) statements.push({ action: PROVIDER_USE, effect: "deny", resource: id })
  return statements
}

export function migrate(info: typeof ConfigV1.Info.Type) {
  // Authored statements come last so an explicit policy wins over one derived
  // from the legacy provider lists.
  const statements = [
    ...providerPolicies(info.disabled_providers, info.enabled_providers),
    ...(info.experimental?.policies ?? []),
  ]
  return {
    $schema: info.$schema,
    shell: info.shell,
    model: info.model,
    default_agent: info.default_agent,
    autoupdate: info.autoupdate,
    enterprise: info.enterprise,
    username: info.username,
    permissions: permissions(info.permission, info.tools),
    agents: agents(info),
    snapshots: info.snapshot,
    watcher: info.watcher,
    formatter: info.formatter,
    lsp: info.lsp,
    attachments: info.attachment,
    tool_output: info.tool_output,
    // Spelled identically in both versions, so it survives a v1-classified document unchanged.
    retention: info.retention,
    compaction: info.compaction && {
      auto: info.compaction.auto,
      prune: info.compaction.prune,
      keep: {
        tokens: info.compaction.preserve_recent_tokens,
        turns: info.compaction.tail_turns,
      },
      buffer: info.compaction.reserved,
    },
    commands: info.command,
    plugins: info.plugin?.map((plugin) =>
      typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] },
    ),
    experimental:
      statements.length || info.experimental?.harness_self_modification !== undefined
        ? {
            ...(info.experimental?.harness_self_modification === undefined
              ? {}
              : { harness_self_modification: info.experimental.harness_self_modification }),
            ...(statements.length ? { policies: statements } : {}),
          }
        : undefined,
    providers: providers(info.provider),
  }
}

function permissions(info?: ConfigPermissionV1.Info, tools?: Readonly<Record<string, boolean>>) {
  const rules: Array<{ action: string; resource: string; effect: ConfigPermissionV1.Action }> = Object.entries(
    tools ?? {},
  ).map(([action, enabled]) => ({
    action: normalizeAction(action),
    resource: "*",
    effect: enabled ? ("allow" as const) : ("deny" as const),
  }))
  for (const [action, rule] of Object.entries(info ?? {})) {
    if (!rule) continue
    if (typeof rule === "string") {
      rules.push({ action, resource: "*", effect: rule })
      continue
    }
    rules.push(...Object.entries(rule).map(([resource, effect]) => ({ action, resource, effect })))
  }
  return rules.length ? rules : undefined
}

function normalizeAction(action: string) {
  return action === "write" || action === "patch" ? "edit" : action
}

function agents(info: typeof ConfigV1.Info.Type) {
  const entries = [
    ...Object.entries(info.agent ?? {}),
    ...Object.entries(info.mode ?? {}).map(([name, agent]) => [name, { ...agent, mode: "primary" as const }] as const),
  ]
  if (!entries.length) return undefined
  return Object.fromEntries(entries.flatMap(([name, agent]) => (agent ? [[name, migrateAgent(agent)]] : [])))
}

export function migrateAgent(info: ConfigAgentV1.Info) {
  return {
    model: info.model,
    variant: info.variant,
    system: info.prompt,
    description: info.description,
    mode: info.mode,
    hidden: info.hidden,
    color: info.color,
    steps: info.steps,
    disabled: info.disable,
    permissions: permissions(info.permission),
  }
}

function providers(info?: Readonly<Record<string, ConfigProviderV1.Info>>) {
  if (!info) return undefined
  return Object.fromEntries(Object.entries(info).map(([name, provider]) => [name, migrateProvider(provider)]))
}

function migrateProvider(info: ConfigProviderV1.Info) {
  const lowerer = ConfigProviderOptionsV1.get(info.npm)
  const options = lowerer.provider(info.options ?? {})
  const url = info.api ?? options.url
  return {
    name: info.name,
    env: info.env,
    api: info.npm
      ? {
          type: "aisdk" as const,
          package: info.npm,
          ...(url === undefined ? {} : { url }),
          settings: options.settings ?? {},
        }
      : undefined,
    request: info.options && { headers: options.headers, body: options.body },
    models:
      info.models &&
      Object.fromEntries(Object.entries(info.models).map(([name, model]) => [name, migrateModel(model, info.npm)])),
  }
}

function migrateModel(info: typeof ConfigProviderV1.Model.Type, packageName?: string) {
  const packageID = info.provider?.npm ?? packageName
  const lowerer = ConfigProviderOptionsV1.get(packageID)
  const request = info.options && lowerer.request(info.options)
  const costs = info.cost && [
    {
      input: info.cost.input,
      output: info.cost.output,
      cache: { read: info.cost.cache_read, write: info.cost.cache_write },
    },
    ...(info.cost.context_over_200k
      ? [
          {
            tier: { type: "context" as const, size: 200_000 },
            input: info.cost.context_over_200k.input,
            output: info.cost.context_over_200k.output,
            cache: { read: info.cost.context_over_200k.cache_read, write: info.cost.context_over_200k.cache_write },
          },
        ]
      : []),
  ]
  const capabilities =
    info.tool_call !== undefined || info.modalities?.input !== undefined || info.modalities?.output !== undefined
      ? { tools: info.tool_call ?? false, input: info.modalities?.input ?? [], output: info.modalities?.output ?? [] }
      : undefined
  return {
    family: info.family,
    name: info.name,
    api: info.provider?.npm
      ? {
          ...(info.id === undefined ? {} : { id: info.id }),
          type: "aisdk" as const,
          package: info.provider.npm,
          ...(info.provider.api === undefined ? {} : { url: info.provider.api }),
          settings: {},
        }
      : info.id === undefined
        ? undefined
        : { id: info.id },
    capabilities,
    request: (info.headers || request) && {
      headers: info.headers,
      body: request,
    },
    variants:
      info.variants &&
      Object.entries(info.variants).map(([id, options]) => ({
        id,
        body: lowerer.request(options),
      })),
    cost: costs,
    disabled: info.status === "deprecated" ? true : undefined,
    limit: info.limit && {
      context: int(info.limit.context),
      input: info.limit.input === undefined ? undefined : int(info.limit.input),
      output: int(info.limit.output),
    },
  }
}

function int(value: number) {
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
}
