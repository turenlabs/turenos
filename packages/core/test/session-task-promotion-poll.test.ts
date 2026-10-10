import { describe, expect } from "bun:test"
import path from "node:path"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { adjust } from "effect/testing/TestClock"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ProjectV2 } from "@turenlabs/core/project"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { TeamBoard } from "@turenlabs/core/team/board"
import { it } from "./lib/effect"
import { cancel, directory, finish, setup, spawnFrom } from "./lib/fleet"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

type DatabaseShape = Database.Interface["db"]

// Counts the PRAGMA data_version reads the task service runs on the primary
// connection, without patching globals: the database it receives is a proxy.
const countingDatabase = (db: DatabaseShape, reads: { count: number }) => {
  const primary = (target: DatabaseShape) =>
    new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property)
        if (property !== "get") return value
        return (...args: Parameters<typeof object.get>) => {
          const read = value.apply(object, args)
          if (!JSON.stringify(args[0]).includes("PRAGMA data_version")) return read
          // The service builds this effect once and re-runs it, so count runs.
          return Effect.suspend(() => {
            reads.count++
            return read
          })
        }
      },
    })
  return new Proxy(db, {
    get(object, property) {
      if (property === "$primary") return primary(Reflect.get(object, property))
      if (property === "get") return Reflect.get(primary(object), property)
      return Reflect.get(object, property)
    },
  })
}

const app = (filename: string, reads: { count: number }) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCreation.node,
      SessionTaskV2.node,
      TeamBoard.node,
    ]),
    [
      [
        Database.node,
        Layer.effect(
          Database.Service,
          Effect.gen(function* () {
            const context = yield* Layer.build(Database.layerFromPath(filename))
            const database = Context.get(context, Database.Service)
            return Database.Service.of({ ...database, db: countingDatabase(database.db, reads) })
          }),
        ),
      ],
      [
        ProjectV2.node,
        Layer.succeed(
          ProjectV2.Service,
          ProjectV2.Service.of({
            resolve: (input) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
            directories: () => Effect.succeed([]),
            remember: () => Effect.void,
          }),
        ),
      ],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
    ],
  )

const memory = () => {
  const reads = { count: 0 }
  return { reads, layer: app(":memory:", reads) }
}

// The promotion fiber reaches each sleep through asynchronous database reads, so
// a single large adjust can run before the next sleep is registered. Advance in
// 250 ms steps (every poll interval is a multiple) and let the fiber settle.
const advance = Effect.fnUntraced(function* (millis: number) {
  for (let elapsed = 0; elapsed < millis; elapsed += 250) {
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    yield* adjust("250 millis")
  }
  yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
})

const noWake = () => Effect.void
const limitOne = () => Effect.succeed(1)

