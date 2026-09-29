import { describe, expect, test } from "bun:test"
import { withoutIpcSecrets } from "./sidecar-env"

describe("withoutIpcSecrets", () => {
  test("drops credentials the sidecar receives over IPC", () => {
    expect(
      withoutIpcSecrets({
        PATH: "/usr/bin",
        HOME: "/home/test",
        FORGE_CHANNEL: "beta",
        FORGE_SERVER_PASSWORD: "server-secret",
        FORGE_BETA_SERVER_PASSWORD: "beta-secret",
        FORGE_SECRET_VAULT_KEY: "vault-secret",
        FORGE_SECRET_VAULT_KEY_ID: "vault-id",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/test", FORGE_CHANNEL: "beta" })
  })
})
