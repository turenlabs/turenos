export * as Credential from "./credential"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@turenlabs/schema/credential"
import { Integration } from "@turenlabs/schema/integration"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { Storage } from "./storage"
import { CredentialTable } from "./credential/sql"
import { SecretVault } from "./secret-vault"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Credential") {}

/**
 * Where the v1 `Auth` service persists the contents of `auth.json`. v1 remains the only writer;
 * v2 reads the same rows so a provider the user connected in v1 is usable by the v2 runner.
 */
const LEGACY_SCOPE = Storage.Scope.make("internal/auth/providers")
const LEGACY_KEY = Storage.Key.make("credentials")
const LEGACY_ID_PREFIX = "cred_v1_"
const LEGACY_LABEL = "auth.json"

const legacyID = (integrationID: Integration.ID) => ID.make(`${LEGACY_ID_PREFIX}${integrationID}`)

/**
 * The v2 OAuth method that owns each integration's `auth.json` tokens.
 *
 * v1 and v2 drive the same ChatGPT OAuth application — same issuer, same client ID, same
 * refresh grant — so the v2 method can refresh a token v1 obtained. Naming the real method is
 * load-bearing twice over: it is how the ChatGPT Codex transport recognises the credential as a
 * ChatGPT one, and how `Integration.connection.resolve` finds a `refresh` when the token expires.
 * Both ChatGPT methods share one refresh implementation, so the browser method stands in for a
 * token however it was originally obtained.
 *
 * Integrations absent from this table keep an unmatched `v1:` method, which makes
 * `Integration.connection.resolve` hand back the token as-is rather than attempt a refresh no v2
 * method implements.
 *
 * xAI SuperGrok tokens live in the same `auth.json` store as ChatGPT. Both Grok-CLI OAuth methods
 * share one refresh grant, so the browser method stands in for a token however it was obtained.
 */
const LEGACY_METHOD: ReadonlyMap<string, Integration.MethodID> = new Map([
  ["openai", Integration.MethodID.make("chatgpt-browser")],
  ["xai", Integration.MethodID.make("grok-browser")],
])

const legacyMethodID = (integrationID: Integration.ID) =>
  LEGACY_METHOD.get(integrationID) ?? Integration.MethodID.make(`v1:${integrationID}`)

/** Projects one `auth.json` entry into a v2 credential. Unknown shapes are skipped, not thrown. */
const fromLegacyEntry = (integrationID: Integration.ID, entry: unknown): Info | undefined => {
  if (typeof entry !== "object" || entry === null) return
  const record = entry as Record<string, unknown>
  const make = (value: Value) => new Info({ id: legacyID(integrationID), integrationID, label: LEGACY_LABEL, value })
  if (record.type === "api" && typeof record.key === "string") {
    const metadata =
      typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : undefined
    return make(Key.make({ type: "key", key: record.key, ...(metadata ? { metadata } : {}) }))
  }
  // v1 `wellknown` carries the usable secret in `token`; `key` is the well-known identifier.
  if (record.type === "wellknown" && typeof record.token === "string") {
    return make(Key.make({ type: "key", key: record.token }))
  }
  if (
    record.type === "oauth" &&
    typeof record.refresh === "string" &&
    typeof record.access === "string" &&
    typeof record.expires === "number"
  ) {
    // v1 spells this `accountId`. It becomes the `ChatGPT-Account-Id` header that scopes a Codex
    // request to the right ChatGPT organization, so dropping it 401s on org accounts.
    const accountID = typeof record.accountId === "string" ? record.accountId : undefined
    return make(
      OAuth.make({
        type: "oauth",
        methodID: legacyMethodID(integrationID),
        refresh: record.refresh,
        access: record.access,
        expires: record.expires,
        ...(accountID ? { metadata: { accountID } } : {}),
      }),
    )
  }
  return undefined
}

