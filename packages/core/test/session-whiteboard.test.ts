import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { adjust } from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { Whiteboard } from "@turenlabs/schema/whiteboard"
import { SessionID } from "@turenlabs/schema/session-id"
import { merge, Limits, Service, node } from "@turenlabs/core/session/whiteboard"
import { SessionWhiteboardTable } from "@turenlabs/core/session/whiteboard.sql"
import { SessionTable } from "@turenlabs/core/session/sql"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { testEffect } from "./lib/effect"
import { location } from "./fixture/location"

const shape = (id: string, version = 1, versionNonce = 10): Whiteboard.Element => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  angle: 0,
  isDeleted: false,
  version,
  versionNonce,
})
const empty = (): Whiteboard.Snapshot => ({
  sessionID: SessionID.make("ses_whiteboard"),
  revision: 0,
  elements: [],
  files: {},
  updatedAt: 0,
})
const actor: Whiteboard.Actor = { id: "human", name: "Human", kind: "human" }
const image: Whiteboard.File = {
  id: "png",
  mimeType: "image/png",
  dataURL:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=",
  created: 1,
}

describe("whiteboard merge", () => {
  test("preserves omitted ids, order, tombstones, and exact retries", () => {
    const first = merge(empty(), { elements: [shape("a"), shape("b")] }, 10)
    const deleted = { ...shape("a", 2), isDeleted: true }
    const second = merge(first, { elements: [deleted, shape("c")] }, 20)
    expect(second.elements.map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(second.elements[0]?.isDeleted).toBe(true)
    expect(merge(second, { elements: [shape("a")] })).toBe(second)
    expect(merge(second, { elements: [deleted] })).toBe(second)
    expect(second.revision).toBe(2)
    expect(second.updatedAt).toBe(20)
  })
  test("higher version wins and equal version lower nonce wins regardless of arrival order", () => {
    const low = { ...shape("a", 2, 2), x: 10 }
    const high = { ...shape("a", 2, 8), x: 20 }
    const left = merge(merge(empty(), { elements: [low] }), { elements: [high] })
    const right = merge(merge(empty(), { elements: [high] }), { elements: [low] })
    expect(left.elements).toEqual(right.elements)
    expect(left.elements[0]?.x).toBe(10)
    expect(merge(left, { elements: [shape("a", 3, 100)] }).elements[0]?.version).toBe(3)
  })
  test("rejects equivocation and stale compare-and-swap", () => {
    const first = merge(empty(), { elements: [shape("a")] })
    expect(() => merge(first, { elements: [{ ...shape("a"), x: 1 }] })).toThrow(Whiteboard.ValidationError)
    expect(() => merge(first, { elements: [], baseRevision: 0 })).toThrow(Whiteboard.ConflictError)
    expect(merge(first, { elements: [], baseRevision: 1 })).toBe(first)
  })
  test("rejects unsupported types, unsafe links, malformed geometry and versions", () => {
    const cases: Whiteboard.Element[] = [
      { type: "embeddable" },
      { type: "magicframe" },
      { x: Infinity },
      { x: NaN },
      { width: -1 },
      { version: 0 },
      { version: 1.5 },
      { versionNonce: -1 },
      { link: "javascript:alert(1)" },
      { type: "arrow", points: [[0, Infinity]] },
    ]
    for (const fields of cases) {
      expect(() => merge(empty(), { elements: [{ ...shape("a"), ...fields }] })).toThrow(Whiteboard.ValidationError)
    }
  })
  test("enforces request and cumulative scene limits including tombstones", () => {
    expect(() => merge(empty(), { elements: Array.from({ length: 5001 }, (_, i) => shape(`${i}`)) })).toThrow(
      Whiteboard.ValidationError,
    )
    const full = merge(empty(), {
      elements: Array.from({ length: 5000 }, (_, i) => ({ ...shape(`${i}`), isDeleted: true })),
    })
    expect(() => merge(full, { elements: [shape("one-more")] })).toThrow(Whiteboard.ValidationError)
    expect(() =>
      merge(empty(), { elements: [{ ...shape("large"), customData: "x".repeat(Limits.sceneBytes) }] }),
    ).toThrow(Whiteboard.ValidationError)
    const large = merge(empty(), { elements: [{ ...shape("first"), customData: "x".repeat(3 * 1024 * 1024) }] })
    expect(() => merge(large, { elements: [{ ...shape("second"), customData: "y".repeat(2 * 1024 * 1024) }] })).toThrow(
      Whiteboard.ValidationError,
    )
  })
  test("accepts raster files, retains omitted files, rejects SVG/URLs/MIME mismatch and changed content", () => {
    const first = merge(empty(), { elements: [], files: { png: image } })
    expect(merge(first, { elements: [shape("a")] }).files).toEqual(first.files)
    expect(merge(first, { elements: [], files: { png: image } })).toBe(first)
    for (const file of [
      { ...image, id: "wrong" },
      { ...image, dataURL: "https://example.com/image.png" },
      { ...image, mimeType: "image/svg+xml", dataURL: "data:image/svg+xml;base64,PHN2Zy8+" },
      { ...image, dataURL: "data:image/png;base64,PHN2Zy8+" },
      { ...image, dataURL: "x".repeat(Limits.fileBytes + 1) },
    ]) {
      expect(() => merge(empty(), { elements: [], files: { png: file } })).toThrow(Whiteboard.ValidationError)
    }
    expect(() => merge(first, { elements: [], files: { png: { ...image, created: 2 } } })).toThrow(
      Whiteboard.ValidationError,
    )
    expect(() => merge(empty(), { elements: [{ ...shape("i"), type: "image", fileId: "missing" }] })).toThrow(
      Whiteboard.ValidationError,
    )
  })
})

const directory = AbsolutePath.make("/project")
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (input) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionCreation.node, AgentV2.node, node]), [
    [ProjectV2.node, projects],
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
  ]),
)
const create = (id: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionCreation.Service
    return yield* sessions.create({
      id: SessionID.make(id),
      agent: AgentV2.ID.make("build"),
      model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") }),
      location: { directory },
    })
  })

