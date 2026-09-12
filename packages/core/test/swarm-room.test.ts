import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionInputTable, SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SwarmRoom } from "@turenlabs/core/team/room"
import { SwarmRoom as Contract } from "@turenlabs/schema/swarm-room"
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
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      SessionCreation.node,
      SessionTaskV2.node,
      SwarmRoom.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
    ],
  ),
)

const authority = SessionTaskV2.Authority.make({
  parentPermissions: [{ action: "*", resource: "*", effect: "allow" }],
  ancestorPermissionSets: [],
  childPermissions: [],
  hardPermissions: [],
  writeRoots: [],
  commands: [],
})

const setup = Effect.fnUntraced(function* (suffix: string) {
  const { db } = yield* Database.Service
  const parentSessionID = SessionSchema.ID.make(`ses_room_parent_${suffix}`)
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: parentSessionID,
      project_id: ProjectV2.ID.global,
      slug: suffix,
      directory,
      title: `room ${suffix}`,
      version: "test",
      agent: "build",
      model,
    })
    .run()
    .pipe(Effect.orDie)
  return parentSessionID
})

const actor = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, suffix: string) {
  const assistantMessageID = SessionMessage.ID.make(`msg_room_actor_${suffix}`)
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(Date.now()),
    agent: "build",
    model,
  })
  yield* events.publish(SessionEvent.Tool.Input.Started, {
    sessionID,
    assistantMessageID,
    callID: `call_${suffix}`,
    timestamp: DateTime.makeUnsafe(Date.now()),
    name: "spawn_agent",
  })
  yield* events.publish(SessionEvent.Tool.Input.Ended, {
    sessionID,
    assistantMessageID,
    callID: `call_${suffix}`,
    timestamp: DateTime.makeUnsafe(Date.now()),
    text: "{}",
  })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID,
    assistantMessageID,
    callID: `call_${suffix}`,
    timestamp: DateTime.makeUnsafe(Date.now()),
    tool: "spawn_agent",
    input: {},
    provider: { executed: false },
  })
  return SessionTaskV2.Actor.make({
    sessionID,
    assistantMessageID,
    toolCallID: `call_${suffix}`,
  })
})

const spawnWorker = Effect.fnUntraced(function* (parentSessionID: SessionSchema.ID, suffix: string) {
  const tasks = yield* SessionTaskV2.Service
  const prepared = yield* tasks.spawn({
    actor: yield* actor(parentSessionID, `spawn_${suffix}`),
    agent: AgentV2.ID.make("explore"),
    model,
    prompt: Prompt.make({ text: `Work lane ${suffix}` }),
    description: `lane ${suffix}`,
    authority,
  })
  return prepared.task
})

const postPlan = (roomID: Contract.ID, actor: SwarmRoom.ActorRef, head: number) =>
  Effect.gen(function* () {
    const rooms = yield* SwarmRoom.Service
    return yield* rooms.post({
      roomID,
      actor,
      kind: "plan",
      text: "lane plan",
      payload: {
        lanes: [
          { key: "research", title: "Research" },
          { key: "audit", title: "Audit" },
        ],
      },
      baseRevision: head,
    })
  })

