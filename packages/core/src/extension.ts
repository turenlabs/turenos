export * as ExtensionRuntime from "./extension"

import { Extension } from "@turenlabs/schema"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { ExtensionManifestPolicy } from "@turenlabs/extensions"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import semver from "semver"
import { makeGlobalNode } from "./effect/app-node"
import { NonNegativeInt } from "./schema"
import { Storage } from "./storage"
import { SecretVault } from "./secret-vault"

const scope = Storage.Scope.make("internal/extensions")
const manifestLock = Semaphore.makeUnsafe(1)
const desiredKey = (id: Extension.ID | string) => Storage.Key.make(`desired/${id}`)
const manifestKey = (id: Extension.ID | string) => Storage.Key.make(`manifest/${id}`)

const DesiredRecord = Schema.Struct({
  enabled: Schema.Boolean,
  configuration: Schema.Record(Schema.String, Schema.String),
  revision: NonNegativeInt,
})
const decodeDesired = Schema.decodeUnknownOption(Schema.fromJsonString(DesiredRecord))
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Extension.Manifest))

export type Desired = typeof DesiredRecord.Type

export type UpdateResult = {
  readonly desired: Desired
  readonly changed: boolean
  readonly secretsSet: Readonly<Record<string, boolean>>
}

export class InvalidUpdate extends Schema.TaggedErrorClass<InvalidUpdate>()("Extension.InvalidUpdate", {
  id: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid Extension update for ${this.id}: ${this.reason}`
  }
}

export interface Interface {
  readonly manifests: () => Effect.Effect<ReadonlyArray<Extension.Manifest>>
  readonly get: (id: Extension.ID | string) => Effect.Effect<Extension.Manifest | undefined>
  readonly desired: (id: Extension.ID | string) => Effect.Effect<Desired | undefined>
  readonly enabled: (id: Extension.ID | string) => Effect.Effect<boolean>
  readonly configuration: (id: Extension.ID | string) => Effect.Effect<Record<string, string>>
  readonly secret: (id: Extension.ID | string, name: string) => Effect.Effect<string | undefined>
  readonly secretsSet: (id: Extension.ID | string) => Effect.Effect<Record<string, boolean>>
  readonly update: (
    id: Extension.ID | string,
    input: {
      readonly enabled: boolean
      readonly manifest?: Extension.Manifest
      readonly configuration?: Readonly<Record<string, string>>
      readonly secrets?: Readonly<Record<string, string>>
    },
    admission?: { readonly local: boolean },
  ) => Effect.Effect<UpdateResult, InvalidUpdate>
}

export type EnabledSkill = {
  readonly manifest: Extension.Manifest
  readonly contribution: Extension.Skill
}

export const enabledSkills = Effect.fn("Extension.enabledSkills")(function* (runtime: Interface) {
  const manifests = (yield* runtime.manifests()).filter((manifest) =>
    manifest.contributions.some((contribution) => contribution.type === "skill"),
  )
  return (yield* Effect.forEach(
    manifests,
    (manifest) =>
      runtime
        .enabled(manifest.id)
        .pipe(
          Effect.map((enabled) =>
            enabled
              ? manifest.contributions.flatMap((contribution) =>
                  contribution.type === "skill" ? [{ manifest, contribution }] : [],
                )
              : [],
          ),
        ),
    { concurrency: 8 },
  )).flat()
})

export class Service extends Context.Service<Service, Interface>()("@forge/Extension") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const vault = yield* SecretVault.Service

    const secretAddress = (id: Extension.ID | string, name: string) => ({
      scope: Storage.Scope.make(`internal/extensions/${id}`),
      key: Storage.Key.make(`secret/${name}`),
    })
    const declaredSecrets = (manifest: Extension.Manifest) =>
      manifest.contributions.flatMap((contribution) => contribution.secrets)
    const installed = Effect.fnUntraced(function* () {
      const entries = yield* storage.list({ scope })
      return entries.flatMap((entry) => {
        if (!String(entry.key).startsWith("manifest/")) return []
        const manifest = Option.getOrUndefined(decodeManifest(entry.value))
        return manifest ? [manifest] : []
      })
    })
    const manifests = Effect.fn("Extension.manifests")(function* () {
      const builtins = new Set(ExtensionCatalog.manifests.map((manifest) => String(manifest.id)))
      return [...ExtensionCatalog.manifests, ...(yield* installed()).filter((manifest) => !builtins.has(manifest.id))]
    })
    const get = Effect.fn("Extension.get")(function* (id: Extension.ID | string) {
      const builtin = ExtensionCatalog.get(id)
      if (builtin) return builtin
      return (yield* installed()).find((manifest) => manifest.id === id)
    })
    const read = Effect.fn("Extension.readDesired")(function* (
      id: Extension.ID | string,
      resolved?: Extension.Manifest,
    ) {
      const manifest = resolved ?? (yield* get(id))
      if (!manifest) return undefined
      const stored = yield* storage.get({ scope, key: desiredKey(id) })
      if (!stored) {
        return {
          value: {
            enabled: manifest.contributions.some((contribution) => contribution.defaultEnabled),
            configuration: {},
            revision: 0,
          } satisfies Desired,
          storageRevision: null,
        }
      }
      const value = Option.getOrElse(decodeDesired(stored.value), () => ({
        enabled: false,
        configuration: {},
        revision: 0,
      }))
      return { value, storageRevision: stored.revision }
    })
    const desired = Effect.fn("Extension.desired")(function* (id: Extension.ID | string) {
      return (yield* read(id))?.value
    })
    const enabled = Effect.fn("Extension.enabled")(function* (id: Extension.ID | string) {
      return (yield* read(id))?.value.enabled ?? false
    })
    const configuration = Effect.fn("Extension.configuration")(function* (id: Extension.ID | string) {
      return (yield* read(id))?.value.configuration ?? {}
    })
    const secret = Effect.fn("Extension.secret")(function* (id: Extension.ID | string, name: string) {
      const manifest = yield* get(id)
      if (!manifest || !declaredSecrets(manifest).some((item) => item.id === name)) return undefined
      const address = secretAddress(id, name)
      const stored = yield* storage.get(address)
      if (!stored || !vault.isSealed(stored.value)) return undefined
      return yield* vault.open(address.scope, address.key, stored.value)
    })
    const secretsSet = Effect.fn("Extension.secretsSet")(function* (id: Extension.ID | string) {
      const manifest = yield* get(id)
      if (!manifest) return {}
      return Object.fromEntries(
        yield* Effect.forEach(declaredSecrets(manifest), (item) =>
          secret(id, item.id).pipe(Effect.map((value) => [item.id, value !== undefined] as const)),
        ),
      )
    })

    function mutate(
      id: Extension.ID | string,
      input: {
        readonly enabled: boolean
        readonly manifest?: Extension.Manifest
        readonly configuration?: Readonly<Record<string, string>>
        readonly secrets?: Readonly<Record<string, string>>
      },
      admission?: { readonly local: boolean },
    ): Effect.Effect<UpdateResult, InvalidUpdate> {
      const run: Effect.Effect<UpdateResult, InvalidUpdate> = Effect.gen(function* () {
        const existingManifest = yield* get(id)
        const manifest = input.manifest ?? existingManifest
        if (!manifest) return yield* invalid(id, "Extension is not in the catalog")
        if (input.manifest) {
          if (manifest.id !== id) return yield* invalid(id, "Installed manifest id does not match the extension id")
          if (ExtensionCatalog.get(id)) return yield* invalid(id, "Built-in extensions cannot be replaced")
          const reason = validateInstalledManifest(manifest, yield* manifests(), existingManifest)
          if (reason) return yield* invalid(id, reason)
        }
        const contributions = manifest.contributions
        if (contributions.length === 0) return yield* invalid(id, "Extension has no contribution")
        if (
          contributions.some((contribution) => "localOnly" in contribution && contribution.localOnly) &&
          admission?.local !== true
        ) {
          return yield* invalid(id, "Extension can only be updated on a local server")
        }

        const allowedConfiguration = new Set(contributions.flatMap(configurationFields))
        const undeclaredConfiguration = Object.keys(input.configuration ?? {}).find(
          (name) => !allowedConfiguration.has(name),
        )
        if (undeclaredConfiguration) {
          return yield* invalid(id, `Undeclared configuration: ${undeclaredConfiguration}`)
        }
        if (
          contributions.some(
            (contribution) =>
              contribution.type === "mcp" &&
              contribution.deployment.type === "customer-url" &&
              !resolveCustomerEndpoint(input.configuration?.endpoint ?? "", contribution.deployment),
          ) &&
          input.configuration?.endpoint !== undefined &&
          input.configuration.endpoint !== ""
        ) {
          return yield* invalid(id, "Customer endpoint is invalid")
        }

        const declared = new Set(declaredSecrets(manifest).map((item) => item.id))
        const undeclaredSecret = Object.keys(input.secrets ?? {}).find((name) => !declared.has(name))
        if (undeclaredSecret) return yield* invalid(id, `Undeclared secret: ${undeclaredSecret}`)

        const current = yield* read(id, manifest)
        if (!current) return yield* invalid(id, "Extension is not in the catalog")
        const nextConfiguration = { ...current.value.configuration }
        for (const [name, value] of Object.entries(input.configuration ?? {})) {
          if (value === "") delete nextConfiguration[name]
          else nextConfiguration[name] = value
        }
        const secretChanges = yield* Effect.forEach(Object.entries(input.secrets ?? {}), ([name, value]) =>
          Effect.gen(function* () {
            const existing = yield* secret(id, name)
            if (existing === (value || undefined)) return undefined
            const address = secretAddress(id, name)
            if (value === "") return { type: "remove" as const, ...address }
            return {
              type: "set" as const,
              ...address,
              value: yield* vault.seal(address.scope, address.key, value),
            }
          }),
        )
        const changes = secretChanges.filter((change) => change !== undefined)
        const desiredChanged =
          current.value.enabled !== input.enabled ||
          JSON.stringify(sorted(current.value.configuration)) !== JSON.stringify(sorted(nextConfiguration))
        const manifestChanged =
          input.manifest !== undefined && JSON.stringify(input.manifest) !== JSON.stringify(existingManifest)
        if (!desiredChanged && !manifestChanged && changes.length === 0) {
          return {
            desired: current.value,
            changed: false,
            secretsSet: yield* secretsSet(id),
          }
        }

        const next: Desired = {
          enabled: input.enabled,
          configuration: sorted(nextConfiguration),
          revision: current.value.revision + 1,
        }
        const retry = yield* storage
          .guardedBatch({
            guards: [{ scope, key: desiredKey(id), expectedRevision: current.storageRevision }],
            sets: [
              { scope, key: desiredKey(id), value: JSON.stringify(next) },
              ...(manifestChanged ? [{ scope, key: manifestKey(id), value: JSON.stringify(manifest) }] : []),
              ...changes.flatMap((change) => (change.type === "set" ? [change] : [])),
            ],
            removes: changes.flatMap((change) => (change.type === "remove" ? [change] : [])),
          })
          .pipe(
            Effect.as(undefined as UpdateResult | undefined),
            Effect.catchTag("Storage.RevisionConflict", () => runMutation()),
          )
        if (retry) return retry
        return { desired: next, changed: true, secretsSet: yield* secretsSet(id) }
      })
      const runMutation = () => run
      return input.manifest ? manifestLock.withPermit(run) : run
    }

    const update = Effect.fn("Extension.update")(mutate)

    return Service.of({
      manifests,
      get,
      desired,
      enabled,
      configuration,
      secret,
      secretsSet,
      update,
    })
  }),
)

function invalid(id: Extension.ID | string, reason: string) {
  return new InvalidUpdate({ id: String(id), reason })
}

function validateInstalledManifest(
  manifest: Extension.Manifest,
  current: ReadonlyArray<Extension.Manifest>,
  previous?: Extension.Manifest,
) {
  try {
    ExtensionManifestPolicy.validateManifestPolicy(manifest)
    if (!semver.valid(manifest.version)) return "Extension versions must be semver"
    const contributions = manifest.contributions
    if (manifest.trust !== "community") return "Dynamically installed manifests must use community trust"
    if (contributions.some((contribution) => !installableContribution(contribution))) {
      return "External installation supports prompt-only skills, fixed-profile subagents, and generic hosted MCPs only"
    }
    if (
      contributions.some(
        (contribution) =>
          contribution.type === "mcp" &&
          (contribution.authentication === "key" ||
            contribution.authentication === "desktop" ||
            contribution.authentication === "client-credentials" ||
            contribution.secrets.length > 0 ||
            contribution.connection !== undefined ||
            contribution.tools.write.length > 0),
      )
    ) {
      return "Dynamic hosted MCP installation is limited to read-only none or OAuth connections"
    }
    if (contributions.some((contribution) => contribution.type === "mcp" && !contribution.mcpContext)) {
      return "Installed MCP contributions require a lazy context policy"
    }
    if (
      contributions.some(
        (contribution) => contribution.type === "mcp" && contribution.tools.allow.some((tool) => /[*?[\]]/.test(tool)),
      )
    ) {
      return "Installed MCP tool allowlists must contain concrete tool names"
    }
    if (previous) {
      if (!semver.valid(previous.version) || !semver.valid(manifest.version)) return "Extension versions must be semver"
      const compared = semver.compare(manifest.version, previous.version)
      if (compared < 0) return "Installed extensions cannot be downgraded"
      if (compared === 0 && JSON.stringify(previous) !== JSON.stringify(manifest)) {
        return "An installed extension version is immutable"
      }
      if (compared > 0 && connectionIdentity(previous) !== connectionIdentity(manifest)) {
        return "An installed extension update cannot change its connection identity"
      }
    }
    const others = current.filter((candidate) => candidate.id !== manifest.id)
    const adapters = new Set(others.flatMap((candidate) => candidate.contributions.map((item) => item.adapter)))
    const collision = contributions.find((contribution) => adapters.has(contribution.adapter))
    if (collision) return `Extension adapter is already installed: ${collision.adapter}`
    ExtensionManifestPolicy.validateCatalogPolicy([...others, manifest])
  } catch (error) {
    return error instanceof Error ? error.message : "Installed extension policy is invalid"
  }
}

function connectionIdentity(manifest: Extension.Manifest) {
  return JSON.stringify(
    manifest.contributions.map((contribution) =>
      contribution.type === "mcp"
        ? {
            id: contribution.id,
            adapter: contribution.adapter,
            deployment: contribution.deployment,
            authentication: contribution.authentication,
            localOnly: contribution.localOnly,
            secrets: contribution.secrets,
            configuration: contribution.configuration,
            connection: contribution.connection,
          }
        : contribution.type === "skill"
          ? {
              type: contribution.type,
              id: contribution.id,
              adapter: contribution.adapter,
              source: contribution.source.type,
              agent: contribution.agent,
            }
          : { type: contribution.type },
    ),
  )
}

function installableContribution(contribution: Extension.Contribution) {
  if (contribution.type === "skill") {
    return (
      contribution.source.type === "catalog" &&
      contribution.adapter === `skill:${contribution.id}` &&
      contribution.secrets.length === 0
    )
  }
  return (
    contribution.type === "mcp" &&
    contribution.deployment.type === "hosted" &&
    contribution.adapter === `mcp:${contribution.id}`
  )
}

function configurationFields(contribution: Extension.Contribution) {
  if (contribution.type === "tool") {
    return contribution.configuration.map((field) => String(field.id))
  }
  if (contribution.type === "mcp") {
    return [
      ...(contribution.configuration ?? []).map((field) => String(field.id)),
      ...(contribution.deployment.type === "customer-url" ? ["endpoint"] : []),
    ]
  }
  return []
}

export function resolveCustomerEndpoint(
  value: string,
  deployment: Extract<Extension.McpDeployment, { type: "customer-url" }>,
) {
  if (!deployment.path.startsWith("/") || deployment.path.startsWith("//") || deployment.path.includes("\\")) {
    return false
  }
  try {
    const input = new URL(value)
    const hostname = input.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase()
    if (input.protocol !== "https:" || input.username || input.password || input.hash) return false
    if (
      ["169.254.169.254", "100.100.100.200", "metadata.google.internal"].includes(hostname) ||
      hostname.endsWith(".metadata.google.internal")
    ) {
      return false
    }
    const endpoint = new URL(deployment.path, input)
    return endpoint.origin === input.origin ? endpoint.toString() : undefined
  } catch {
    return undefined
  }
}

function sorted(input: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(input).toSorted(([left], [right]) => left.localeCompare(right)))
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Storage.node, SecretVault.node] })
