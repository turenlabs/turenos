import { describe, expect, test } from "bun:test"
import { loadCredentialSecretKey } from "./secret-key"

function fixture(backend = "keychain") {
  const values = new Map<string, unknown>()
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`wrapped:${value}`),
    decryptString: (value: Buffer) => value.toString().slice("wrapped:".length),
    getSelectedStorageBackend: () => backend,
  }
  const store = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  }
  return { values, storage, store }
}

describe("credential secret key", () => {
  test("creates one OS-wrapped key and reuses it", () => {
    const context = fixture()
    const first = loadCredentialSecretKey(context.store, context.storage, "darwin")
    const second = loadCredentialSecretKey(context.store, context.storage, "darwin")

    expect(first.key).toBeInstanceOf(Uint8Array)
    expect(first.key.byteLength).toBe(32)
    expect(second).toEqual(first)
    expect(JSON.stringify([...context.values.values()][0])).not.toContain(Buffer.from(first.key).toString("base64"))
  })

  test("accepts only encrypted Linux backends", () => {
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      const context = fixture(backend)
      expect(loadCredentialSecretKey(context.store, context.storage, "linux").key.byteLength).toBe(32)
    }

    for (const backend of ["basic_text", "unknown", "keychain", ""]) {
      const context = fixture(backend)
      expect(() => loadCredentialSecretKey(context.store, context.storage, "linux")).toThrow("not encrypted")
    }
  })

  test("fails closed when OS encryption is unavailable", () => {
    const context = fixture()
    expect(() =>
      loadCredentialSecretKey(context.store, { ...context.storage, isEncryptionAvailable: () => false }, "darwin"),
    ).toThrow("not available")
    expect(context.values.size).toBe(0)
  })

  test("rejects corrupt records without overwriting them", () => {
    const context = fixture()
    const corrupt = { version: 1, keyID: "not-an-id", wrappedKey: "not-base64" }
    context.values.set("credential-secret-key", corrupt)

    expect(() => loadCredentialSecretKey(context.store, context.storage, "darwin")).toThrow("invalid")
    expect(context.values.get("credential-secret-key")).toBe(corrupt)
  })
})
