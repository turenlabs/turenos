import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Flag } from "@turenlabs/core/flag/flag"
import { ServerMode } from "@/server/mode"
import { ServerOwner } from "@turenlabs/core/database/server-owner"

export async function loadServerPassword(env = process.env): Promise<string | undefined> {
  const persistent = ServerOwner.mode(env) === "persistent"
  if (persistent) ServerMode.assertNoSecretsInEnvironment(env)
  const name = env.FORGE_SERVER_PASSWORD_CREDENTIAL
  if (!name) {
    if (persistent) throw new Error("persistent server requires FORGE_SERVER_PASSWORD_CREDENTIAL")
    return env.FORGE_SERVER_PASSWORD ?? Flag.FORGE_SERVER_PASSWORD
  }
  if (!env.CREDENTIALS_DIRECTORY) throw new Error("systemd credential directory is unavailable")
  if (name !== basename(name)) throw new Error("systemd credential names must be file names")
  // systemd owns $CREDENTIALS_DIRECTORY and exposes credentials as 0440 in a service-private mount.
  const password = (await readFile(join(env.CREDENTIALS_DIRECTORY, name), "utf8")).trim()
  if (!password) throw new Error("server password credential is empty")
  return password
}