describe("persistent whiteboard service", () => {
  it.effect("simultaneous different-id updates survive and re-get reads persisted data", () =>
    Effect.gen(function* () {
      const session = yield* create("ses_whiteboard_concurrent")
      const board = yield* Service
      yield* Effect.all(
        [
          board.update(session.id, { elements: [shape("a")] }, actor),
          board.update(session.id, { elements: [shape("b")] }, actor),
        ],
        { concurrency: "unbounded" },
      )
      const snapshot = yield* board.get(session.id)
      expect(snapshot.revision).toBe(2)
      expect(snapshot.elements.map((item) => item.id).sort()).toEqual(["a", "b"])
      const database = yield* Database.Service
      const row = yield* Database.primary(database.db)
        .select()
        .from(SessionWhiteboardTable)
        .where(eq(SessionWhiteboardTable.session_id, session.id))
        .get()
      expect(row?.elements).toEqual(snapshot.elements)
      expect(row?.revision).toBe(2)
    }),
  )
  it.effect("concurrent same-id merges use nonce LWW; retry writes no event", () =>
    Effect.gen(function* () {
      const session = yield* create("ses_whiteboard_lww")
      const board = yield* Service
      const events = yield* EventV2.Service
      const winner = { ...shape("a", 2, 2), x: 3 }
      yield* Effect.all(
        [
          board.update(session.id, { elements: [shape("a", 2, 10)] }, actor),
          board.update(session.id, { elements: [winner] }, actor),
        ],
        { concurrency: "unbounded" },
      )
      const before = yield* board.get(session.id)
      expect(before.elements).toEqual([winner])
      const journal = yield* events.durableSnapshot({ aggregateID: session.id })
      yield* board.update(session.id, { elements: [winner] }, actor)
      expect(yield* board.get(session.id)).toEqual(before)
      expect(yield* events.durableSnapshot({ aggregateID: session.id })).toEqual(journal)
      expect(
        journal
          .filter((event) => event.type === Whiteboard.Updated.type)
          .every((event) => !JSON.stringify(event).includes("elements")),
      ).toBe(true)
    }),
  )
  it.effect("CAS and validation errors roll back without revision/event changes", () =>
    Effect.gen(function* () {
      const session = yield* create("ses_whiteboard_cas")
      const board = yield* Service
      const first = yield* board.update(session.id, { elements: [shape("a")] }, actor)
      expect(
        yield* board.update(session.id, { elements: [shape("b")], baseRevision: 0 }, actor).pipe(Effect.flip),
      ).toBeInstanceOf(Whiteboard.ConflictError)
      expect(
        yield* board.update(session.id, { elements: [{ ...shape("a"), x: 5 }] }, actor).pipe(Effect.flip),
      ).toBeInstanceOf(Whiteboard.ValidationError)
      expect(yield* board.get(session.id)).toEqual(first)
      const tombstone = { ...shape("a", 2), isDeleted: true }
      yield* board.update(session.id, { elements: [tombstone], baseRevision: 1 }, actor)
      expect((yield* board.update(session.id, { elements: [shape("a")] }, actor)).elements).toEqual([tombstone])
    }),
  )
  it.effect("presence is isolated, bounded and never journaled", () =>
    Effect.gen(function* () {
      const session = yield* create("ses_whiteboard_presence")
      const other = yield* create("ses_whiteboard_presence_other")
      const board = yield* Service
      const events = yield* EventV2.Service
      const before = yield* events.durableSnapshot({ aggregateID: session.id })
      yield* board.presence(session.id, { clientID: "a", username: "Alice", pointer: { x: 3, y: 4 } })
      expect((yield* board.participants(session.id)).participants).toHaveLength(1)
      expect((yield* board.participants(other.id)).participants).toEqual([])
      expect(
        yield* board
          .presence(session.id, { clientID: "bad", username: "Bad", pointer: { x: Infinity, y: 0 } })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Whiteboard.ValidationError)
      yield* Effect.forEach(
        Array.from({ length: 63 }, (_, i) => i),
        (i) => board.presence(session.id, { clientID: `${i}`, username: "User" }),
      )
      expect(
        yield* board.presence(session.id, { clientID: "overflow", username: "User" }).pipe(Effect.flip),
      ).toBeInstanceOf(Whiteboard.ValidationError)
      expect(yield* events.durableSnapshot({ aggregateID: session.id })).toEqual(before)
      yield* adjust("31 seconds")
      expect((yield* board.participants(session.id)).participants).toEqual([])
      expect(
        (yield* board.presence(session.id, { clientID: "after-expiry", username: "User" })).participants,
      ).toHaveLength(1)
    }),
  )
  it.effect("session deletion cascades board rows and missing sessions fail every operation", () =>
    Effect.gen(function* () {
      const session = yield* create("ses_whiteboard_delete")
      const board = yield* Service
      yield* board.update(session.id, { elements: [shape("a")] }, actor)
      const database = yield* Database.Service
      const db = Database.primary(database.db)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run()
      expect(
        yield* db.select().from(SessionWhiteboardTable).where(eq(SessionWhiteboardTable.session_id, session.id)).get(),
      ).toBeUndefined()
      expect(yield* board.get(session.id).pipe(Effect.flip)).toBeInstanceOf(Whiteboard.NotFoundError)
      expect(yield* board.update(session.id, { elements: [] }, actor).pipe(Effect.flip)).toBeInstanceOf(
        Whiteboard.NotFoundError,
      )
      expect(yield* board.participants(session.id).pipe(Effect.flip)).toBeInstanceOf(Whiteboard.NotFoundError)
      expect(yield* board.presence(session.id, { clientID: "a", username: "Alice" }).pipe(Effect.flip)).toBeInstanceOf(
        Whiteboard.NotFoundError,
      )
    }),
  )
})
