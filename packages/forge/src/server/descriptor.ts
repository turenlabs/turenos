export * as ServerDescriptor from "./descriptor"

import { Context, Effect, Layer, Option } from "effect"
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

export type ListenerFacts = { keySource: string; listener: string }

export class Service extends Context.Service<Service, ListenerFacts>()("@forge/ServerDescriptor") {}

export const layer = (facts: ListenerFacts) => Layer.succeed(Service)(Service.of(facts))

export function read(database: Database.Interface, facts?: ListenerFacts) {
  return Effect.gen(function* () {
    const owner = yield* ServerOwner.read(Database.primary(database.db))
    if (!owner) return undefined
    const context = yield* Effect.serviceOption(Service)
    const listener = facts ?? (Option.isSome(context) ? context.value : { keySource: "unknown", listener: "" })
    return {
      serverID: owner.serverID,
      dataIdentity: { databasePath: Database.path(), databaseUUID: database.databaseUUID },
      keyID: owner.keyID,
      mode: owner.mode,
      keySource: listener.keySource,
      listener: listener.listener,
      version: InstallationVersion,
    } satisfies Info
  })
}