/**
 * Projects a refreshed v2 credential back into the `auth.json` entry it came from. v1 stays the
 * single store for these tokens — this writes the same key in the same shape rather than copying
 * it into the credential table, so v1 and v2 keep sharing one token and neither goes stale.
 */
const toLegacyEntry = (value: Value): Record<string, unknown> | undefined => {
  if (value.type === "key")
    return { type: "api", key: value.key, ...(value.metadata ? { metadata: value.metadata } : {}) }
  const accountID = typeof value.metadata?.accountID === "string" ? value.metadata.accountID : undefined
  return {
    type: "oauth",
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
    ...(accountID ? { accountId: accountID } : {}),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const storage = yield* Storage.Service
    const vault = yield* SecretVault.Service
    const decode = Schema.decodeUnknownSync(Value)
    const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Value))
    const encodeJson = Schema.encodeSync(Schema.fromJsonString(Value))
    const stored = Effect.fn("Credential.stored")(function* (row: typeof CredentialTable.$inferSelect) {
      if (!row.integration_id) return
      const value =
        typeof row.value === "string"
          ? decodeJson(yield* vault.open("credential", row.id, row.value).pipe(Effect.orDie))
          : decode(row.value)
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value,
      })
    })

    // Existing rows used Drizzle's JSON mode and contain plaintext objects. Encrypt them before
    // the service becomes available; all later writes use the same opaque envelope format.
    yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const rows = yield* tx.select().from(CredentialTable).all()
            yield* Effect.forEach(
              rows.filter((row) => typeof row.value !== "string"),
              (row) =>
                Effect.gen(function* () {
                  const value = decode(row.value)
                  const sealed = yield* vault.seal("credential", row.id, encodeJson(value))
                  yield* tx
                    .update(CredentialTable)
                    .set({ value: sealed })
                    .where(and(eq(CredentialTable.id, row.id), eq(CredentialTable.value, row.value)))
                    .run()
                }),
              { concurrency: 1, discard: true },
            )
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)

    /**
     * Reads `auth.json`-derived credentials live on every call. Nothing is copied into the
     * credential table: v1 stays the single source of truth, so a token v1 refreshes is picked
     * up immediately and there is no stale duplicate to reconcile.
     */
    const legacy = Effect.fn("Credential.legacy")(function* () {
      const state = yield* storage.get({ scope: LEGACY_SCOPE, key: LEGACY_KEY })
      if (!state) return [] as Info[]
      const value = vault.isSealed(state.value)
        ? yield* vault.open(LEGACY_SCOPE, LEGACY_KEY, state.value).pipe(Effect.orDie)
        : state.value
      const parsed = yield* Effect.try({
        try: () => JSON.parse(value) as unknown,
        catch: (cause) => new Error(`Invalid v1 auth payload: ${String(cause)}`),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Ignoring unreadable v1 auth credentials", { cause }).pipe(Effect.as(undefined)),
        ),
      )
      if (typeof parsed !== "object" || parsed === null) return [] as Info[]
      return Object.entries(parsed as Record<string, unknown>).flatMap(([providerID, entry]) => {
        const info = fromLegacyEntry(Integration.ID.make(providerID), entry)
        return info ? [info] : []
      })
    })

    /**
     * Rewrites one `auth.json` entry in place. Read-modify-compare-and-swap so a concurrent v1
     * token refresh cannot be clobbered; on a lost race we re-read and reapply.
     */
    const updateLegacy = (integrationID: Integration.ID, value: Value): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entry = toLegacyEntry(value)
        if (!entry) return
        const current = yield* storage.get({ scope: LEGACY_SCOPE, key: LEGACY_KEY })
        const plaintext = current
          ? vault.isSealed(current.value)
            ? yield* vault.open(LEGACY_SCOPE, LEGACY_KEY, current.value).pipe(Effect.orDie)
            : current.value
          : undefined
        const parsed = current
          ? yield* Effect.try({
              try: () => JSON.parse(plaintext!) as unknown,
              catch: (cause) => new Error(`Invalid v1 auth payload: ${String(cause)}`),
            })
          : undefined
        // Never overwrite a payload we could not read: a v1 credential we do not understand is
        // still the user's only copy of the others.
        if (current && (typeof parsed !== "object" || parsed === null)) return
        const next = yield* vault
          .seal(
            LEGACY_SCOPE,
            LEGACY_KEY,
            JSON.stringify({ ...((parsed as Record<string, unknown>) ?? {}), [integrationID]: entry }),
          )
          .pipe(Effect.orDie)
        yield* storage
          .compareAndSwap({
            scope: LEGACY_SCOPE,
            key: LEGACY_KEY,
            value: next,
            expectedRevision: current?.revision ?? null,
          })
          .pipe(Effect.catchTag("Storage.RevisionConflict", () => updateLegacy(integrationID, value)))
      }).pipe(
        // A failed write-back costs a redundant refresh next time, not a broken session.
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not persist refreshed v1 auth credential", { cause }).pipe(Effect.asVoid),
        ),
      )

    const removeLegacy = (integrationID: Integration.ID): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* storage.get({ scope: LEGACY_SCOPE, key: LEGACY_KEY })
        if (!current) return
        const plaintext = vault.isSealed(current.value)
          ? yield* vault.open(LEGACY_SCOPE, LEGACY_KEY, current.value).pipe(Effect.orDie)
          : current.value
        const parsed = yield* Effect.try({
          try: () => JSON.parse(plaintext) as unknown,
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (typeof parsed !== "object" || parsed === null) return
        const next = { ...(parsed as Record<string, unknown>) }
        if (!(integrationID in next)) return
        delete next[integrationID]
        const value = yield* vault.seal(LEGACY_SCOPE, LEGACY_KEY, JSON.stringify(next)).pipe(Effect.orDie)
        yield* storage
          .compareAndSwap({
            scope: LEGACY_SCOPE,
            key: LEGACY_KEY,
            value,
            expectedRevision: current.revision,
          })
          .pipe(Effect.catchTag("Storage.RevisionConflict", () => removeLegacy(integrationID)))
      }).pipe(Effect.asVoid)

    /** A credential stored in v2 always wins over the v1 projection for the same integration. */
    const withLegacy = (rows: Info[], fallback: Info[]) => {
      const owned = new Set(rows.map((row) => row.integrationID))
      return [...rows, ...fallback.filter((item) => !owned.has(item.integrationID))]
    }

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, stored)),
            Effect.map((rows) => rows.filter((row): row is Info => row !== undefined)),
            Effect.orDie,
          )
        return withLegacy(rows, yield* legacy())
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, stored)),
            Effect.map((rows) => rows.filter((row): row is Info => row !== undefined)),
            Effect.orDie,
          )
        if (rows.length > 0) return rows
        return (yield* legacy()).filter((item) => item.integrationID === integrationID)
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        if (row) return yield* stored(row)
        if (!id.startsWith(LEGACY_ID_PREFIX)) return undefined
        return (yield* legacy()).find((item) => item.id === id)
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        const sealed = yield* vault.seal("credential", credential.id, encodeJson(credential.value)).pipe(Effect.orDie)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: sealed,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        // A v1-projected credential owns no row here. Writing the refreshed token back to
        // `auth.json` is what stops `Integration.connection.resolve` re-refreshing on every call
        // with a refresh token OpenAI has already rotated away.
        if (id.startsWith(LEGACY_ID_PREFIX)) {
          if (updates.value) yield* updateLegacy(Integration.ID.make(id.slice(LEGACY_ID_PREFIX.length)), updates.value)
          return
        }
        const value = updates.value
          ? yield* vault.seal("credential", id, encodeJson(updates.value)).pipe(Effect.orDie)
          : undefined
        yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        if (id.startsWith(LEGACY_ID_PREFIX)) {
          yield* removeLegacy(Integration.ID.make(id.slice(LEGACY_ID_PREFIX.length)))
          return
        }
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Storage.node, SecretVault.node] })
