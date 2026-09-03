import { describe, expect } from "bun:test"
import path from "path"
import { isWithReplicas } from "@turenlabs/effect-drizzle-sqlite"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Config } from "@turenlabs/core/config"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { Location } from "@turenlabs/core/location"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionShell } from "@turenlabs/core/session/shell"
import { SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const layer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const directory = AbsolutePath.make(tmp.path)
      const locationLayer = Layer.succeed(
        Location.Service,
        Location.Service.of(location(Location.Ref.make({ directory }))),
      )
      return AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, Location.node, SessionProjector.node, SessionShell.node]),
        [
          [Database.node, Database.layerFromPath(path.join(tmp.path, "forge.db"))],
          [Config.node, config],
          [Location.node, locationLayer],
        ],
      )
    }),
  ),
)

const it = testEffect(layer)
const decode = Schema.decodeUnknownSync(SessionMessage.Message)
const sessionID = SessionV2.ID.make("ses_shell_test")

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const db = isWithReplicas(database.db) ? database.db.$primary : database.db
  const current = yield* Location.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: current.directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "shell",
      directory: current.directory,
      title: "shell",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return { db, directory: current.directory }
})

const read = Effect.fn("SessionShellTest.read")(function* (db: Database.Interface["db"], messageID: SessionMessage.ID) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, messageID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  const message = decode({ ...row.data, id: row.id, type: row.type })
  return message.type === "shell" ? message : undefined
})

const wait = (
  db: Database.Interface["db"],
  messageID: SessionMessage.ID,
  attempts = 200,
): Effect.Effect<SessionMessage.Shell> =>
  read(db, messageID).pipe(
    Effect.flatMap((message) => {
      if (message?.time.completed) return Effect.succeed(message)
      if (attempts <= 0) return Effect.die(`Timed out waiting for shell message ${messageID}`)
      return Effect.sleep("10 millis").pipe(Effect.andThen(wait(db, messageID, attempts - 1)))
    }),
  )

const start = (messageID: SessionMessage.ID, command: string, timeout?: number) =>
  startFor(sessionID, messageID, command, timeout)

const startFor = (targetSessionID: SessionV2.ID, messageID: SessionMessage.ID, command: string, timeout?: number) =>
  Effect.gen(function* () {
    const shell = yield* SessionShell.Service
    return yield* shell.start({
      sessionID: targetSessionID,
      messageID,
      command,
      timeout,
      after: Effect.void,
    })
  })

