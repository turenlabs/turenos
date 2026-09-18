export * as ExtensionManager from "./index"

import { Extension } from "@turenlabs/schema"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Storage } from "@turenlabs/core/storage"
import { ToolVisibleError } from "@turenlabs/core/tool/visible-error"
import { InstanceRef } from "@/effect/instance-ref"
import { MCP } from "@/mcp"
import { McpIntegration } from "@/mcp/integration"
import { McpPackageRuntime } from "@/mcp/package-runtime"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Vigil } from "@/skill/vigil"
import { SecurityRegistry } from "@/security/registry"
import { SERVER_KEY } from "@/security/settings"
import { Scanner } from "@/security/util/scanner"
import { BATOU_ID, batouStatus, beginBatouDownload } from "@/security/batou-binary"
import { NonNegativeInt } from "@turenlabs/core/schema"
import { Cause, Effect, Exit, Option, Schema, Semaphore } from "effect"

const updateLocks = new Map<string, Semaphore.Semaphore>()
const updateLock = (id: string) => {
  const current = updateLocks.get(id)
  if (current) return current
  const created = Semaphore.makeUnsafe(1)
  updateLocks.set(id, created)
  return created
}
const observationScope = Storage.Scope.make("internal/extension-reconciliation")
const Observation = Schema.Struct({
  revision: NonNegativeInt,
  status: Extension.RuntimeStatus,
  detail: Schema.optional(Schema.String),
})
const decodeObservation = Schema.decodeUnknownOption(Schema.fromJsonString(Observation))
const observationKey = (id: Extension.ID | string) => Storage.Key.make(String(id))

const observation = Effect.fnUntraced(function* (id: Extension.ID | string) {
  const storage = yield* Storage.Service
  const stored = yield* storage.get({ scope: observationScope, key: observationKey(id) })
  return stored ? Option.getOrUndefined(decodeObservation(stored.value)) : undefined
})

const observe = Effect.fnUntraced(function* (id: Extension.ID | string, value: typeof Observation.Type) {
  const storage = yield* Storage.Service
  yield* storage.set({ scope: observationScope, key: observationKey(id), value: JSON.stringify(value) })
})

const securityID = (adapter: string) =>
  adapter.startsWith("security:") ? adapter.slice("security:".length) : undefined
const mcpID = (adapter: string) => (adapter.startsWith("mcp:") ? adapter.slice("mcp:".length) : undefined)
const catalogItem = (
  manifest: Extension.Manifest,
  input: {
    readonly enabled: boolean
    readonly status: Extension.RuntimeStatus
    readonly installed?: boolean
    readonly detail?: string
    readonly secretsSet: Readonly<Record<string, boolean>>
    readonly configurationSet?: Readonly<Record<string, boolean>>
  },
) => new Extension.Item({ manifest, origin: "catalog", mutable: true, configurationSet: {}, ...input })

const securityItem = Effect.fn("Extension.securityItem")(function* (
  manifest: Extension.Manifest,
  contribution: Extension.Tool | Extension.Data | Extension.Mcp,
  id: string,
  conflict: boolean,
) {
  const runtime = SecurityRegistry.integration(id)
  const activation = yield* ExtensionRuntime.Service
  const enabled = yield* activation.enabled(manifest.id)
  const secretsSet = runtime ? yield* SecurityRegistry.secretsSetFor(runtime) : {}
  const configuration = runtime ? yield* SecurityRegistry.configurationFor(id) : {}
  const configurationSet = Object.fromEntries(
    (contribution.type === "tool" ? contribution.configuration : []).map((field) => [
      field.id,
      Boolean(configuration[field.id]),
    ]),
  )
  const requiredSecretMissing = contribution.secrets.some((secret) => secret.required && !secretsSet[secret.id])
  const requiredConfigurationMissing =
    contribution.type === "tool" &&
    contribution.configuration.some((field) => field.required && !configurationSet[field.id])
  const observed = yield* securityObserved(contribution, id)
  const status: Extension.RuntimeStatus = conflict
    ? "failed"
    : !enabled
      ? "disabled"
      : requiredSecretMissing
        ? "needs-auth"
        : requiredConfigurationMissing
          ? "needs-config"
          : observed.status
  return catalogItem(manifest, {
    enabled,
    status,
    ...(conflict
      ? { detail: `MCP server name is already configured outside Extensions: ${SERVER_KEY}` }
      : "detail" in observed && observed.detail
        ? { detail: observed.detail }
        : {}),
    ...(observed.installed === undefined ? {} : { installed: observed.installed }),
    secretsSet,
    configurationSet,
  })
})

