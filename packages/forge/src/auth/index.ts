import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Storage } from "@turenlabs/core/storage"
import { createHash, randomUUID } from "node:crypto"
import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { NonNegativeInt } from "@turenlabs/core/schema"
import { Global } from "@turenlabs/core/global"
import { FSUtil } from "@turenlabs/core/fs-util"
import { SecretVault } from "@turenlabs/core/secret-vault"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const scope = Storage.Scope.make("internal/auth/providers")
const key = Storage.Key.make("credentials")
const migrationName = "internal-auth-json-v1"
const migrationVersion = "1"
const vaultScope = Storage.Scope.make("internal/secret-vault")
const vaultKey = Storage.Key.make("active-key-id")

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly replaceOAuth: (key: string, expected: Oauth, info: Oauth) => Effect.Effect<boolean, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@forge/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const storage = yield* Storage.Service
    const vault = yield* SecretVault.Service
    yield* claimVault(storage, vault)

    const legacy = { pending: yield* importLegacy(storage, fsys, vault) }
    yield* read(storage, vault).pipe(Effect.orDie)
    if (!legacy.pending) yield* removeLegacy(fsys, storage, vault)

    const all = Effect.fn("Auth.all")(function* () {
      if (legacy.pending) {
        legacy.pending = yield* importLegacy(storage, fsys, vault)
        if (!legacy.pending) yield* removeLegacy(fsys, storage, vault)
      }
      const overridden = process.env.FORGE_AUTH_CONTENT ? parse(process.env.FORGE_AUTH_CONTENT) : undefined
      if (overridden) return overridden
      return yield* read(storage, vault)
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      yield* mutate(storage, vault, (data) => {
        const next = { ...data, [norm]: info }
        delete next[key]
        delete next[norm + "/"]
        next[norm] = info
        return next
      })
    })

    const replaceOAuth = Effect.fn("Auth.replaceOAuth")(function* (key: string, expected: Oauth, info: Oauth) {
      if (process.env.FORGE_AUTH_CONTENT && parse(process.env.FORGE_AUTH_CONTENT)) return false
      return yield* replaceStoredOAuth(storage, vault, key.replace(/\/+$/, ""), expected, info)
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      yield* mutate(storage, vault, (data) => {
        const next = { ...data }
        delete next[key]
        delete next[norm]
        delete next[norm + "/"]
        return next
      })
    })

    return Service.of({ get, all, set, replaceOAuth, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Storage.node, SecretVault.node],
})

type AuthData = Record<string, Info>

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeInfo = Schema.decodeUnknownOption(Info)
const decodeAuthData = Schema.decodeUnknownOption(Schema.Record(Schema.String, Info))

function parse(content: string): AuthData | undefined {
  const decoded = decodeJson(content)
  if (
    Option.isNone(decoded) ||
    typeof decoded.value !== "object" ||
    decoded.value === null ||
    Array.isArray(decoded.value)
  ) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(decoded.value).flatMap(([name, value]) => {
      const info = decodeInfo(value)
      return Option.isSome(info) ? [[name, info.value] as const] : []
    }),
  )
}

function parseLegacy(content: string): AuthData | undefined {
  const decoded = decodeJson(content)
  if (Option.isNone(decoded)) return undefined
  return Option.getOrUndefined(decodeAuthData(decoded.value))
}

function read(storage: Storage.Interface, vault: SecretVault.Interface): Effect.Effect<AuthData, AuthError> {
  return Effect.gen(function* () {
    const stored = yield* storage.get({ scope, key })
    if (!stored) return {}
    const data = yield* decodeStored(vault, stored.value)
    if (vault.isSealed(stored.value)) return data
    const value = yield* seal(vault, JSON.stringify(data))
    return yield* storage.compareAndSwap({ scope, key, value, expectedRevision: stored.revision }).pipe(
      Effect.as(data),
      Effect.catchTag("Storage.RevisionConflict", () => read(storage, vault)),
    )
  }).pipe(Effect.withSpan("Auth.read"))
}

function mutate(
  storage: Storage.Interface,
  vault: SecretVault.Interface,
  update: (data: AuthData) => AuthData,
): Effect.Effect<void, AuthError> {
  return Effect.gen(function* () {
    const current = yield* storage.get({ scope, key })
    const data = current ? yield* decodeStored(vault, current.value) : {}
    const value = yield* seal(vault, JSON.stringify(update(data)))
    yield* storage
      .compareAndSwap({ scope, key, value, expectedRevision: current?.revision ?? null })
      .pipe(Effect.catchTag("Storage.RevisionConflict", () => mutate(storage, vault, update)))
  }).pipe(Effect.asVoid)
}

