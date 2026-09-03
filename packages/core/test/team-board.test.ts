import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
import { SessionSchema } from "@turenlabs/core/session/schema"
import { ID, InvalidState, NotFound } from "@turenlabs/schema/team-board"
import { TeamBoard } from "@turenlabs/core/team/board"
import { testEffect } from "./lib/effect"
import { location } from "./fixture/location"

const directory = AbsolutePath.make("/project")
const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") })
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (input) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
    directories: () => Effect.succeed([]),
    remember: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionCreation.node, AgentV2.node, TeamBoard.node]),
    [
      [ProjectV2.node, projects],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
    ],
  ),
)

const createSession = (id: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionCreation.Service
    return yield* sessions.create({
      id: SessionSchema.ID.make(id),
      agent: AgentV2.ID.make("build"),
      model,
      location: { directory },
    })
  })

const post = (rootSessionID: SessionSchema.ID, title: string, supersedes?: ID) =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.Service
    return yield* board.post({
      rootSessionID,
      authorSessionID: rootSessionID,
      authorAgent: AgentV2.ID.make("build"),
      kind: "finding",
      title,
      body: `body for ${title}`,
      evidence: `evidence for ${title}`,
      ...(supersedes ? { supersedes } : {}),
    })
  })

describe("TeamBoard", () => {
  it.effect("returns a posted note with its authored fields", () =>
    Effect.gen(function* () {
      const session = yield* createSession("ses_board_fields")
      const note = yield* post(session.id, "Finding")
      expect(yield* (yield* TeamBoard.Service).list(session.id)).toContainEqual(note)
      expect(note).toMatchObject({
        authorSessionID: session.id,
        authorAgent: AgentV2.ID.make("build"),
        kind: "finding",
        title: "Finding",
        body: "body for Finding",
        evidence: "evidence for Finding",
      })
    }),
  )

  it.effect("isolates notes by root session", () =>
    Effect.gen(function* () {
      const first = yield* createSession("ses_board_first")
      const second = yield* createSession("ses_board_second")
      yield* post(first.id, "first")
      expect(yield* (yield* TeamBoard.Service).list(second.id)).toEqual([])
    }),
  )

  it.effect("links a correction in both directions and increments the old revision", () =>
    Effect.gen(function* () {
      const session = yield* createSession("ses_board_supersede")
      const board = yield* TeamBoard.Service
      const old = yield* post(session.id, "old")
      const correction = yield* post(session.id, "new", old.id)
      expect(correction.supersedes).toBe(old.id)
      expect(yield* board.get(old.id)).toMatchObject({ supersededBy: correction.id, revision: old.revision + 1 })
    }),
  )

  it.effect("requires later corrections to supersede the current chain tip", () =>
    Effect.gen(function* () {
      const session = yield* createSession("ses_board_supersede_tip")
      const board = yield* TeamBoard.Service
      const old = yield* post(session.id, "old")
      const first = yield* post(session.id, "first correction", old.id)

      const failure = yield* Effect.flip(post(session.id, "stale correction", old.id))
      expect(failure).toBeInstanceOf(InvalidState)
      expect(yield* board.list(session.id)).toHaveLength(2)

      const second = yield* post(session.id, "second correction", first.id)
      expect(yield* board.get(old.id)).toMatchObject({ supersededBy: first.id })
      expect(yield* board.get(first.id)).toMatchObject({ supersededBy: second.id })
    }),
  )

  it.effect("validates a cross-team correction before writing", () =>
    Effect.gen(function* () {
      const first = yield* createSession("ses_board_owner")
      const second = yield* createSession("ses_board_other")
      const board = yield* TeamBoard.Service
      const old = yield* post(first.id, "owned")
      const before = yield* board.list(second.id)
      const failure = yield* Effect.flip(post(second.id, "rejected", old.id))
      expect(failure).toBeInstanceOf(InvalidState)
      expect(yield* board.list(second.id)).toEqual(before)
    }),
  )

  it.effect("fails when superseding an unknown note", () =>
    Effect.gen(function* () {
      const session = yield* createSession("ses_board_missing_target")
      const failure = yield* Effect.flip(post(session.id, "rejected", ID.make("missing-note")))
      expect(failure).toBeInstanceOf(NotFound)
    }),
  )

  it.effect("fails getting an unknown note", () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.Service
      const failure = yield* Effect.flip(board.get(ID.make("missing-note-get")))
      expect(failure).toBeInstanceOf(NotFound)
    }),
  )

  it.effect("retains a pending parent notification until it is delivered", () =>
    Effect.gen(function* () {
      const session = yield* createSession("ses_board_notification")
      const board = yield* TeamBoard.Service
      const note = yield* board.post({
        rootSessionID: session.id,
        authorSessionID: session.id,
        parentSessionID: session.id,
        authorAgent: AgentV2.ID.make("build"),
        kind: "status",
        title: "pending",
        body: "pending parent update",
      })

      expect(yield* board.pendingParentNotes()).toContainEqual(note)
      yield* board.markParentNotified(note.id)
      expect(yield* board.pendingParentNotes()).toEqual([])
      yield* board.markParentNotified(note.id)
    }),
  )

  it.effect("bounds the visible board state and preserves recent ordering", () =>
    Effect.gen(function* () {
      const session = yield* createSession("ses_board_bounds")
      const board = yield* TeamBoard.Service
      const note = yield* board.post({
        rootSessionID: session.id,
        authorSessionID: session.id,
        authorAgent: AgentV2.ID.make("build"),
        kind: "finding",
        title: "Large finding",
        body: "b".repeat(TeamBoard.MAX_VISIBLE_TEXT + 100),
        evidence: "e".repeat(TeamBoard.MAX_VISIBLE_TEXT + 100),
      })
      expect(yield* board.recent(session.id, Number.MAX_SAFE_INTEGER)).toContainEqual(note)
      const visible = (yield* board.boardState(session.id)).notes[0]!
      expect(visible.body.length).toBeLessThanOrEqual(TeamBoard.MAX_VISIBLE_TEXT)
      expect(visible.evidence?.length).toBeLessThanOrEqual(TeamBoard.MAX_VISIBLE_TEXT)
    }),
  )
})