const securityObserved = Effect.fnUntraced(function* (
  contribution: Extension.Tool | Extension.Data | Extension.Mcp,
  id: string,
) {
  if (id === BATOU_ID) return yield* batouObserved()
  return yield* commandObserved(contribution)
})

const batouObserved = Effect.fnUntraced(function* () {
  const state = yield* Effect.promise(() => batouStatus())
  if (state.status === "installed") return { installed: true, status: "available" as const }
  if (state.status === "downloading") return { installed: false, status: "connecting" as const }
  if (state.status === "failed") {
    return { installed: false, status: "failed" as const, detail: ToolVisibleError.make(state.detail) }
  }
  return { installed: false, status: "needs-install" as const }
})

const commandObserved = Effect.fnUntraced(function* (contribution: Extension.Tool | Extension.Data | Extension.Mcp) {
  if (contribution.type !== "tool" || contribution.commands.length === 0) {
    return { installed: undefined, status: "available" as const }
  }
  const checks = yield* Effect.forEach(
    contribution.commands,
    (command) => Effect.promise(() => Scanner.which(command)).pipe(Effect.map((path) => [command, path] as const)),
    { concurrency: "unbounded" },
  )
  const installed = checks.some(([, path]) => Boolean(path))
  const missing = checks.filter(([, path]) => !path).map(([command]) => command)
  return {
    installed,
    status: installed ? ("available" as const) : ("needs-install" as const),
    ...(!installed && missing.length > 0
      ? { detail: `Install required local command${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}` }
      : {}),
  }
})

const mcpItem = Effect.fn("Extension.mcpItem")(function* (
  manifest: Extension.Manifest,
  contributions: ReadonlyArray<Extension.Mcp>,
) {
  const activation = yield* ExtensionRuntime.Service
  const desired = yield* activation.desired(manifest.id)
  const enabled = desired?.enabled ?? false
  const hasOnePassword = contributions.some((contribution) => contribution.id === "onepassword")
  const command = hasOnePassword ? yield* McpIntegration.resolveOnePasswordCommand() : undefined
  const unavailable = hasOnePassword && !command
  const secretsSet = yield* activation.secretsSet(manifest.id)
  const configuration = yield* activation.configuration(manifest.id)
  const requiredConfigurationMissing = missingMcpConfiguration(contributions, configuration)
  const requiredSecretMissing = contributions.some((contribution) =>
    contribution.secrets.some((secret) => secret.required && !secretsSet[secret.id]),
  )
  const observed = yield* observation(manifest.id)
  const current = observed?.revision === desired?.revision ? observed : undefined
  const runtime = current?.status === "failed" && current.detail?.includes("Interrupt(") ? undefined : current
  const status: Extension.RuntimeStatus = !enabled
    ? "disabled"
    : unavailable
      ? "unavailable"
      : requiredConfigurationMissing
        ? "needs-config"
        : requiredSecretMissing
          ? "needs-auth"
          : (runtime?.status ?? "connecting")
  return catalogItem(manifest, {
    enabled,
    status,
    ...(unavailable
      ? { detail: "Install and authorize the audited 1Password MCP adapter" }
      : requiredConfigurationMissing || requiredSecretMissing
        ? { detail: "Enter the required connection configuration before connecting" }
        : runtime?.detail
          ? { detail: runtime.detail }
          : {}),
    secretsSet,
    configurationSet: Object.fromEntries(Object.keys(configuration).map((name) => [name, true])),
  })
})

function missingMcpConfiguration(
  contributions: ReadonlyArray<Extension.Mcp>,
  configuration: Readonly<Record<string, string>>,
) {
  return contributions
    .flatMap((contribution) => [
      ...(contribution.configuration ?? []),
      ...(contribution.deployment.type === "customer-url"
        ? [{ id: "endpoint", label: "MCP server URL", required: true }]
        : []),
    ])
    .find((field) => field.required && !configuration[field.id])
}

