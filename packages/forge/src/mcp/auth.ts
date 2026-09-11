import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Storage } from "@turenlabs/core/storage"
import { createHash } from "node:crypto"
import path from "path"
import { serviceUse } from "@turenlabs/core/effect/service-use"
import { Global } from "@turenlabs/core/global"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { FSUtil } from "@turenlabs/core/fs-util"
import { SecretVault } from "@turenlabs/core/secret-vault"

export const Tokens = Schema.Struct({
  accessToken: Schema.mutableKey(Schema.String),
  refreshToken: Schema.mutableKey(Schema.optional(Schema.String)),
  expiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  scope: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Tokens = Schema.Schema.Type<typeof Tokens>

export const ClientInfo = Schema.Struct({
  clientId: Schema.mutableKey(Schema.String),
  clientSecret: Schema.mutableKey(Schema.optional(Schema.String)),
  clientIdIssuedAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  clientSecretExpiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
})
export type ClientInfo = Schema.Schema.Type<typeof ClientInfo>

export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String)),
  oauthState: Schema.mutableKey(Schema.optional(Schema.String)),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Entry = Schema.Schema.Type<typeof Entry>

const DurableEntry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),
  generation: Schema.mutableKey(Schema.optional(Schema.String)),
})
type DurableEntry = Schema.Schema.Type<typeof DurableEntry>

const decodeLegacyAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry))
const decodeAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, DurableEntry))
type AuthData = Record<string, Entry>
type DurableAuthData = Record<string, DurableEntry>

const filepath = path.join(Global.Path.data, "mcp-auth.json")
const stagingFile = `${filepath}.migrating`
const scope = Storage.Scope.make("internal/mcp-auth/servers")
const key = Storage.Key.make("entries")
const migrationName = "internal-mcp-auth-json-v1"
const migrationVersion = "1"

