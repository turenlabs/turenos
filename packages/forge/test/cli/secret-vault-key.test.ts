import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { loadSecretVaultKey } from "@/cli/secret-vault-key"
import { ServerMode } from "@/server/mode"
import { tmpdir } from "../fixture/fixture"

const key = Buffer.alloc(32, 7)
const encodedKey = key.toString("base64")

describe("CLI secret vault key source", () => {
  test("uses the legacy environment bootstrap when no source is selected", async () => {
    expect(
      await loadSecretVaultKey({
        FORGE_SECRET_VAULT_KEY_ID: "server-key",
        FORGE_SECRET_VAULT_KEY: encodedKey,
      }),
    ).toEqual({ keyID: "server-key", key })
  })

  test("keeps quick-connect production startup on its existing runtime bootstrap", async () => {
    expect(await loadSecretVaultKey({ FORGE_SERVER_MODE: "quick-connect", NODE_ENV: "production" })).toBeUndefined()
  })

  test("fails when the systemd credential directory is unavailable", async () => {
    expect(await rejection(loadSecretVaultKey({ FORGE_SECRET_VAULT_KEY_SOURCE: "systemd-credentials" }))).toMatchObject(
      { message: "systemd credential directory is unavailable" },
    )
  })

  test("reads systemd credentials from the configured directory", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "forge-secret-vault-key-id"), "server-key\n")
    await writeFile(path.join(tmp.path, "forge-secret-vault-key"), `${encodedKey}\n`)

    expect(
      await loadSecretVaultKey({
        FORGE_SECRET_VAULT_KEY_SOURCE: "systemd-credentials",
        CREDENTIALS_DIRECTORY: tmp.path,
      }),
    ).toEqual({ keyID: "server-key", key })
  })

  test("removes key variables from process.env in every branch", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "forge-secret-vault-key-id"), "server-key\n")
    await writeFile(path.join(tmp.path, "forge-secret-vault-key"), `${encodedKey}\n`)
    const saved = { ...process.env }
    try {
      process.env.CREDENTIALS_DIRECTORY = tmp.path
      for (const source of ["systemd-credentials", "env"]) {
        process.env.FORGE_SECRET_VAULT_KEY_ID = "env-key"
        process.env.FORGE_SECRET_VAULT_KEY = encodedKey
        await loadSecretVaultKey(process.env, source)
        expect(process.env.FORGE_SECRET_VAULT_KEY_ID).toBeUndefined()
        expect(process.env.FORGE_SECRET_VAULT_KEY).toBeUndefined()
      }
    } finally {
      for (const name of ["CREDENTIALS_DIRECTORY", "FORGE_SECRET_VAULT_KEY_ID", "FORGE_SECRET_VAULT_KEY"])
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
    }
  })

  test("reports persistent credential problems as configuration errors", async () => {
    const env = { FORGE_SERVER_MODE: "persistent", FORGE_SECRET_VAULT_KEY_SOURCE: "systemd-credentials" }
    expect(await rejection(loadSecretVaultKey(env))).toBeInstanceOf(ServerMode.ConfigError)
    expect(await rejection(loadSecretVaultKey({ ...env, CREDENTIALS_DIRECTORY: "/nonexistent" }))).toBeInstanceOf(
      ServerMode.ConfigError,
    )
    // Outside persistent mode the same failure stays an ordinary error.
    expect(await rejection(loadSecretVaultKey({ FORGE_SECRET_VAULT_KEY_SOURCE: "systemd-credentials" }))).not.toBeInstanceOf(
      ServerMode.ConfigError,
    )
  })

  test("rejects malformed key material", async () => {
    expect(
      await rejection(
        loadSecretVaultKey({
          FORGE_SECRET_VAULT_KEY_SOURCE: "env",
          FORGE_SECRET_VAULT_KEY_ID: "server-key",
          FORGE_SECRET_VAULT_KEY: Buffer.alloc(31).toString("base64"),
        }),
      ),
    ).toMatchObject({ message: "secret vault key source contains invalid key material" })
  })

  test("rejects unknown key sources", async () => {
    expect(await rejection(loadSecretVaultKey({ FORGE_SECRET_VAULT_KEY_SOURCE: "file" }))).toMatchObject({
      message: "unsupported secret vault key source: file",
    })
  })

  test.each([undefined, "env"])("persistent mode refuses key source %p", async (source) => {
    expect(
      await rejection(
        loadSecretVaultKey({
          FORGE_SERVER_MODE: "persistent",
          ...(source ? { FORGE_SECRET_VAULT_KEY_SOURCE: source } : {}),
        }),
      ),
    ).toMatchObject({ message: "persistent server requires the systemd-credentials secret vault key source" })
  })
})

function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error) => error,
  )
}