export function mcpRuntimeObservation(statuses: ReadonlyArray<MCP.Status | undefined>): {
  readonly status: Extension.RuntimeStatus
  readonly detail?: string
} {
  if (statuses.length === 0) return { status: "connecting" }
  if (statuses.every((status) => status?.status === "connected")) return { status: "connected" }
  if (statuses.some((status) => status?.status === "needs_auth" || status?.status === "needs_client_registration")) {
    return { status: "needs-auth" }
  }
  const failed = statuses.find((status) => status?.status === "failed")
  if (failed?.status === "failed") return { status: "failed", detail: ToolVisibleError.make(failed.error) }
  if (statuses.some((status) => status === undefined)) return { status: "connecting" }
  if (statuses.every((status) => status?.status === "disabled")) return { status: "disabled" }
  return { status: "connecting" }
}

export const list = Effect.fn("Extension.list")(function* () {
  const activation = yield* ExtensionRuntime.Service
  const manifests = yield* activation.manifests()
  McpIntegration.sync(manifests)
  const catalog = yield* Effect.forEach(
    manifests,
    (manifest) =>
      Effect.gen(function* () {
        const contribution = manifest.contributions[0]
        if (!contribution) {
          return catalogItem(manifest, { enabled: false, status: "unavailable", secretsSet: {} })
        }
        const security = securityID(contribution.adapter)
        if (security) {
          if (contribution.type === "skill") {
            return catalogItem(manifest, { enabled: false, status: "unavailable", secretsSet: {} })
          }
          return yield* securityItem(manifest, contribution, security, false)
        }
        const curated = manifest.contributions.filter(
          (item): item is Extension.Mcp => item.type === "mcp" && mcpID(item.adapter) !== undefined,
        )
        if (curated.length === manifest.contributions.length) {
          const item = yield* mcpItem(manifest, curated)
          return ExtensionCatalog.get(manifest.id) ? item : new Extension.Item({ ...item, installed: true })
        }
        const enabled = yield* activation.enabled(manifest.id)
        const secretsSet = yield* activation.secretsSet(manifest.id)
        const configuration = yield* activation.configuration(manifest.id)
        const requiredMissing = contribution.secrets.some((secret) => secret.required && !secretsSet[secret.id])
        const requiredConfigurationMissing = false
        const item = catalogItem(manifest, {
          enabled,
          status: !enabled
            ? "disabled"
            : requiredMissing
              ? "needs-auth"
              : requiredConfigurationMissing
                ? "needs-config"
                : "available",
          secretsSet,
          configurationSet: Object.fromEntries(Object.keys(configuration).map((name) => [name, true])),
        })
        return ExtensionCatalog.get(manifest.id) ? item : new Extension.Item({ ...item, installed: true })
      }),
    { concurrency: 8 },
  )
  return catalog
})

const updateSecurityExtension = Effect.fn("Extension.updateSecurityExtension")(function* (
  id: string,
  input: Extension.Update,
  result: ExtensionRuntime.UpdateResult,
) {
  if (result.changed) {
    const mcp = yield* Effect.serviceOption(MCP.Service)
    if (Option.isSome(mcp)) yield* mcp.value.reset()
  }
  if (id !== BATOU_ID || !input.enabled) return
  const status = yield* Effect.promise(() => batouStatus())
  if (status.status !== "installed" && status.status !== "downloading") beginBatouDownload()
})