describe("SessionTaskV2 promotion poll", () => {
  it.effect("backs off the data_version poll while nothing is queued", () => {
    const { reads, layer } = memory()
    return Effect.gen(function* () {
      const tasks = yield* SessionTaskV2.Service
      const driver = yield* tasks.runPromotion(noWake, limitOne).pipe(Effect.forkScoped)
      yield* advance(10000)
      // Polls at 0.25, 0.75, 1.75, 3.75 and 7.75 s after the initial read; a
      // fixed 250 ms poll reads about 41 times.
      expect(reads.count).toBeGreaterThanOrEqual(4)
      expect(reads.count).toBeLessThanOrEqual(8)
      yield* Fiber.interrupt(driver)
    }).pipe(Effect.provide(layer))
  })

  it.effect("settles at the idle cap", () => {
    const { reads, layer } = memory()
    return Effect.gen(function* () {
      const tasks = yield* SessionTaskV2.Service
      const driver = yield* tasks.runPromotion(noWake, limitOne).pipe(Effect.forkScoped)
      yield* advance(60000)
      // About one read per 5 s after the first 8 s, against 241 at a fixed 250 ms.
      expect(reads.count).toBeGreaterThanOrEqual(12)
      expect(reads.count).toBeLessThanOrEqual(20)
      yield* Fiber.interrupt(driver)
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps the fast poll while a root has queued tasks", () => {
    const { reads, layer } = memory()
    return Effect.gen(function* () {
      const tasks = yield* SessionTaskV2.Service
      const rootSessionID = yield* setup("poll_queued")
      yield* spawnFrom(rootSessionID, "poll_queued_run", 1)
      yield* spawnFrom(rootSessionID, "poll_queued_wait", 1)
      const driver = yield* tasks.runPromotion(noWake, limitOne).pipe(Effect.forkScoped)
      const before = reads.count
      yield* advance(10000)
      // The queued task may be waiting on a slot another process frees.
      expect(reads.count - before).toBeGreaterThanOrEqual(36)
      yield* Fiber.interrupt(driver)
    }).pipe(Effect.provide(layer))
  })

  it.effect("promotes a locally freed slot immediately after backing off", () => {
    const { layer } = memory()
    return Effect.gen(function* () {
      const tasks = yield* SessionTaskV2.Service
      const woken = yield* Deferred.make<string>()
      const driver = yield* tasks
        .runPromotion((sessionID) => Deferred.succeed(woken, sessionID), limitOne)
        .pipe(Effect.forkScoped)
      yield* advance(10000)
      const rootSessionID = yield* setup("poll_local")
      const running = yield* spawnFrom(rootSessionID, "poll_local_run", 1)
      const queued = yield* spawnFrom(rootSessionID, "poll_local_wait", 1)
      yield* cancel(running.task)
      // No clock adjustment: only the local signal can wake the pass now.
      expect(yield* Deferred.await(woken)).toBe(queued.task.childSessionID)
      yield* Fiber.interrupt(driver)
    }).pipe(Effect.provide(layer))
  })

  it.effect("returns to the fast poll after another connection commits", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(Effect.promise(tmpdir), (dir) =>
        Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const filename = path.join(tmp.path, "promotion-poll.sqlite")
      const reads = { count: 0 }
      yield* Effect.gen(function* () {
        const tasks = yield* SessionTaskV2.Service
        const driver = yield* tasks.runPromotion(noWake, limitOne).pipe(Effect.forkScoped)
        yield* advance(20000)
        const idle = reads.count
        yield* advance(10000)
        // Backed off to the 5 s cap: two polls in ten seconds.
        expect(reads.count - idle).toBeLessThanOrEqual(3)

        const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
        const external = new sqlite.Database(filename)
        external.run("CREATE TABLE promotion_poll_external (id integer PRIMARY KEY)")
        external.close()

        // The commit is noticed within the cap, which restarts the pass at the
        // base interval: reads at the notice, the new pass and 0.25 s, 0.75 s and
        // 1.75 s later. Still on the 5 s cap, the same window holds at most two.
        const committed = reads.count
        yield* advance(5000)
        expect(reads.count - committed).toBeGreaterThanOrEqual(4)
        yield* Fiber.interrupt(driver)
      }).pipe(Effect.provide(app(filename, reads)))
    }),
  )

  it.effect("keeps awaitTerminal on the 250 ms poll", () => {
    const { reads, layer } = memory()
    return Effect.gen(function* () {
      const tasks = yield* SessionTaskV2.Service
      const rootSessionID = yield* setup("poll_wait")
      const running = yield* spawnFrom(rootSessionID, "poll_wait_run", 1)
      const before = reads.count
      const waiting = yield* tasks.wait([running.task.id]).pipe(Effect.forkScoped)
      yield* advance(2000)
      expect(reads.count - before).toBeGreaterThanOrEqual(8)
      yield* finish(running.task)
      expect((yield* Fiber.join(waiting)).map((task) => task.status)).toEqual(["completed"])
    }).pipe(Effect.provide(layer))
  })
})
