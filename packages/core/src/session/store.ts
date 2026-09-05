export * as SessionStore from "./store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = isWithReplicas(database.db) ? database.db.$primary : database.db
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        return yield* SessionHistory.load(db, sessionID)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select({ message: SessionMessageTable, source: SessionInputTable.source })
          .from(SessionMessageTable)
          .leftJoin(SessionInputTable, eq(SessionInputTable.id, SessionMessageTable.id))
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.message.session_id),
              message: yield* decodeMessage({
                ...row.message.data,
                ...(row.message.type === "user" && row.source ? { source: row.source } : {}),
                id: row.message.id,
                type: row.message.type,
              }).pipe(Effect.orDie),
            }
          : undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