const updateMcp = Effect.fn("Extension.updateMcp")(function* (
  manifest: Extension.Manifest,
  contributions: ReadonlyArray<Extension.Mcp>,
  result: ExtensionRuntime.UpdateResult,
  input: Extension.Update,
) {
  const activation = yield* ExtensionRuntime.Service
  const mcp = yield* MCP.Service
  const revision = result.desired.revision
  const instance = yield* Effect.serviceOption(InstanceRef)
  const directory = Option.isSome(instance) ? instance.value?.directory : undefined
  const context = {
    operationID: input.operationID ?? `extension-${revision}`,
    extensionID: manifest.id,
    revision,
    enabled: result.desired.enabled,
    connect: input.connect === true,
    contributions: contributions.map((contribution) => contribution.id),
    ...(directory ? { directory } : {}),
  }
  yield* Effect.logInfo("MCP Extension update started", context)
  for (const contribution of contributions) {
    McpIntegration.setRuntimeEnabled(contribution.id, result.desired.enabled)
  }
  const observeCurrent = (status: Extension.RuntimeStatus, detail?: string) =>
    activation
      .desired(manifest.id)
      .pipe(
        Effect.flatMap((desired) =>
          desired?.revision === revision
            ? observe(manifest.id, { revision, status, ...(detail ? { detail: ToolVisibleError.make(detail) } : {}) })
            : Effect.void,
        ),
      )

  if (!result.desired.enabled) {
    yield* observeCurrent("disabled")
    const statuses = yield* mcp
      .status()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logInfo("MCP Extension status lookup canceled during disable", { ...context, cause }).pipe(
            Effect.as({} as Record<string, MCP.Status>),
          ),
        ),
      )
    for (const contribution of contributions) {
      if (!(contribution.id in statuses)) continue
      yield* mcp.disconnect(contribution.id).pipe(
        Effect.tap(() =>
          Effect.logInfo("MCP Extension contribution disconnected", { ...context, contributionID: contribution.id }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("MCP Extension contribution disconnect failed", {
            ...context,
            contributionID: contribution.id,
            cause,
          }),
        ),
      )
    }
    yield* mcp.reset().pipe(
      Effect.tap(() => Effect.logInfo("MCP Extension current runtime reset", context)),
      Effect.catchCause((cause) =>
        Effect.logError("MCP Extension current runtime reset failed", { ...context, cause }),
      ),
    )
    yield* Effect.logInfo("MCP Extension sibling runtimes tombstoned", context)
    yield* Effect.logInfo("MCP Extension update completed", { ...context, status: "disabled" })
    return
  }

  yield* observeCurrent("connecting")
  const configuration = result.desired.configuration
  const missingConfiguration = missingMcpConfiguration(contributions, configuration)
  if (missingConfiguration) {
    yield* observeCurrent("needs-config", `${missingConfiguration.label} is required`)
    yield* Effect.logInfo("MCP Extension update requires configuration", {
      ...context,
      fieldID: missingConfiguration.id,
    })
    return
  }

  const declaredSecrets = contributions.flatMap((contribution) => contribution.secrets)
  const secrets = Object.fromEntries(
    yield* Effect.forEach(declaredSecrets, (secret) =>
      activation.secret(manifest.id, secret.id).pipe(Effect.map((value) => [secret.id, value] as const)),
    ),
  )
  const missingSecret = declaredSecrets.find((secret) => secret.required && !secrets[secret.id])
  if (missingSecret) {
    yield* observeCurrent("needs-auth", `${missingSecret.label} is required`)
    yield* Effect.logInfo("MCP Extension update requires a declared secret", { ...context, secretID: missingSecret.id })
    return
  }

  const reconcile = Effect.gen(function* () {
    const results: Array<{ id: string; status: MCP.Status }> = []
    for (const contribution of contributions) {
      const id = contribution.id
      if (contribution.authentication === "client-credentials") {
        yield* observeCurrent("failed", `${id} requires an audited credential adapter`)
        return
      }
      if (McpPackageRuntime.managedPackage(contribution)) {
        yield* observeCurrent("connecting", "Downloading and starting the pinned MCP package")
      }
      const entry = yield* McpIntegration.configuration(id, configuration, secrets)
      if (!entry) {
        yield* observeCurrent("failed", `${id} is unavailable on this server`)
        return
      }
      const current = yield* mcp.configuration(id)
      const command = id === "onepassword" ? yield* McpIntegration.resolveOnePasswordCommand() : undefined
      if (current && !McpIntegration.matches(id, current, command)) {
        yield* observeCurrent("failed", `Conflicting MCP runtime configuration: ${id}`)
        return
      }

      const added = yield* mcp.add(id, McpIntegration.mark(id, entry))
      results.push({ id, status: added.candidate })
    }
    if (results.every((item) => item.status.status === "connected")) {
      yield* observeCurrent("connected")
      return
    }
    const authorization = results.filter(
      (item) => item.status.status === "needs_auth" || item.status.status === "needs_client_registration",
    )
    if (authorization.length > 0) {
      yield* observeCurrent("needs-auth")
      // Enabling admits the integration; connecting is an explicit follow-up action.
      // Keep provider discovery and browser activation out of the Enable click.
      if (!input.connect) return
      const exits = yield* Effect.forEach(authorization, (item) => mcp.authenticate(item.id).pipe(Effect.exit), {
        concurrency: "unbounded",
      })
      const status = mcpRuntimeObservation(
        exits.map((exit) =>
          Exit.isSuccess(exit) ? exit.value : { status: "failed", error: "OAuth connection failed" },
        ),
      )
      yield* observeCurrent(status.status, status.detail)
      return
    }
    const failed = results.find((item) => item.status.status === "failed")
    yield* observeCurrent(
      "failed",
      failed?.status.status === "failed" ? failed.status.error : "One or more MCP contributions could not be connected",
    )
    return
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.logInfo("MCP Extension reconciliation canceled", context)
        : observeCurrent("failed", "MCP reconciliation failed").pipe(
            Effect.andThen(Effect.logError("MCP Extension reconciliation failed", { ...context, cause })),
          ),
    ),
  )
  yield* mcp.runBackground(
    `extension:${manifest.id}`,
    reconcile.pipe(
      Effect.tap(() => Effect.logInfo("MCP Extension reconciliation completed", context)),
      Effect.catchCause((cause) => Effect.logError("MCP Extension background task failed", { ...context, cause })),
    ),
  )
  yield* Effect.logInfo("MCP Extension reconciliation scheduled", context)
})

