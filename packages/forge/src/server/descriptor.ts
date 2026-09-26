export * as ServerDescriptor from "./descriptor"

import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { ServerOwner } from "@turenlabs/core/database/server-owner"
import { InstallationVersion } from "@turenlabs/core/installation/version"

export type Info = {
  serverID: string
  dataIdentity: { databasePath: string; databaseUUID: string }
  keyID: string
  mode: ServerOwner.Mode
  keySource: string
  listener: string
  version: string
}

const current = { keySource: "unknown", listener: "" }

/** Records the non-secret listener facts the descriptor reports. */
export function configure(input: { keySource?: string; listener?: URL }) {
  if (input.keySource) current.keySource = input.keySource
  if (input.listener) current.listener = input.listener.toString()
}

export function read(database: Database.Interface) {
  return Effect.gen(function* () {
    const owner = yield* ServerOwner.read(Database.primary(database.db))
    if (!owner) return undefined
    return {
      serverID: owner.serverID,
      dataIdentity: { databasePath: Database.path(), databaseUUID: database.databaseUUID },
      keyID: owner.keyID,
      mode: owner.mode,
      keySource: current.keySource,
      listener: current.listener,
      version: InstallationVersion,
    } satisfies Info
  })
}