function replaceStoredOAuth(
  storage: Storage.Interface,
  vault: SecretVault.Interface,
  providerKey: string,
  expected: Oauth,
  info: Oauth,
): Effect.Effect<boolean, AuthError> {
  return Effect.gen(function* () {
    const current = yield* storage.get({ scope, key })
    const data = current ? yield* decodeStored(vault, current.value) : {}
    const stored = data[providerKey]
    if (stored?.type !== "oauth" || !sameOAuth(stored, expected)) return false
    const value = yield* seal(vault, JSON.stringify({ ...data, [providerKey]: info }))
    return yield* storage.compareAndSwap({ scope, key, value, expectedRevision: current?.revision ?? null }).pipe(
      Effect.as(true),
      Effect.catchTag("Storage.RevisionConflict", () =>
        replaceStoredOAuth(storage, vault, providerKey, expected, info),
      ),
    )
  })
}

function sameOAuth(left: Oauth, right: Oauth) {
  return (
    left.refresh === right.refresh &&
    left.access === right.access &&
    left.expires === right.expires &&
    left.accountId === right.accountId &&
    left.enterpriseUrl === right.enterpriseUrl
  )
}

const decodeStored = Effect.fn("Auth.decodeStored")(function* (vault: SecretVault.Interface, value: string) {
  const plaintext = vault.isSealed(value) ? yield* vault.open(scope, key, value) : value
  const data = parseLegacy(plaintext)
  if (data) return data
  return yield* Effect.fail(new AuthError({ message: "Stored auth data is invalid" }))
})

function seal(vault: SecretVault.Interface, value: string) {
  return vault.seal(scope, key, value)
}

const importLegacy = Effect.fn("Auth.importLegacy")(function* (
  storage: Storage.Interface,
  fsys: FSUtil.Interface,
  vault: SecretVault.Interface,
) {
  if (yield* storage.migrationReceipt(migrationName)) return false
  const content = yield* fsys.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (content === undefined) return true
  const data = parseLegacy(content)
  if (!data) return true
  yield* storage
    .importEntries(
      {
        name: migrationName,
        sourceFingerprint: createHash("sha256").update(content).digest("hex"),
        sourceVersion: migrationVersion,
      },
      [{ scope, key, value: yield* seal(vault, JSON.stringify(data)) }],
    )
    .pipe(Effect.catchTag("Storage.MigrationConflict", () => Effect.void))
  return false
})

function removeLegacy(fsys: FSUtil.Interface, storage: Storage.Interface, vault: SecretVault.Interface) {
  return Effect.gen(function* () {
    const staging = `${file}.migrating-${process.pid}-${randomUUID()}`
    const renamed = yield* fsys.rename(file, staging).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!renamed) return
    const content = yield* fsys.readFileStringSafe(staging).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content === undefined) return yield* restoreLegacy(fsys, staging, file)
    const source = parseLegacy(content)
    const stored = yield* storage.get({ scope, key })
    if (!source || !stored) return yield* restoreLegacy(fsys, staging, file)
    const destination = yield* decodeStored(vault, stored.value).pipe(Effect.orDie)
    if (!Object.entries(source).every(([name, value]) => JSON.stringify(destination[name]) === JSON.stringify(value)))
      return yield* restoreLegacy(fsys, staging, file)
    yield* fsys.remove(staging).pipe(Effect.catch(() => Effect.void))
  })
}

function restoreLegacy(fsys: FSUtil.Interface, staging: string, target: string) {
  return fsys.exists(target).pipe(
    Effect.flatMap((exists) => (exists ? Effect.void : fsys.rename(staging, target))),
    Effect.catch(() => Effect.void),
  )
}

function claimVault(storage: Storage.Interface, vault: SecretVault.Interface): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stored = yield* storage.get({ scope: vaultScope, key: vaultKey })
    if (stored?.value === vault.keyID) return
    if (stored) return yield* Effect.die(new Error("Stored credentials belong to another OS-protected key"))
    yield* storage
      .compareAndSwap({ scope: vaultScope, key: vaultKey, value: vault.keyID, expectedRevision: null })
      .pipe(
        Effect.asVoid,
        Effect.catchTag("Storage.RevisionConflict", () => claimVault(storage, vault)),
      )
  })
}

export * as Auth from "."