export const update = Effect.fn("Extension.update")(function* (
  id: string,
  input: Extension.Update,
  admission?: { readonly local: boolean },
) {
  return yield* updateLock(id).withPermit(
    Effect.gen(function* () {
      const activation = yield* ExtensionRuntime.Service
      const manifest = input.manifest ?? (yield* activation.get(id))
      if (!manifest) return yield* Effect.die(`Extension not found: ${id}`)
      const contribution = manifest.contributions[0]
      if (!contribution) return yield* Effect.die(`Extension has no contributions: ${id}`)
      if (String(manifest.id) !== id) {
        return yield* new ExtensionRuntime.InvalidUpdate({
          id,
          reason: `Route id does not match manifest id ${manifest.id}`,
        })
      }
      const operationID = input.operationID ?? "extension-untracked"
      yield* Effect.logInfo("Extension activation update started", {
        operationID,
        extensionID: manifest.id,
        enabled: input.enabled,
        connect: input.connect === true,
      })
      const installManifest = input.manifest
      if (installManifest) {
        const scan = yield* Effect.tryPromise({
          try: () => Vigil.scanManifest(installManifest),
          catch: (error) =>
            new ExtensionRuntime.InvalidUpdate({
              id: manifest.id,
              reason: `Vigil scan failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })
        const blockReason = Vigil.blockReason(scan)
        if (blockReason) {
          return yield* new ExtensionRuntime.InvalidUpdate({
            id: manifest.id,
            reason: blockReason,
          })
        }
        if (scan) {
          yield* Effect.logInfo("Vigil skill scan passed", {
            operationID,
            extensionID: manifest.id,
            score: scan.maliciousProbability,
            threshold: scan.threshold,
            reviewed: scan.reviewed,
          })
        }
      }
      const result = yield* activation.update(manifest.id, input, admission)
      McpIntegration.sync(yield* activation.manifests())
      yield* Effect.logInfo("Extension activation update completed", {
        operationID,
        extensionID: manifest.id,
        revision: result.desired.revision,
        changed: result.changed,
      })
      const security = securityID(contribution.adapter)
      if (security) {
        yield* updateSecurityExtension(security, input, result)
      } else {
        const curated = manifest.contributions.filter(
          (item): item is Extension.Mcp => item.type === "mcp" && mcpID(item.adapter) !== undefined,
        )
        if (curated.length === manifest.contributions.length) {
          yield* updateMcp(manifest, curated, result, input)
        } else if (result.changed) {
          yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
        }
      }
      return yield* list()
    }),
  )
})