export interface Interface {
  readonly all: () => Effect.Effect<Record<string, Entry>>
  readonly get: (mcpName: string) => Effect.Effect<Entry | undefined>
  readonly getForUrl: (mcpName: string, serverUrl: string, generation?: string) => Effect.Effect<Entry | undefined>
  /**
   * Starts a credential handoff: always mints a new generation, fencing every
   * provider that still holds the previous one, and discards any half-finished
   * authorization attempt. Only an interactive re-authorization may call this.
   */
  readonly prepareForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<string>
  /**
   * The generation an ordinary connect should use for this server.
   *
   * Reuses the stored generation whenever one exists for the same server, so a
   * connect can never fence a provider another connect is already using, and
   * never wipes an in-flight authorization attempt. Mints (and fences) only when
   * there is nothing stored for this URL, which is the same "these credentials
   * are not ours" case {@link prepareForUrl} handles on a server change.
   */
  readonly generationForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<string>
  readonly set: (mcpName: string, entry: Entry, serverUrl?: string, generation?: string) => Effect.Effect<void>
  readonly remove: (mcpName: string, generation?: string) => Effect.Effect<void>
  readonly updateTokens: (
    mcpName: string,
    tokens: Tokens,
    serverUrl?: string,
    generation?: string,
  ) => Effect.Effect<void>
  readonly updateClientInfo: (
    mcpName: string,
    clientInfo: ClientInfo,
    serverUrl?: string,
    generation?: string,
  ) => Effect.Effect<void>
  readonly updateCodeVerifier: (mcpName: string, codeVerifier: string) => Effect.Effect<void>
  readonly clearCodeVerifier: (mcpName: string) => Effect.Effect<void>
  readonly updateOAuthState: (mcpName: string, oauthState: string) => Effect.Effect<void>
  readonly getOAuthState: (mcpName: string) => Effect.Effect<string | undefined>
  readonly clearOAuthState: (mcpName: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/McpAuth") {}

/**
 * Thrown when a credential write or removal loses to a generation fence: the
 * provider that issued it held a stale generation, or the server URL changed
 * without a {@link Interface.prepareForUrl} handoff. Background connects treat
 * it as advisory (their write is meaningless once fenced) and swallow it;
 * interactive flows let it surface as a persistence failure.
 */
export class FencedError extends Error {
  readonly _tag = "McpAuth.FencedError"
}

/** Credential material belonging to a stored entry, for log/error redaction. */
export function secrets(entry: Entry | undefined): string[] {
  return [entry?.tokens?.accessToken, entry?.tokens?.refreshToken, entry?.clientInfo?.clientSecret].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const storage = yield* Storage.Service
    const vault = yield* SecretVault.Service
    const attempts = new Map<string, Pick<Entry, "codeVerifier" | "oauthState">>()

    const legacy = { pending: yield* importLegacy(storage, fs, vault) }
    yield* readStorage(storage, vault)
    if (!legacy.pending) yield* removeLegacy(fs, storage, vault)

    const read = Effect.fn("McpAuth.read")(function* () {
      if (legacy.pending) {
        legacy.pending = yield* importLegacy(storage, fs, vault)
        if (!legacy.pending) yield* removeLegacy(fs, storage, vault)
      }
      return yield* readStorage(storage, vault)
    })

    const all = Effect.fn("McpAuth.all")(function* () {
      const data = yield* read()
      return Object.fromEntries(
        [...new Set([...Object.keys(data), ...attempts.keys()])].map((mcpName) => [
          mcpName,
          { ...publicEntry(data[mcpName]), ...attempts.get(mcpName) },
        ]),
      )
    })

    const mutate = Effect.fn("McpAuth.mutate")(function* (
      update: (data: DurableAuthData) => DurableAuthData | undefined,
    ) {
      yield* mutateStorage(storage, vault, update)
    })

    const get = Effect.fn("McpAuth.get")(function* (mcpName: string) {
      const data = yield* all()
      return data[mcpName]
    })

    const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (
      mcpName: string,
      serverUrl: string,
      generation?: string,
    ) {
      const data = yield* read()
      const durable = data[mcpName]
      if (generation && durable?.generation !== generation) return undefined
      const entry = { ...publicEntry(durable), ...attempts.get(mcpName) }
      if (!durable && !attempts.has(mcpName)) return undefined
      if (!entry.serverUrl) return undefined
      if (!sameServer(entry.serverUrl, serverUrl)) return undefined
      return entry
    })

    const claimForUrl = Effect.fnUntraced(function* (mcpName: string, serverUrl: string, rotate: boolean) {
      const minted = crypto.randomUUID()
      // `mutate` re-runs its update on a storage revision conflict, so both branches
      // assign on every pass rather than relying on the first one.
      let generation: string = minted
      let fenced = true
      yield* mutate((data) => {
        const current = data[mcpName]
        const compatible = current?.serverUrl !== undefined && sameServer(current.serverUrl, serverUrl)
        if (!rotate && compatible && current?.generation) {
          // Nothing to persist: the stored generation already addresses this server,
          // and reusing it is what lets several connects share one credential slot.
          generation = current.generation
          fenced = false
          return undefined
        }
        generation = minted
        fenced = true
        // Persist the handoff before network work. Same-URL reauthentication retains
        // credentials until commit while the new generation fences the old provider.
        return { ...data, [mcpName]: { ...(compatible ? current : undefined), serverUrl, generation } }
      })
      // Only a real handoff discards the PKCE verifier and CSRF state of an attempt in
      // flight; a connect that merely reuses the generation must leave them alone.
      if (fenced) attempts.delete(mcpName)
      return generation
    })

    const prepareForUrl = Effect.fn("McpAuth.prepareForUrl")(function* (mcpName: string, serverUrl: string) {
      return yield* claimForUrl(mcpName, serverUrl, true)
    })

    const generationForUrl = Effect.fn("McpAuth.generationForUrl")(function* (mcpName: string, serverUrl: string) {
      return yield* claimForUrl(mcpName, serverUrl, false)
    })

    const set = Effect.fn("McpAuth.set")(function* (
      mcpName: string,
      entry: Entry,
      serverUrl?: string,
      generation?: string,
    ) {
      const target = serverUrl ?? entry.serverUrl
      yield* mutate((data) => {
        const current = data[mcpName]
        if (generation && current?.generation !== generation) {
          throw new FencedError(`Discarded stale OAuth credential update for ${mcpName}`)
        }
        if (target && current?.serverUrl && !sameServer(current.serverUrl, target)) {
          throw new FencedError(`OAuth server change for ${mcpName} was not prepared`)
        }
        return {
          ...data,
          [mcpName]: {
            ...durableEntry(target ? { ...entry, serverUrl: target } : entry),
            generation: generation ?? current?.generation,
          },
        }
      })
      setAttempt(attempts, mcpName, entry)
    })

    const remove = Effect.fn("McpAuth.remove")(function* (mcpName: string, generation?: string) {
      yield* mutate((data) => {
        if (generation && data[mcpName]?.generation !== generation) {
          throw new FencedError(`Discarded stale OAuth credential removal for ${mcpName}`)
        }
        const next = { ...data }
        delete next[mcpName]
        return next
      })
      attempts.delete(mcpName)
    })

    const updateField = <K extends "tokens" | "clientInfo">(field: K, spanName: string) =>
      Effect.fn(`McpAuth.${spanName}`)(function* (
        mcpName: string,
        value: NonNullable<Entry[K]>,
        serverUrl?: string,
        generation?: string,
      ) {
        yield* mutate((data) => {
          const current = data[mcpName]
          if (generation && current?.generation !== generation) {
            throw new FencedError(`Discarded stale OAuth credential update for ${mcpName}`)
          }
          if (serverUrl && current && (!current.serverUrl || !sameServer(current.serverUrl, serverUrl))) {
            throw new FencedError(`Discarded stale OAuth credential update for ${mcpName}`)
          }
          const entry = { ...current, [field]: value }
          return {
            ...data,
            [mcpName]: serverUrl ? { ...entry, serverUrl, generation: generation ?? current?.generation } : entry,
          }
        })
      })

    const updateTokens = updateField("tokens", "updateTokens")
    const updateClientInfo = updateField("clientInfo", "updateClientInfo")
    const updateCodeVerifier = Effect.fn("McpAuth.updateCodeVerifier")(function* (
      mcpName: string,
      codeVerifier: string,
    ) {
      setAttempt(attempts, mcpName, { ...attempts.get(mcpName), codeVerifier })
    })
    const updateOAuthState = Effect.fn("McpAuth.updateOAuthState")(function* (mcpName: string, oauthState: string) {
      setAttempt(attempts, mcpName, { ...attempts.get(mcpName), oauthState })
    })
    const clearCodeVerifier = Effect.fn("McpAuth.clearCodeVerifier")(function* (mcpName: string) {
      const attempt = attempts.get(mcpName)
      setAttempt(attempts, mcpName, { ...attempt, codeVerifier: undefined })
    })
    const clearOAuthState = Effect.fn("McpAuth.clearOAuthState")(function* (mcpName: string) {
      const attempt = attempts.get(mcpName)
      setAttempt(attempts, mcpName, { ...attempt, oauthState: undefined })
    })

    const getOAuthState = Effect.fn("McpAuth.getOAuthState")(function* (mcpName: string) {
      const entry = yield* get(mcpName)
      return entry?.oauthState
    })

    return Service.of({
      all,
      get,
      getForUrl,
      prepareForUrl,
      generationForUrl,
      set,
      remove,
      updateTokens,
      updateClientInfo,
      updateCodeVerifier,
      clearCodeVerifier,
      updateOAuthState,
      getOAuthState,
      clearOAuthState,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Storage.node, SecretVault.node],
})

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function parse(content: string): DurableAuthData | undefined {
  const json = decodeJson(content)
  if (Option.isNone(json)) return undefined
  return Option.getOrUndefined(decodeAuthData(json.value))
}

function parseLegacy(content: string): AuthData | undefined {
  const json = decodeJson(content)
  if (Option.isNone(json)) return undefined
  return Option.getOrUndefined(decodeLegacyAuthData(json.value))
}

// Only folds differences that cannot change which server is addressed: scheme
// and host casing, and the default port. Path casing, trailing slashes, query
// strings and embedded credentials all stay significant, so anything that
// might be a different server, tenant or principal simply fails to match and
// re-authenticates instead of borrowing someone else's tokens.
function canonicalServerUrl(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    if (!parsed.hostname) return undefined
    const credentials = parsed.username || parsed.password ? `${parsed.username}:${parsed.password}@` : ""
    return `${parsed.protocol}//${credentials}${parsed.host}${parsed.pathname}${parsed.search}`
  } catch {
    return undefined
  }
}

