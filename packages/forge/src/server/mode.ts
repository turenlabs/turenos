export * as ServerMode from "./mode"

import { ServerOwner } from "@turenlabs/core/database/server-owner"

const secretNames = ["FORGE_SECRET_VAULT_KEY", "FORGE_SECRET_VAULT_KEY_ID", "FORGE_SERVER_PASSWORD"] as const

export function assertNoSecretsInEnvironment(env = process.env) {
  if (ServerOwner.mode(env) !== "persistent") return
  const present = secretNames.filter((name) => env[name] !== undefined)
  if (present.length)
    throw new Error(`persistent server secrets must not be set in the initial environment: ${present.join(", ")}`)
}