describe("SwarmRoom", () => {
  it.effect("opens one room per root session and derives the leader member", () =>
    Effect.gen(function* () {
      const root = yield* setup("open")
      const rooms = yield* SwarmRoom.Service
      const first = yield* rooms.open(root)
      const second = yield* rooms.open(root)
      expect(second.id).toBe(first.id)

      const state = yield* rooms.state(first.id)
      expect(state.members).toEqual([
        expect.objectContaining({ type: "leader", sessionID: root, state: "active" }),
      ])
      expect(state.lanes).toEqual([])
    }),
  )

  it.effect("appends sequenced entries and pages them after a cursor", () =>
    Effect.gen(function* () {
      const root = yield* setup("entries")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      yield* rooms.post({ roomID: room.id, actor: leader, kind: "message", text: "first" })
      yield* rooms.post({ roomID: room.id, actor: leader, kind: "message", text: "second" })
      const third = (yield* rooms.post({ roomID: room.id, actor: leader, kind: "status", text: "third" })).entry

      const page = yield* rooms.read(room.id, { after: 1 })
      expect(page.entries.map((entry) => entry.text)).toEqual(["second", "third"])
      expect(page.head).toBe(3)
      expect(third.seq).toBe(3)
    }),
  )

  it.effect("rejects coordination writes against a stale head", () =>
    Effect.gen(function* () {
      const root = yield* setup("cas")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      yield* postPlan(room.id, leader, room.head)

      const stale = yield* Effect.flip(postPlan(room.id, leader, room.head))
      expect(stale).toBeInstanceOf(Contract.ConflictError)

      const missing = yield* Effect.flip(rooms.post({
        roomID: room.id,
        actor: leader,
        kind: "decision",
        text: "no base revision",
      }))
      expect(missing).toBeInstanceOf(Contract.InvalidStateError)
    }),
  )

  it.effect("claims lanes exclusively and releases them for re-claim", () =>
    Effect.gen(function* () {
      const root = yield* setup("claims")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      const plan = yield* postPlan(room.id, leader, room.head)

      const task = yield* spawnWorker(root, "claims")
      const worker: SwarmRoom.ActorRef = { sessionID: task.childSessionID }

      const claim = (yield* rooms.claim({ roomID: room.id, actor: worker, lane: Contract.LaneKey.make("research"), baseRevision: plan.entry.seq })).entry
      expect(claim.kind).toBe("claim")
      expect(claim.actor.type).toBe("worker")

      const conflict = yield* Effect.flip(
        rooms.claim({ roomID: room.id, actor: leader, lane: Contract.LaneKey.make("research"), baseRevision: claim.seq }),
      )
      expect(conflict).toBeInstanceOf(Contract.ConflictError)

      const unknown = yield* Effect.flip(
        rooms.claim({ roomID: room.id, actor: leader, lane: Contract.LaneKey.make("missing"), baseRevision: claim.seq }),
      )
      expect(unknown).toBeInstanceOf(Contract.InvalidStateError)

      const sibling = yield* spawnWorker(root, "claims-sibling")
      const stolen = yield* Effect.flip(
        rooms.post({
          roomID: room.id,
          actor: { sessionID: sibling.childSessionID },
          kind: "release",
          text: "releasing research",
          payload: { lane: "research" },
          baseRevision: claim.seq,
        }),
      )
      expect(stolen).toBeInstanceOf(Contract.ForbiddenError)

      yield* rooms.post({
        roomID: room.id,
        actor: worker,
        kind: "release",
        text: "releasing research",
        payload: { lane: "research" },
        baseRevision: claim.seq,
      })
      const state = yield* rooms.state(room.id)
      expect(state.lanes.find((lane) => lane.key === "research")).toMatchObject({ status: "open" })
      expect(state.members).toContainEqual(
        expect.objectContaining({ type: "worker", sessionID: task.childSessionID }),
      )
    }),
  )

  it.effect("forbids workers from posting plans and decisions", () =>
    Effect.gen(function* () {
      const root = yield* setup("authz")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const task = yield* spawnWorker(root, "authz")
      const worker: SwarmRoom.ActorRef = { sessionID: task.childSessionID }

      const denied = yield* Effect.flip(postPlan(room.id, worker, room.head))
      expect(denied).toBeInstanceOf(Contract.ForbiddenError)

      // A non-member session cannot post at all.
      const outsider = yield* setup("outsider")
      const rejected = yield* Effect.flip(
        rooms.post({ roomID: room.id, actor: { sessionID: outsider }, kind: "message", text: "hello" }),
      )
      expect(rejected).toBeInstanceOf(Contract.ForbiddenError)
    }),
  )

  it.effect("admits one coalesced advisory per member session", () =>
    Effect.gen(function* () {
      const root = yield* setup("advisory")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const task = yield* spawnWorker(root, "advisory")
      const worker: SwarmRoom.ActorRef = { sessionID: task.childSessionID }

      yield* rooms.post({ roomID: room.id, actor: worker, kind: "finding", text: "found one" })
      yield* rooms.post({ roomID: room.id, actor: worker, kind: "finding", text: "found two" })

      const { db } = yield* Database.Service
      const advisories = yield* db
        .select()
        .from(SessionInputTable)
        .where(
          and(eq(SessionInputTable.session_id, root), eq(SessionInputTable.source, "swarm_room")),
        )
        .all()
        .pipe(Effect.orDie)
      expect(advisories).toHaveLength(1)
    }),
  )

  it.effect("posts human messages through a durable member", () =>
    Effect.gen(function* () {
      const root = yield* setup("human")
      const rooms = yield* SwarmRoom.Service
      const entry = (yield* rooms.postHuman(root, { text: "focus the audit lane", name: "tom" })).entry
      expect(entry.actor.type).toBe("human")
      expect(entry.actor.name).toBe("tom")

      const state = yield* rooms.state(entry.roomID)
      expect(state.members).toContainEqual(expect.objectContaining({ type: "human", name: "tom" }))

      // Humans may steer coordination like the leader.
      const plan = (yield* rooms.post({
        roomID: entry.roomID,
        actor: { memberID: entry.actor.memberID },
        kind: "decision",
        text: "drop the perf lane",
        baseRevision: entry.seq,
      })).entry
      expect(plan.kind).toBe("decision")
    }),
  )

  it.effect("lets chatter and claims proceed while sibling messages land", () =>
    Effect.gen(function* () {
      const root = yield* setup("fanout")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      const plan = yield* postPlan(room.id, leader, room.head)

      // Two workers read the room at the plan's head, then messages land —
      // neither findings nor claims should conflict on the moved head.
      yield* rooms.post({ roomID: room.id, actor: leader, kind: "finding", text: "noise", baseRevision: 0 })
      const chatter = yield* rooms.post({
        roomID: room.id,
        actor: leader,
        kind: "finding",
        text: "stale-head finding",
        baseRevision: 1,
      })
      expect(chatter.entry.seq).toBe(3)

      const task = yield* spawnWorker(root, "fanout")
      const claim = yield* rooms.claim({
        roomID: room.id,
        actor: { sessionID: task.childSessionID },
        lane: Contract.LaneKey.make("research"),
        baseRevision: plan.entry.seq,
      })
      expect(claim.entry.kind).toBe("claim")
    }),
  )

  it.effect("conflicts claims read before a newer plan", () =>
    Effect.gen(function* () {
      const root = yield* setup("stale-plan")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      const first = yield* postPlan(room.id, leader, room.head)
      const task = yield* spawnWorker(root, "stale-plan")
      const worker: SwarmRoom.ActorRef = { sessionID: task.childSessionID }

      const head = (yield* rooms.post({
        roomID: room.id,
        actor: leader,
        kind: "plan",
        text: "revised plan",
        payload: { lanes: [{ key: "audit", title: "Audit" }] },
        baseRevision: first.entry.seq,
      })).entry.seq

      const stale = yield* Effect.flip(
        rooms.claim({
          roomID: room.id,
          actor: worker,
          lane: Contract.LaneKey.make("research"),
          baseRevision: first.entry.seq,
        }),
      )
      expect(stale).toBeInstanceOf(Contract.ConflictError)

      const state = yield* rooms.state(room.id)
      expect(head).toBe(first.entry.seq + 1)
      expect(state.lanes.map((lane) => String(lane.key))).toEqual(["audit"])
    }),
  )

  it.effect("reads the tail by default and pages forward with a cursor", () =>
    Effect.gen(function* () {
      const root = yield* setup("tail")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      for (const text of ["one", "two", "three", "four"])
        yield* rooms.post({ roomID: room.id, actor: leader, kind: "message", text })

      const tail = yield* rooms.read(room.id, { limit: 2 })
      expect(tail.entries.map((entry) => entry.text)).toEqual(["three", "four"])
      expect(tail.hasMore).toBe(true)

      const forward = yield* rooms.read(room.id, { after: 2, limit: 2 })
      expect(forward.entries.map((entry) => entry.text)).toEqual(["three", "four"])
      expect(forward.hasMore).toBe(false)
    }),
  )

  it.effect("dedupes same-name human members and keeps them through the stream", () =>
    Effect.gen(function* () {
      const root = yield* setup("dup-human")
      const rooms = yield* SwarmRoom.Service
      yield* rooms.postHuman(root, { text: "one", name: "tom" })
      yield* rooms.postHuman(root, { text: "two", name: "tom" })

      const state = yield* rooms.state((yield* rooms.find(root))!.id)
      expect(state.members.filter((member) => member.name === "tom")).toHaveLength(1)
    }),
  )

  it.effect("parks a member until another member posts, skipping its own entries", () =>
    Effect.gen(function* () {
      const root = yield* setup("wait")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const task = yield* spawnWorker(root, "parked")
      const worker = task.childSessionID
      const leader: SwarmRoom.ActorRef = { sessionID: root }

      const own = (yield* rooms.post({ roomID: room.id, actor: { sessionID: worker }, kind: "status", text: "lane done" }))
        .entry
      const parked = yield* rooms.wait(room.id, { sessionID: worker, timeoutMs: 30_000 }).pipe(
        Effect.forkChild,
      )
      // Let the parked fiber reach its subscription before posting.
      yield* Effect.yieldNow
      const reply = (yield* rooms.post({ roomID: room.id, actor: leader, kind: "message", text: "still there?" })).entry

      const woken = yield* Fiber.join(parked)
      expect(woken.timedOut).toBe(false)
      // Only the leader's entry wakes it — the member's own post is skipped.
      expect(woken.entries.map((entry) => entry.id)).toEqual([reply.id])
      expect(woken.entries[0]!.seq).toBeGreaterThan(own.seq)
    }),
  )

  it.effect("returns entries already posted after `after` without parking", () =>
    Effect.gen(function* () {
      const root = yield* setup("wait-backlog")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      const posted = (yield* rooms.post({ roomID: room.id, actor: leader, kind: "message", text: "already here" })).entry

      const result = yield* rooms.wait(room.id, { sessionID: SessionSchema.ID.make("ses_other"), after: 0, timeoutMs: 60_000 })
      expect(result.timedOut).toBe(false)
      expect(result.entries.map((entry) => entry.id)).toContain(posted.id)
    }),
  )

  it.effect("returns timed_out when nothing arrives before the deadline", () =>
    Effect.gen(function* () {
      const root = yield* setup("wait-timeout")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const parked = yield* rooms.wait(room.id, { sessionID: root, timeoutMs: 1_500 }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* TestClock.adjust("3 seconds")
      const result = yield* Fiber.join(parked)
      expect(result.timedOut).toBe(true)
      expect(result.entries).toHaveLength(0)
    }),
  )

  it.effect("flags entries addressed to a lane's claimant as 'to you'", () =>
    Effect.gen(function* () {
      const root = yield* setup("addressed")
      const rooms = yield* SwarmRoom.Service
      const room = yield* rooms.open(root)
      const leader: SwarmRoom.ActorRef = { sessionID: root }
      const task = yield* spawnWorker(root, "claimed")
      const worker = task.childSessionID

      const head = (yield* rooms.state(room.id)).room.head
      const plan = yield* postPlan(room.id, leader, head)
      yield* rooms.claim({
        roomID: room.id,
        actor: { sessionID: worker },
        lane: Contract.LaneKey.make("research"),
        baseRevision: plan.entry.seq,
      })
      const question = (yield* rooms.post({
        roomID: room.id,
        actor: leader,
        kind: "question",
        text: "did you verify the timeout path?",
        to: "research",
      })).entry
      expect((question.payload as { to?: string }).to).toBe("research")

      const { db } = yield* Database.Service
      const inputs = yield* db
        .select()
        .from(SessionInputTable)
        .where(and(eq(SessionInputTable.session_id, worker), eq(SessionInputTable.source, "swarm_room")))
        .all()
        .pipe(Effect.orDie)
      const latest = inputs.at(-1)!.prompt as { text: string }
      expect(latest.text).toContain("addressed to you")
    }),
  )
})