describe("SessionShell", () => {
  it.live("runs a real nonzero command once and reconciles exact retries through a reader-pooled database", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      const messageID = SessionMessage.ID.make("msg_shell_nonzero")
      const command = "printf boom; exit 7"

      expect(yield* start(messageID, command)).toMatchObject({
        id: messageID,
        command,
        status: "running",
      })
      const completed = yield* wait(db, messageID)
      const retried = yield* start(messageID, command)
      const events = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType(SessionEvent.Shell.Started.type, 1)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const ended = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType(SessionEvent.Shell.Ended.type, 1)),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      expect(completed).toMatchObject({ status: "completed", exitCode: 7, output: "boom" })
      expect(retried).toEqual(completed)
      expect(events).toHaveLength(1)
      expect(ended).toHaveLength(1)
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).all(),
      ).toHaveLength(1)
    }),
  )

  it.live("treats timeout as retry identity and records a bounded terminal timeout", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      const messageID = SessionMessage.ID.make("msg_shell_timeout")
      yield* start(messageID, "sleep 1", 20)

      expect(yield* wait(db, messageID)).toMatchObject({
        timeout: 20,
        status: "timed_out",
        error: "Shell command exceeded the 20 ms timeout.",
      })
      expect(yield* start(messageID, "sleep 1", 21).pipe(Effect.flip)).toBeInstanceOf(SessionShell.ConflictError)
    }),
  )

  it.live("cancels the process tree and waits for durable cancellation before returning", () =>
    Effect.gen(function* () {
      const { db, directory } = yield* setup
      const messageID = SessionMessage.ID.make("msg_shell_cancel")
      const leaked = path.join(directory, "leaked.txt")
      yield* start(messageID, `(sleep 0.4; printf leaked > ${JSON.stringify(leaked)}) & wait`)
      yield* Effect.sleep("40 millis")

      const shell = yield* SessionShell.Service
      yield* shell.interrupt(sessionID)
      const cancelled = yield* read(db, messageID)
      yield* Effect.sleep("600 millis")

      expect(cancelled).toMatchObject({ status: "cancelled", error: "User cancelled the shell command." })
      expect(cancelled?.time.completed).toBeDefined()
      expect(yield* Effect.promise(() => Bun.file(leaked).exists())).toBe(false)
      expect(yield* shell.active(sessionID)).toBe(false)
    }),
  )

  it.live("caps captured output at one MiB and records truncation", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      const messageID = SessionMessage.ID.make("msg_shell_truncated")
      yield* start(
        messageID,
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(1024 * 1024 + 64))")}`,
      )

      const completed = yield* wait(db, messageID)
      expect(completed.status).toBe("completed")
      expect(completed.truncated).toBe(true)
      expect(Buffer.byteLength(completed.output)).toBeLessThanOrEqual(
        SessionShell.MAX_OUTPUT_BYTES +
          Buffer.byteLength("\n\n[output capture truncated at the in-memory safety limit]"),
      )
    }),
  )

  it.live("settles a stale running row on an explicit same-ID retry after reload", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      const messageID = SessionMessage.ID.make("msg_shell_recovery")
      const command = "printf never-reran"
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        callID: `call_${messageID.slice("msg_".length)}`,
        command,
        timeout: SessionShell.DEFAULT_TIMEOUT_MS,
      })

      const recovered = yield* start(messageID, command)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      expect(recovered).toMatchObject({
        status: "failed",
        error: "Shell execution was interrupted before this TurenOS process observed completion.",
      })
      expect(rows.filter((row) => row.type === EventV2.versionedType(SessionEvent.Shell.Started.type, 1))).toHaveLength(
        1,
      )
      expect(rows.filter((row) => row.type === EventV2.versionedType(SessionEvent.Shell.Ended.type, 1))).toHaveLength(1)
    }),
  )

  it.live("serializes concurrent cross-session reuse of one shell message ID into a typed conflict", () =>
    Effect.gen(function* () {
      const { db, directory } = yield* setup
      const otherSessionID = SessionV2.ID.make("ses_shell_other")
      const messageID = SessionMessage.ID.make("msg_shell_cross_session_race")
      yield* db
        .insert(SessionTable)
        .values({
          id: otherSessionID,
          project_id: Project.ID.global,
          slug: "shell-other",
          directory,
          title: "shell-other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const outcomes = yield* Effect.all(
        [
          startFor(sessionID, messageID, "sleep 0.05; printf first").pipe(
            Effect.match({ onFailure: (error) => error, onSuccess: (message) => message }),
          ),
          startFor(otherSessionID, messageID, "sleep 0.05; printf second").pipe(
            Effect.match({ onFailure: (error) => error, onSuccess: (message) => message }),
          ),
        ],
        { concurrency: "unbounded" },
      )
      const conflict = outcomes.find((outcome) => outcome instanceof SessionShell.ConflictError)
      const started = outcomes.find(Schema.is(SessionMessage.Shell))

      expect(conflict).toBeInstanceOf(SessionShell.ConflictError)
      expect(started).toMatchObject({ id: messageID, type: "shell", status: "running" })
      expect(yield* wait(db, messageID)).toMatchObject({
        id: messageID,
        status: "completed",
      })
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).all(),
      ).toHaveLength(1)
    }),
  )

  // Only this service's construction is Location bound. Callers acquire it with
  // `Effect.provide(locations.get(...))` and then invoke its methods on their
  // own fiber — the Session service's global one, which carries no
  // Location.Service at all — and execution settles on a fiber forked from that
  // one. Publishing from ambient context therefore attributes shell frames to
  // whatever the caller happens to carry, or to nothing, and a frame with no
  // location is dropped by every per-instance event stream. Standing in a
  // foreign Location here proves the frames follow the service's placement
  // rather than the caller's. See the filter in
  // packages/forge/src/server/routes/instance/httpapi/handlers/event.ts.
  it.live("locates shell frames by the placement the service was built for, not the caller's", () =>
    Effect.gen(function* () {
      const { db, directory } = yield* setup
      const messageID = SessionMessage.ID.make("msg_shell_location")
      const foreign = Layer.succeed(
        Location.Service,
        Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make("/foreign") }))),
      )
      const events = yield* EventV2.Service
      const seen: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => seen.push(event)))
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* start(messageID, "printf located").pipe(Effect.provide(foreign))
      yield* wait(db, messageID)

      for (const type of [SessionEvent.Shell.Started.type, SessionEvent.Shell.Ended.type]) {
        const frames = seen.filter((event) => event.type === type)
        expect([type, frames.length]).toEqual([type, 1])
        expect([type, frames[0]!.location?.directory]).toEqual([type, directory])
      }
    }),
  )
})