function sameServer(stored: string, requested: string) {
  if (stored === requested) return true
  const canonical = canonicalServerUrl(stored)
  return canonical !== undefined && canonical === canonicalServerUrl(requested)
}

function durableEntry(entry: Entry): DurableEntry {
  return {
    tokens: entry.tokens,
    clientInfo: entry.clientInfo,
    serverUrl: entry.serverUrl,
  }
}

function publicEntry(entry: DurableEntry | undefined): Entry | undefined {
  if (!entry) return undefined
  return {
    tokens: entry.tokens,
    clientInfo: entry.clientInfo,
    serverUrl: entry.serverUrl,
  }
}

function setAttempt(
  attempts: Map<string, Pick<Entry, "codeVerifier" | "oauthState">>,
  mcpName: string,
  entry: Pick<Entry, "codeVerifier" | "oauthState">,
) {
  if (!entry.codeVerifier && !entry.oauthState) {
    attempts.delete(mcpName)
    return
  }
  attempts.set(mcpName, { codeVerifier: entry.codeVerifier, oauthState: entry.oauthState })
}

function mutateStorage(
  storage: Storage.Interface,
  vault: SecretVault.Interface,
  update: (data: DurableAuthData) => DurableAuthData | undefined,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const current = yield* storage.get({ scope, key })
    const next = update(current ? yield* decodeStored(vault, current.value) : {})
    if (!next) return
    const value = yield* vault.seal(scope, key, JSON.stringify(next))
    yield* storage
      .compareAndSwap({
        scope,
        key,
        value,
        expectedRevision: current?.revision ?? null,
      })
      .pipe(Effect.catchTag("Storage.RevisionConflict", () => mutateStorage(storage, vault, update)))
  }).pipe(Effect.asVoid)
}

