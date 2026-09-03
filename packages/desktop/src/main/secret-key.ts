import { randomBytes, randomUUID } from "node:crypto"

const STORE_KEY = "credential-secret-key"
const RECORD_VERSION = 1
const LINUX_BACKENDS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])

type Store = {
  get(key: string): unknown
  set(key: string, value: SecretKeyRecord): void
}

type SafeStorage = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

type SecretKeyRecord = {
  version: 1
  keyID: string
  wrappedKey: string
}

export type CredentialVault = {
  keyID: string
  key: Uint8Array
}

export function loadCredentialSecretKey(
  store: Store,
  safeStorage: SafeStorage,
  platform = process.platform,
): CredentialVault {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Credential storage is unavailable because OS-protected secret storage is not available")

  const backend = platform === "linux" ? safeStorage.getSelectedStorageBackend?.() : undefined
  if (platform === "linux" && (!backend || !LINUX_BACKENDS.has(backend)))
    throw new Error("Credential storage is unavailable because the Linux secret store is not encrypted")

  const stored = store.get(STORE_KEY)
  if (stored !== undefined) return decodeRecord(stored, safeStorage)

  const key = new Uint8Array(randomBytes(32))
  const record: SecretKeyRecord = {
    version: RECORD_VERSION,
    keyID: randomUUID(),
    wrappedKey: safeStorage.encryptString(Buffer.from(key).toString("base64")).toString("base64"),
  }
  store.set(STORE_KEY, record)
  return { keyID: record.keyID, key }
}

function decodeRecord(value: unknown, safeStorage: SafeStorage): CredentialVault {
  if (!isRecord(value)) throw new Error("The OS-protected credential key record is invalid")

  const decrypted = safeStorage.decryptString(Buffer.from(value.wrappedKey, "base64"))
  const key = Buffer.from(decrypted, "base64")
  if (key.byteLength !== 32 || key.toString("base64") !== decrypted)
    throw new Error("The OS-protected credential key record is invalid")
  return { keyID: value.keyID, key: new Uint8Array(key) }
}

function isRecord(value: unknown): value is SecretKeyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3) return false
  if (record.version !== RECORD_VERSION) return false
  if (typeof record.keyID !== "string" || record.keyID.length === 0) return false
  if (typeof record.wrappedKey !== "string" || !isCanonicalBase64(record.wrappedKey)) return false
  return true
}

function isCanonicalBase64(value: string) {
  return value.length > 0 && Buffer.from(value, "base64").toString("base64") === value
}
