import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { AbsolutePath } from "@turenlabs/core/schema"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Reflection } from "@turenlabs/core/reflection"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { Storage } from "@turenlabs/core/storage"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Reflection.node, Storage.node])),
)
const directory = AbsolutePath.make("/tmp/forge-reflection")

const session = (
  id: string,
  projectID: Project.ID = Project.ID.global,
  parentID?: SessionV2.ID,
  locationDirectory = directory,
) =>
  SessionV2.Info.make({
    id: SessionV2.ID.make(id),
    projectID,
    parentID,
    title: "Reflection test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: locationDirectory },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  })

describe("Reflection", () => {
  it.effect("persists predictions and resolves hypotheses against evidence", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const current = yield* reflection.updateWork(SessionV2.ID.make("ses_reflection_work"), {
        prediction: "The targeted typecheck will pass",
        hypotheses: [{ claim: "The public type remains compatible", status: "open" }],
        nextAction: "Run bun typecheck",
      })

      expect(yield* reflection.work(SessionV2.ID.make("ses_reflection_work"))).toEqual(current)

      const resolved = yield* reflection.updateWork(SessionV2.ID.make("ses_reflection_work"), {
        prediction: current.prediction,
        hypotheses: [
          {
            claim: "The public type remains compatible",
            status: "supported",
            evidence: "bun typecheck exited 0",
          },
        ],
        nextAction: "Report the verified result",
      })
      expect(resolved.hypotheses[0]).toMatchObject({ status: "supported", evidence: "bun typecheck exited 0" })
    }),
  )

  it.effect("counts completed turns within one session and claims one periodic checkpoint", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const active = session("ses_reflection_active")
      const fresh = session("ses_reflection_fresh")

      expect(yield* reflection.recordCompletion({ session: active, completionID: "msg_first", interval: 2 })).toBe(
        false,
      )
      expect(yield* reflection.recordCompletion({ session: active, completionID: "msg_first", interval: 2 })).toBe(
        false,
      )
      expect(yield* reflection.recordCompletion({ session: active, completionID: "msg_second", interval: 2 })).toBe(
        true,
      )

      const prompt = yield* reflection.prompt({ session: active, interval: 2 })
      expect(prompt).toContain("<reflection_checkpoint>")
      expect(prompt).toContain("2 completed turns in this session")
      expect(prompt).toContain("Treat the current path as provisional")
      expect(prompt).toContain("Re-derive the problem from first principles")
      expect(prompt).toContain("not the fastest apparent completion")
      expect(prompt).toContain("smallest correct change and established design patterns")
      expect(yield* reflection.prompt({ session: fresh, interval: 2 })).toBeUndefined()
    }),
  )

  it.effect("excludes child and synthetic sessions from the cadence", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const parent = SessionV2.ID.make("ses_reflection_parent")
      expect(
        yield* reflection.recordCompletion({
          session: session("ses_reflection_child", Project.ID.make("reflection-exclusions"), parent),
          interval: 1,
        }),
      ).toBe(false)
      expect(
        yield* reflection.recordCompletion({
          session: session("ses_loop_reflection", Project.ID.make("reflection-exclusions")),
          interval: 1,
        }),
      ).toBe(false)
      expect(
        yield* reflection.recordCompletion({
          session: session("ses_pentest_reflection", Project.ID.make("reflection-exclusions")),
          interval: 1,
        }),
      ).toBe(false)
      expect(
        yield* reflection.recordCompletion({
          session: session("ses_handoff_reflection", Project.ID.make("reflection-exclusions")),
          interval: 1,
        }),
      ).toBe(false)
    }),
  )

  it.effect("removes session-local cadence, completion, and work state", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const active = session("ses_reflection_remove")
      yield* reflection.recordCompletion({ session: active, completionID: "msg_completed", interval: 1 })
      yield* reflection.updateWork(active.id, {
        prediction: "This state is session-owned",
        hypotheses: [],
        nextAction: "Delete the session",
      })

      expect(yield* reflection.due({ session: active, interval: 1 })).toBe(true)
      expect(yield* reflection.work(active.id)).toBeDefined()
      yield* reflection.remove(active.id)
      expect(yield* reflection.due({ session: active, interval: 1 })).toBe(false)
      expect(yield* reflection.work(active.id)).toBeUndefined()
    }),
  )

  it.effect("completes only the claimed checkpoint and requests a context reset", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const owner = session("ses_reflection_owner", Project.ID.make("reflection-completion"))
      yield* reflection.recordCompletion({ session: owner, interval: 1 })
      yield* reflection.prompt({ session: owner, interval: 1 })

      expect(
        yield* reflection.complete(owner, {
          critique: "The prior estimate ignored a generated caller.",
          lessons: ["Inspect generated consumers before changing shared schemas."],
          memories: ["Generated schema consumer boundary"],
        }),
      ).toBe(true)
      expect(yield* reflection.resetPending(owner.id)).toBe(true)
      yield* reflection.resetComplete(owner.id)
      expect(yield* reflection.resetPending(owner.id)).toBe(false)
      expect(yield* reflection.due({ session: owner, interval: 1 })).toBe(false)
    }),
  )

  it.effect("does not absorb later turns completed while a reflection is in progress", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const owner = session("ses_reflection_concurrent_owner", Project.ID.make("reflection-concurrency"))
      yield* reflection.recordCompletion({ session: owner, completionID: "msg_first", interval: 1 })
      yield* reflection.prompt({ session: owner, interval: 1 })
      yield* reflection.recordCompletion({ session: owner, completionID: "msg_second", interval: 1 })

      yield* reflection.complete(owner, { critique: "Checked the first session.", lessons: [], memories: [] })

      expect(yield* reflection.due({ session: owner, interval: 1 })).toBe(true)
      expect(yield* reflection.prompt({ session: owner, interval: 1 })).toContain("1 completed turn in this session")
    }),
  )

  it.effect("counts separate completed drains of the same root session", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const root = session("ses_reflection_reused_root", Project.ID.make("reflection-reused-root"))

      expect(yield* reflection.recordCompletion({ session: root, completionID: "msg_first", interval: 2 })).toBe(false)
      expect(yield* reflection.recordCompletion({ session: root, completionID: "msg_first", interval: 2 })).toBe(false)
      expect(yield* reflection.recordCompletion({ session: root, completionID: "msg_second", interval: 2 })).toBe(true)
    }),
  )

  it.effect("isolates reflection cadence between sessions in the same project", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const projectID = Project.ID.make("reflection-isolated-sessions")
      const first = session("ses_reflection_local_first", projectID)
      const second = session("ses_reflection_local_second", projectID)

      expect(yield* reflection.recordCompletion({ session: first, interval: 1 })).toBe(true)
      expect(yield* reflection.due({ session: second, interval: 1 })).toBe(false)
    }),
  )

  it.effect("uses the configured interval for turns completed during a reflection", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const owner = session("ses_reflection_configured_owner", Project.ID.make("reflection-configured-concurrency"))
      yield* reflection.recordCompletion({ session: owner, completionID: "msg_first", interval: 2 })
      yield* reflection.recordCompletion({ session: owner, completionID: "msg_second", interval: 2 })
      yield* reflection.prompt({ session: owner, interval: 2 })
      yield* reflection.recordCompletion({ session: owner, completionID: "msg_third", interval: 2 })

      yield* reflection.complete(owner, { critique: "Checked the first two sessions.", lessons: [], memories: [] })

      expect(yield* reflection.due({ session: owner, interval: 2 })).toBe(false)
      expect(yield* reflection.recordCompletion({ session: owner, completionID: "msg_fourth", interval: 2 })).toBe(true)
    }),
  )

  it.effect("does not claim a checkpoint when the provider turn has no tools", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const owner = session("ses_reflection_tools_disabled", Project.ID.make("reflection-tools-disabled"))
      yield* reflection.recordCompletion({ session: owner, interval: 1 })

      expect(yield* reflection.prompt({ session: owner, interval: 1, claim: false })).toBeUndefined()
      expect(yield* reflection.prompt({ session: owner, interval: 1 })).toContain("<reflection_checkpoint>")
    }),
  )

  it.effect("reconciles an uncounted completed assistant after a crash", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const { db } = yield* Database.Service
      const root = session("ses_reflection_crash_reconcile", Project.ID.make("reflection-crash-reconcile"))
      yield* db
        .insert(ProjectTable)
        .values({ id: root.projectID, worktree: root.location.directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: root.id,
          project_id: root.projectID,
          slug: root.id,
          directory: root.location.directory,
          title: root.title,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* reflection.reconcile({ session: root, interval: 1 })).toBe(0)
      expect(yield* reflection.due({ session: root, interval: 1 })).toBe(false)
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(root.id)])
        .run()
        .pipe(Effect.orDie)

      expect(yield* reflection.reconcile({ session: root, interval: 1 })).toBe(1)
      expect(yield* reflection.due({ session: root, interval: 1 })).toBe(true)
      expect(yield* reflection.reconcile({ session: root, interval: 1 })).toBe(1)
    }),
  )

  it.effect("does not reconcile a sibling session's missed completion", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const { db } = yield* Database.Service
      const projectID = Project.ID.make("reflection-sibling-reconcile")
      const missed = session("ses_reflection_sibling_missed", projectID)
      const active = session("ses_reflection_sibling_active", projectID)
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(
          [missed, active].map((root) => ({
            id: root.id,
            project_id: root.projectID,
            slug: root.id,
            directory: root.location.directory,
            title: root.title,
            version: "test",
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(missed.id)])
        .run()
        .pipe(Effect.orDie)

      expect(yield* reflection.reconcile({ session: active, interval: 1 })).toBe(0)
      expect(yield* reflection.due({ session: active, interval: 1 })).toBe(false)
      expect(yield* reflection.reconcile({ session: missed, interval: 1 })).toBe(0)
      expect(yield* reflection.due({ session: missed, interval: 1 })).toBe(false)
    }),
  )

  it.effect("does not count an older completion behind an incomplete latest turn", () =>
    Effect.gen(function* () {
      const reflection = yield* Reflection.Service
      const { db } = yield* Database.Service
      const projectID = Project.ID.make("reflection-incomplete-latest")
      const root = session("ses_reflection_incomplete_latest", projectID)
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: root.id,
          project_id: root.projectID,
          slug: root.id,
          directory: root.location.directory,
          title: root.title,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(root.id), assistantRow(root.id, 2, false)])
        .run()
        .pipe(Effect.orDie)

      expect(yield* reflection.reconcile({ session: root, interval: 1 })).toBe(0)
      expect(yield* reflection.due({ session: root, interval: 1 })).toBe(false)
    }),
  )
})

function assistantRow(sessionID: SessionV2.ID, seq = 1, completed = true) {
  const messageID = SessionMessage.ID.make(`msg_reflection_crash_completed_${sessionID}_${seq}`)
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(
    SessionMessage.Assistant.make({
      id: messageID,
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      content: [],
      ...(completed ? { finish: "stop" } : {}),
      time: { created: DateTime.makeUnsafe(seq), ...(completed ? { completed: DateTime.makeUnsafe(seq + 1) } : {}) },
    }),
  )
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, time_created: seq, data }
}