function readStorage(storage: Storage.Interface, vault: SecretVault.Interface): Effect.Effect<DurableAuthData> {
  return Effect.gen(function* () {
    const stored = yield* storage.get({ scope, key })
    if (!stored) return {}
    const data = yield* decodeStored(vault, stored.value)
    if (vault.isSealed(stored.value)) return data
    return yield* storage
      .compareAndSwap({
        scope,
        key,
        value: yield* vault.seal(scope, key, JSON.stringify(data)),
        expectedRevision: stored.revision,
      })
      .pipe(
        Effect.as(data),
        Effect.catchTag("Storage.RevisionConflict", () => readStorage(storage, vault)),
      )
  }).pipe(Effect.withSpan("McpAuth.readStorage"))
}

const decodeStored = Effect.fn("McpAuth.decodeStored")(function* (vault: SecretVault.Interface, value: string) {
  const plaintext = vault.isSealed(value) ? yield* vault.open(scope, key, value) : value
  const data = parse(plaintext)
  if (data) return data
  return yield* Effect.die(new Error("Stored MCP auth data is invalid"))
})

const importLegacy = Effect.fn("McpAuth.importLegacy")(function* (
  storage: Storage.Interface,
  fs: FSUtil.Interface,
  vault: SecretVault.Interface,
) {
  if (yield* storage.migrationReceipt(migrationName)) return false
  const staged = yield* fs.exists(stagingFile).pipe(Effect.catch(() => Effect.succeed(false)))
  if (!staged) {
    const renamed = yield* fs.rename(filepath, stagingFile).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!renamed) return true
  }
  const content = yield* fs.readFileStringSafe(stagingFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (content === undefined) return true
  const data = parseLegacy(content)
  if (!data) return true
  const imported = Object.fromEntries(Object.entries(data).map(([name, entry]) => [name, durableEntry(entry)]))
  // Existing sealed entries are authoritative. Copy only aliases that do not
  // already exist so migration never combines credentials from two principals.
  yield* mutateStorage(storage, vault, (current) => {
    const next = { ...imported, ...current }
    return Object.keys(imported).some((name) => !(name in current)) ? next : undefined
  })
  yield* storage
    .importEntries(
      {
        name: migrationName,
        sourceFingerprint: createHash("sha256").update(content).digest("hex"),
        sourceVersion: migrationVersion,
      },
      [],
    )
    .pipe(Effect.catchTag("Storage.MigrationConflict", () => Effect.void))
  return false
})

function removeLegacy(fs: FSUtil.Interface, storage: Storage.Interface, vault: SecretVault.Interface) {
  return Effect.gen(function* () {
    const staged = yield* fs.exists(stagingFile).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!staged) return
    const content = yield* fs.readFileStringSafe(stagingFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content === undefined) return yield* restoreLegacy(fs, stagingFile, filepath)
    const source = parseLegacy(content)
    const receipt = yield* storage.migrationReceipt(migrationName)
    const stored = yield* storage.get({ scope, key })
    if (
      !source ||
      !receipt ||
      receipt.sourceFingerprint !== createHash("sha256").update(content).digest("hex") ||
      !stored
    )
      return yield* restoreLegacy(fs, stagingFile, filepath)
    const destination = yield* decodeStored(vault, stored.value)
    if (!Object.keys(source).every((name) => name in destination))
      return yield* restoreLegacy(fs, stagingFile, filepath)
    yield* fs.remove(stagingFile).pipe(Effect.catch(() => Effect.void))
  })
}

function restoreLegacy(fs: FSUtil.Interface, staging: string, target: string) {
  return fs.exists(target).pipe(
    Effect.flatMap((exists) => (exists ? Effect.void : fs.rename(staging, target))),
    Effect.catch(() => Effect.void),
  )
}

export * as McpAuth from "./auth"
