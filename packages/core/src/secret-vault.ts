export * as SecretVault from "./secret-vault"

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"

const FORMAT = "forge-secret"
const VERSION = "v1"
const PREFIX = `${FORMAT}:${VERSION}:`
const MAX_VALUE_BYTES = 1024 * 1024
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const HKDF_SALT = Buffer.from("forge-secret:v1:hkdf-salt", "utf8")
const HKDF_INFO = Buffer.from("forge-secret:v1:scope-key", "utf8")

export class Error extends Schema.TaggedErrorClass<Error>()("SecretVault.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly keyID: string
  readonly seal: (scope: string, key: string, value: string) => Effect.Effect<string>
  readonly open: (scope: string, key: string, value: string) => Effect.Effect<string>
  readonly sealBytes: (scope: string, key: string, value: Uint8Array) => Effect.Effect<string>
  readonly openBytes: (scope: string, key: string, value: string) => Effect.Effect<Uint8Array>
  readonly isSealed: (value: string) => boolean
}

export class Service extends Context.Service<Service, Interface>()("@forge/SecretVault") {}

export type Key = { readonly keyID: string; readonly key: Uint8Array }

export const layer = (options: Key) => {
  if (!KEY_ID.test(options.keyID) || options.key.byteLength !== 32)
    throw new globalThis.Error("Secret vault configuration is invalid")
  return Layer.succeed(Service, Service.of(make(options)))
}

function make(options: Key): Interface {
  const root = Buffer.from(options.key)
  const sealBytes = (scope: string, key: string, value: Uint8Array) =>
    Effect.try({
      try: () => {
        if (value.byteLength > MAX_VALUE_BYTES) throw new Error({ message: "Secret exceeds maximum size" })
        const nonce = randomBytes(NONCE_BYTES)
        const cipher = createCipheriv("aes-256-gcm", deriveScopeKey(root, scope), nonce, { authTagLength: TAG_BYTES })
        cipher.setAAD(aad(options.keyID, scope, key))
        const ciphertext = Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()])
        return `${PREFIX}${options.keyID}:${nonce.toString("base64url")}:${ciphertext.toString("base64url")}`
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error({ message: "Secret could not be sealed" })),
    }).pipe(Effect.orDie)
  const openBytes = (scope: string, key: string, value: string) =>
    Effect.try({
      try: () => {
        const envelope = parse(value)
        if (!envelope || envelope.keyID !== options.keyID) throw new Error({ message: "Secret could not be opened" })
        const payload = Buffer.from(envelope.payload, "base64url")
        const decipher = createDecipheriv("aes-256-gcm", deriveScopeKey(root, scope), envelope.nonce, {
          authTagLength: TAG_BYTES,
        })
        decipher.setAAD(aad(options.keyID, scope, key))
        decipher.setAuthTag(payload.subarray(payload.byteLength - TAG_BYTES))
        return new Uint8Array(
          Buffer.concat([decipher.update(payload.subarray(0, payload.byteLength - TAG_BYTES)), decipher.final()]),
        )
      },
      catch: () => new Error({ message: "Secret could not be opened" }),
    }).pipe(Effect.orDie)
  return {
    keyID: options.keyID,
    seal: (scope, key, value) => sealBytes(scope, key, Buffer.from(value, "utf8")),
    open: (scope, key, value) =>
      openBytes(scope, key, value).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("utf8"))),
    sealBytes,
    openBytes,
    isSealed: (value) => parse(value) !== undefined,
  }
}

const fallback = { keyID: `ephemeral-${randomUUID()}`, key: new Uint8Array(randomBytes(32)) }
const KEY_ID_ENV = "FORGE_SECRET_VAULT_KEY_ID"
const KEY_ENV = "FORGE_SECRET_VAULT_KEY"
let configured: Key | undefined
let current = make(fallback)

/** Installs the process key before shared application graphs are built. */
export function configure(options: Key) {
  if (!KEY_ID.test(options.keyID) || options.key.byteLength !== 32)
    throw new Error({ message: "Secret vault configuration is invalid" })
  if (configured) {
    if (configured.keyID !== options.keyID || !Buffer.from(configured.key).equals(Buffer.from(options.key)))
      throw new Error({ message: "Secret vault is already configured with another key" })
    return
  }
  configured = { keyID: options.keyID, key: new Uint8Array(options.key) }
  current = make(configured)
}

export const seal = (scope: string, key: string, value: string) => current.seal(scope, key, value)
export const open = (scope: string, key: string, value: string) => current.open(scope, key, value)
export const sealBytes = (scope: string, key: string, value: Uint8Array) => current.sealBytes(scope, key, value)
export const openBytes = (scope: string, key: string, value: string) => current.openBytes(scope, key, value)
export const isSealed = (value: string) => current.isSealed(value)

export const ephemeral = layer(fallback)

export const runtime = Layer.unwrap(Effect.sync(() => layer(runtimeKey())))

export const node = makeGlobalNode({ service: Service, layer: runtime, deps: [] })

function runtimeKey() {
  if (configured) return configured
  const keyID = process.env[KEY_ID_ENV]
  const encoded = process.env[KEY_ENV]
  delete process.env[KEY_ID_ENV]
  delete process.env[KEY_ENV]
  if (keyID === undefined && encoded === undefined) {
    if (process.env.NODE_ENV === "test") return fallback
    throw new globalThis.Error("Persistent secret storage requires an OS-protected key")
  }
  const key = encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0)
  if (!keyID || key.byteLength !== 32 || key.toString("base64") !== encoded)
    throw new globalThis.Error("Secret vault environment configuration is invalid")
  configure({ keyID, key })
  return configured!
}

function deriveScopeKey(root: Uint8Array, scope: string) {
  return Buffer.from(hkdfSync("sha256", root, HKDF_SALT, lengthPrefixed([HKDF_INFO, Buffer.from(scope, "utf8")]), 32))
}

function aad(keyID: string, scope: string, key: string) {
  return lengthPrefixed([FORMAT, VERSION, keyID, scope, key].map((value) => Buffer.from(value, "utf8")))
}

function lengthPrefixed(values: readonly Uint8Array[]) {
  return Buffer.concat(
    values.flatMap((value) => {
      const length = Buffer.allocUnsafe(4)
      length.writeUInt32BE(value.byteLength)
      return [length, Buffer.from(value)]
    }),
  )
}

function parse(value: string) {
  if (!value.startsWith(PREFIX)) return undefined
  const parts = value.split(":")
  if (parts.length !== 5 || parts[0] !== FORMAT || parts[1] !== VERSION || !KEY_ID.test(parts[2]!)) return undefined
  if (!canonicalBase64url(parts[3]!, NONCE_BYTES)) return undefined
  if (!BASE64URL.test(parts[4]!) || parts[4]!.length > Math.ceil(((MAX_VALUE_BYTES + TAG_BYTES) * 4) / 3))
    return undefined
  const payload = Buffer.from(parts[4]!, "base64url")
  if (payload.byteLength < TAG_BYTES || payload.byteLength > MAX_VALUE_BYTES + TAG_BYTES) return undefined
  if (payload.toString("base64url") !== parts[4]) return undefined
  return { keyID: parts[2]!, nonce: Buffer.from(parts[3]!, "base64url"), payload: parts[4]! }
}

function canonicalBase64url(value: string, bytes: number) {
  if (!BASE64URL.test(value)) return false
  const decoded = Buffer.from(value, "base64url")
  return decoded.byteLength === bytes && decoded.toString("base64url") === value
}
