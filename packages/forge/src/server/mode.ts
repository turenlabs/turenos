export * as ServerMode from "./mode"

import { ServerOwner } from "@turenlabs/core/database/server-owner"

const secretNames = ["FORGE_SECRET_VAULT_KEY", "FORGE_SECRET_VAULT_KEY_ID", "FORGE_SERVER_PASSWORD"] as const

/** `EX_CONFIG`: the unit's `RestartPreventExitStatus` keeps systemd from restarting into the same error. */
export const configExitStatus = 78

/** A persistent-mode misconfiguration that restarting cannot fix. */
export class ConfigError extends Error {
  override name = "ServerConfigError"
}

/** Only a persistent server runs under a restarting unit, so only it reports configuration errors as such. */
export function configError(message: string, env = process.env) {
  return ServerOwner.mode(env) === "persistent" ? new ConfigError(message) : new Error(message)
}

export function assertNoSecretsInEnvironment(env = process.env) {
  if (ServerOwner.mode(env) !== "persistent") return
  const present = secretNames.filter((name) => env[name] !== undefined)
  if (present.length)
    throw new ConfigError(`persistent server secrets must not be set in the initial environment: ${present.join(", ")}`)
}

/** The installer marks the units it writes; a hand-written or older unit lacks the restart policy the contract needs. */
export function assertPersistentUnit(env = process.env) {
  if (ServerOwner.mode(env) !== "persistent" || env.FORGE_PERSISTENT_UNIT === "1") return
  throw new ConfigError("persistent server unit is outdated; re-run `forge persistent install --apply` with this forge binary")
}
