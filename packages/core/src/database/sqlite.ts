export * as Sqlite from "./sqlite"

import { Context } from "effect"
import type { drizzle } from "drizzle-orm/bun-sqlite"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@turenlabs/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@turenlabs/core/database/SqliteDrizzle") {}
