import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { EventTable } from "@turenlabs/core/event/sql"
import { AgentV2 } from "@turenlabs/core/agent"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionEvent } from "@turenlabs/core/session/event"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { Prompt, TextPart } from "@turenlabs/core/session/prompt"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { testEffect } from "./lib/effect"

const executionCalls: SessionV2.ID[] = []
const interruptCalls: SessionV2.ID[] = []
const wakeCalls: SessionV2.ID[] = []
const activeSessions = new Set<SessionV2.ID>()
let interruptEffect = (_sessionID: SessionV2.ID): Effect.Effect<void, unknown> => Effect.void
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(activeSessions)),
    claimResume: (sessionID) =>
      Effect.succeed(
        Effect.sync(() => {
          executionCalls.push(sessionID)
        }),
      ),
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
        activeSessions.delete(sessionID)
      }).pipe(Effect.andThen(Effect.suspend(() => interruptEffect(sessionID))), Effect.orDie),
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ProjectV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionTaskV2.node,
      SessionV2.node,
    ]),
    [[SessionExecution.node, execution]],
  ),
)
const sessionID = SessionV2.ID.make("ses_prompt_test")
const messageID = SessionMessage.ID.create()
const projectDirectory = AbsolutePath.make(import.meta.dir)
const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("model"),
})

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const projects = yield* ProjectV2.Service
  const project = yield* projects.resolve(projectDirectory)
  yield* db
    .insert(ProjectTable)
    .values({ id: project.id, worktree: project.directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: project.id,
      slug: "test",
      directory: projectDirectory,
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return project
})

const admitted = (id: SessionMessage.ID) => Database.Service.use(({ db }) => SessionInput.find(db, id))
const admittedCount = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

const prepareSpawnActor = (callID: string) =>
  Effect.gen(function* () {
    const assistantMessageID = SessionMessage.ID.make(`msg_${callID}`)
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
      callID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      name: "spawn_agent",
    })
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      callID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      text: "{}",
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      callID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      tool: "spawn_agent",
      input: {},
      provider: { executed: false },
    })
    return { assistantMessageID, callID }
  })

describe("SessionV2.prompt", () => {
  it.effect("durably normalizes leading swarm requests before exact-retry admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const id = SessionMessage.ID.make("msg_swarm_durable_admission")
      const request = {
        sessionID,
        id,
        prompt: { text: "@swarm 30 compare X, Y, and our implementation" },
        resume: false,
      } as const

      const first = yield* session.prompt(request)
      const retried = yield* session.prompt(request)

      expect(retried).toEqual(first)
      expect(first.prompt.parts?.at(-1)).toMatchObject({
        synthetic: true,
        metadata: {
          forgeSwarm: {
            status: "ready",
            objective: "compare X, Y, and our implementation",
            count: 30,
            explicitCount: true,
          },
        },
      })
      expect(first.prompt.parts?.at(-1)?.text).toContain("final wait_agents barrier")
      expect(yield* admitted(id)).toEqual(first)
    }),
  )

  it.effect("cancels a pending durable input before it can be promoted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const id = SessionMessage.ID.make("msg_automation_cancel_pending")
      yield* session.prompt({ sessionID, id, prompt: { text: "cancel me" }, resume: false })

      expect(yield* session.cancelPendingInput({ sessionID, messageID: id })).toBe(true)
      expect(yield* session.cancelPendingInput({ sessionID, messageID: id })).toBe(false)
      expect(yield* Database.Service.use(({ db }) => SessionInput.hasPending(db, sessionID, "steer"))).toBe(false)
    }),
  )

  it.effect("lists only durable inputs still awaiting promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const first = yield* session.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_pending_list_first"),
        prompt: { text: "First queued message" },
        delivery: "queue",
        resume: false,
      })
      const cancelled = yield* session.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_pending_list_cancelled"),
        prompt: { text: "Cancelled queued message" },
        delivery: "queue",
        resume: false,
      })

      yield* session.cancelPendingInput({ sessionID, messageID: cancelled.id })
      expect(yield* session.pendingInputs(sessionID)).toEqual([first])

      yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(yield* session.pendingInputs(sessionID)).toEqual([])
    }),
  )

  it.effect("promotes a consecutive run of machine advisories in one boundary without jumping a queued user input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const admit = (id: string, text: string, source?: SessionInput.Source) =>
        SessionInput.admit(db, events, {
          id: SessionMessage.ID.make(id),
          sessionID,
          prompt: Prompt.make({ text }),
          delivery: "queue",
          source,
          kind: "prompt",
        })
      yield* admit("msg_advisory_first", "Settle notice one", "subagent_settle")
      yield* admit("msg_advisory_second", "Board update", "subagent_board")
      yield* admit("msg_queued_user", "Queued user instruction")
      yield* admit("msg_advisory_last", "Settle notice two", "subagent_settle")

      const pendingIDs = () => session.pendingInputs(sessionID).pipe(Effect.map((items) => items.map((item) => String(item.id))))

      yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(yield* pendingIDs()).toEqual(["msg_queued_user", "msg_advisory_last"])
      yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(yield* pendingIDs()).toEqual(["msg_advisory_last"])
      yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(yield* pendingIDs()).toEqual([])
    }),
  )

  it.effect("projects admitted, promoted, and cancelled input lifecycle by stable ID", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const promoted = yield* session.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_outbox_promoted"),
        prompt: { text: "Promote me" },
        delivery: "queue",
        resume: false,
      })
      const cancelled = yield* session.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_outbox_cancelled"),
        prompt: { text: "Cancel me" },
        delivery: "queue",
        resume: false,
      })

      expect(yield* session.inputStatus({ sessionID, messageID: promoted.id })).toMatchObject({
        id: promoted.id,
        status: "admitted",
      })
      yield* SessionInput.promoteNextQueued(db, events, sessionID)
      expect(yield* session.inputStatus({ sessionID, messageID: promoted.id })).toMatchObject({
        id: promoted.id,
        status: "promoted",
      })
      yield* session.cancelPendingInput({ sessionID, messageID: cancelled.id })
      expect(yield* session.inputStatus({ sessionID, messageID: cancelled.id })).toMatchObject({
        id: cancelled.id,
        status: "cancelled",
      })
      expect(
        yield* session.inputStatus({
          sessionID,
          messageID: SessionMessage.ID.make("msg_outbox_missing"),
        }),
      ).toBeUndefined()
    }),
  )

  it.effect("pages durable input lifecycle in admission order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const first = yield* session.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_outbox_page_first"),
        prompt: { text: "First" },
        resume: false,
      })
      const second = yield* session.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_outbox_page_second"),
        prompt: { text: "Second" },
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

      const page1 = yield* session.outbox({ sessionID, limit: 1 })
      expect(page1.items.map((item) => item.id)).toEqual([first.id])
      expect(page1.next).toBeDefined()
      const page2 = yield* session.outbox({ sessionID, limit: 1, cursor: page1.next })
      expect(page2.items.map((item) => item.id)).toEqual([second.id])
      expect(page2.next).toBeUndefined()
      expect(page2.items[0]?.status).toBe("promoted")
    }),
  )

  it.effect("exposes the execution registry", () =>
    Effect.gen(function* () {
      activeSessions.add(sessionID)
      expect(Array.from(yield* (yield* SessionV2.Service).active)).toEqual([sessionID])
    }).pipe(Effect.ensuring(Effect.sync(() => activeSessions.clear()))),
  )

  it.effect("delegates execution continuation through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("schedules an advisory wake without joining the execution drain", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.wake(sessionID)

      expect(wakeCalls).toEqual([sessionID])
      expect(executionCalls).toEqual([])
    }),
  )

  it.effect("delegates process-local interruption through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      interruptCalls.length = 0
      activeSessions.add(sessionID)

      yield* session.interrupt(sessionID)
      expect(interruptCalls).toEqual([sessionID])
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("interrupts every process-local active root", () =>
    Effect.gen(function* () {
      const secondSessionID = SessionV2.ID.make("ses_interrupt_all_second")
      const session = yield* SessionV2.Service
      interruptCalls.length = 0
      activeSessions.add(sessionID)
      activeSessions.add(secondSessionID)

      expect(yield* session.interruptAll()).toEqual({ interrupted: 2, failed: 0 })
      expect(new Set(interruptCalls)).toEqual(new Set([sessionID, secondSessionID]))
    }).pipe(Effect.ensuring(Effect.sync(() => activeSessions.clear()))),
  )

  it.effect("rejects direct mutation of a task-owned child Session", () =>
    Effect.gen(function* () {
      yield* setup
      const actor = yield* prepareSpawnActor("call_task_owned_parent")
      const tasks = yield* SessionTaskV2.Service
      const created = yield* tasks.spawn({
        actor: SessionTaskV2.Actor.make({
          sessionID,
          assistantMessageID: actor.assistantMessageID,
          toolCallID: actor.callID,
        }),
        agent: AgentV2.ID.make("build"),
        model,
        prompt: Prompt.make({ text: "Work only through the parent task" }),
        description: "Owned child",
        authority: SessionTaskV2.Authority.make({
          parentPermissions: [],
          ancestorPermissionSets: [],
          childPermissions: [],
          hardPermissions: [],
          writeRoots: [],
          commands: [],
        }),
      })
      const session = yield* SessionV2.Service

      expect(
        yield* session
          .prompt({
            sessionID: created.task.childSessionID,
            prompt: Prompt.make({ text: "Bypass parent" }),
            resume: false,
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "SessionTask.OwnedSessionError",
        sessionID: created.task.childSessionID,
        taskID: created.task.id,
      })
      expect(
        yield* session
          .switchAgent({ sessionID: created.task.childSessionID, agent: AgentV2.ID.make("plan") })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "SessionTask.OwnedSessionError",
        taskID: created.task.id,
      })
      expect(
        yield* (yield* Database.Service).db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, created.task.childSessionID))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.prompt)),
          ),
      ).toEqual([created.task.prompt])
    }),
  )

  it.effect("cancels a child admitted while parent interruption settles", () =>
    Effect.gen(function* () {
      yield* setup
      const actor = yield* prepareSpawnActor("call_interrupt_spawn_race")
      const tasks = yield* SessionTaskV2.Service
      const spawned = yield* Deferred.make<SessionTaskV2.Info>()
      activeSessions.add(sessionID)
      interruptEffect = (interruptedSessionID) => {
        if (interruptedSessionID !== sessionID) return Effect.void
        interruptEffect = () => Effect.void
        return tasks
          .spawn({
            actor: SessionTaskV2.Actor.make({
              sessionID,
              assistantMessageID: actor.assistantMessageID,
              toolCallID: actor.callID,
            }),
            agent: AgentV2.ID.make("build"),
            model,
            prompt: Prompt.make({ text: "Admitted during parent interruption" }),
            description: "Racing child",
            authority: SessionTaskV2.Authority.make({
              parentPermissions: [],
              ancestorPermissionSets: [],
              childPermissions: [],
              hardPermissions: [],
              writeRoots: [],
              commands: [],
            }),
          })
          .pipe(
            Effect.tap((prepared) =>
              Effect.sync(() => activeSessions.add(prepared.task.childSessionID)).pipe(
                Effect.andThen(Deferred.succeed(spawned, prepared.task)),
              ),
            ),
            Effect.asVoid,
          )
      }

      const result = yield* (yield* SessionV2.Service).interruptAll()
      const task = yield* Deferred.await(spawned)

      expect(result).toEqual({ interrupted: 1, failed: 0 })
      expect(yield* tasks.get(task.id)).toMatchObject({ status: "cancelled" })
      expect(interruptCalls).toContain(task.childSessionID)
      expect(activeSessions.has(task.childSessionID)).toBe(false)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          interruptEffect = () => Effect.void
          activeSessions.clear()
        }),
      ),
    ),
  )

  it.effect("delegates interruption without requiring a recorded Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      interruptCalls.length = 0
      const missing = SessionV2.ID.make("ses_missing")
      activeSessions.add(missing)

      yield* session.interrupt(missing)
      expect(interruptCalls).toEqual([missing])
    }),
  )

  it.effect("durably admits one user message before transcript promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      expect(message.prompt.text).toBe("Fix the failing tests")
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).toMatchObject({
        id: message.id,
        sessionID,
        prompt: { text: "Fix the failing tests" },
        delivery: "steer",
      })
    }),
  )

  it.effect("resolves attachment MIME before admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: {
          text: "Inspect this image",
          files: [{ uri: "data:image/png;base64,aGVsbG8=", name: "image.png" }],
        },
        resume: false,
      })

      expect(message.prompt.files).toEqual([
        { uri: "data:image/png;base64,aGVsbG8=", name: "image.png", mime: "image/png" },
      ])
      expect((yield* admitted(message.id))?.prompt.files).toEqual(message.prompt.files)
    }),
  )

  it.effect("streams durable Session events after an aggregate sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const fiber = yield* session.events({ sessionID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const streamed = Array.from(yield* Fiber.join(fiber))

      expect(streamed.map((event) => [event.durable?.seq, event.type])).toEqual([
        [0, "session.next.prompt.admitted"],
        [1, "session.next.prompt.admitted"],
        [2, "session.next.prompted"],
        [3, "session.next.prompted"],
      ])
      expect(
        Array.from(
          yield* session
            .events({ sessionID, after: streamed[0]!.durable?.seq })
            .pipe(Stream.take(1), Stream.runCollect),
        ).map((event) => [event.durable?.seq, event.type]),
      ).toEqual([[1, "session.next.prompt.admitted"]])
    }),
  )

  it.effect("resumes through a recorded message without appending another prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)

      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records distinct messages when the ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = { sessionID, prompt: Prompt.make({ text: "Fix the failing tests" }), resume: false }

      const first = yield* session.prompt(input)
      const second = yield* session.prompt(input)

      expect(second.id).not.toBe(first.id)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(2)
    }),
  )

  it.effect("returns the original recorded message when the ID is retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const first = yield* session.prompt(input)
      const retried = yield* session.prompt(input)

      expect(retried).toEqual(first)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("atomically retains each prompt route and reconciles a lost response after selection drift", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const firstID = SessionMessage.ID.make("msg_prompt_route_first")
      const secondID = SessionMessage.ID.make("msg_prompt_route_second")
      const firstAgent = AgentV2.ID.make("build")
      const secondAgent = AgentV2.ID.make("review")
      const firstModel = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("first-provider"),
        id: ModelV2.ID.make("first-model"),
      })
      const secondModel = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("second-provider"),
        id: ModelV2.ID.make("second-model"),
      })
      const firstInput = {
        sessionID,
        id: firstID,
        prompt: Prompt.make({ text: "Use the first route" }),
        agent: firstAgent,
        model: firstModel,
        resume: false,
      }

      const [first, second] = yield* Effect.all(
        [
          session.prompt(firstInput),
          session.prompt({
            sessionID,
            id: secondID,
            prompt: Prompt.make({ text: "Use the second route" }),
            agent: secondAgent,
            model: secondModel,
            resume: false,
          }),
        ],
        { concurrency: "unbounded" },
      )
      yield* session.switchAgent({ sessionID, agent: secondAgent })
      yield* session.switchModel({ sessionID, model: secondModel })

      const retried = yield* session.prompt(firstInput)
      const conflictingRoute = yield* session
        .prompt({ ...firstInput, agent: secondAgent, model: secondModel })
        .pipe(Effect.flip)
      const rows = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      expect(first).toMatchObject({ id: firstID, agent: firstAgent, model: firstModel })
      expect(second).toMatchObject({ id: secondID, agent: secondAgent, model: secondModel })
      expect(retried).toEqual(first)
      expect(conflictingRoute._tag).toBe("Session.PromptConflictError")
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: firstID, agent: firstAgent, model: firstModel }),
          expect.objectContaining({ id: secondID, agent: secondAgent, model: secondModel }),
        ]),
      )
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(2)
    }),
  )

  it.effect("includes structured text parts in exact-retry equivalence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const prompt = Prompt.make({
        text: "Review this line",
        parts: [
          TextPart.make({
            id: "prt_review",
            text: "Review this line",
            synthetic: true,
            metadata: {
              forgeComment: {
                path: "src/index.ts",
                comment: "Handle the empty case",
                origin: "review",
              },
            },
          }),
        ],
      })
      const first = yield* session.prompt({ sessionID, id: messageID, prompt, resume: false })
      const retried = yield* session.prompt({ sessionID, id: messageID, prompt, resume: false })
      const conflict = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({
            ...prompt,
            parts: prompt.parts?.map((part) => ({ ...part, ignored: true })),
          }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(retried).toEqual(first)
      expect(conflict._tag).toBe("Session.PromptConflictError")
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("wakes execution when an exact prompt retry recovers a committed message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Recover committed prompt" }),
        resume: false,
      }
      const first = yield* session.prompt(input)
      wakeCalls.length = 0

      const retried = yield* session.prompt({ ...input, resume: true })

      expect(retried).toEqual(first)
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("rejects reuse of one ID with a different prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({ text: "Delete the failing tests" }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* session.messages({ sessionID })).toHaveLength(0)
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("rejects reuse of one ID with a different delivery mode", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })
      const failure = yield* session
        .prompt({
          id: messageID,
          sessionID,
          prompt: Prompt.make({ text: "Fix the failing tests" }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("returns one recorded message to concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const messages = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(messages[1]).toEqual(messages[0])
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
    }),
  )

  it.effect("promotes one message once under concurrent promotion attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Promote once" }), resume: false })

      yield* Effect.all(
        [
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* eventCount(EventV2.versionedType(SessionEvent.Prompted.type, 1))).toBe(1)
      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Promote once" },
      ])
    }),
  )

  it.effect("promotes steers only through the captured inbox cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Before cutoff" }), resume: false })
      const cutoff = first.admittedSeq
      const second = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "After cutoff" }), resume: false })

      yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)

      expect(yield* admitted(first.id)).toHaveProperty("promotedSeq")
      expect(yield* admitted(second.id)).not.toHaveProperty("promotedSeq")
    }),
  )

  it.effect("reprojects pending inbox input without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      wakeCalls.length = 0
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Replay pending" }),
        resume: false,
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect(yield* admitted(messageID)).toMatchObject({ id: messageID, prompt: { text: "Replay pending" } })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("returns an exact retry of a legacy projected prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical prompt" } })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")
    }),
  )

  it.effect("returns an exact retry of a legacy projected queued prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical queued prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "queue",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, delivery: "queue", resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical queued prompt" } })
      expect(yield* admitted(messageID)).toMatchObject({ delivery: "queue" })
    }),
  )

  it.effect("rejects reuse of one globally unique message ID across sessions", () =>
    Effect.gen(function* () {
      const project = yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const other = SessionV2.ID.make("ses_prompt_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: project.id,
          slug: "other",
          directory: projectDirectory,
          title: "other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const prompt = Prompt.make({ text: "Fix the failing tests" })

      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })
      const failure = yield* session
        .prompt({ id: messageID, sessionID: other, prompt, resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID: other, messageID })
    }),
  )

  it.effect("rejects a prompt ID already used by visible Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: "Existing history",
      })

      const failure = yield* session
        .prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Conflicting prompt" }), resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID })
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )

  it.effect("starts execution by default after recording the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run by default" }) })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("starts execution when resume is explicitly true", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run explicitly" }),
        resume: true,
      })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("only records the prompt when resume is false", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not run" }), resume: false })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  // This service is a global node, so none of these entry points has a
  // Location.Service in context and each frame publishes unlocated unless the
  // Session's placement is passed at publish time. Per-instance event streams
  // drop unlocated frames, so an admitted prompt or a switched agent never
  // reaches a live client. See the filter in
  // packages/forge/src/server/routes/instance/httpapi/handlers/event.ts.
  it.effect("locates the frames a mutation publishes from the global Session fiber", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const seen: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => seen.push(event)))
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* session.prompt({
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: Prompt.make({ text: "Reach the client watching this directory" }),
        resume: false,
      })
      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("plan") })
      yield* session.switchModel({ sessionID, model })

      const located = (type: string) => {
        const frames = seen.filter((event) => event.type === type)
        expect([type, frames.length]).toEqual([type, 1])
        return [type, frames[0]!.location?.directory]
      }
      expect(located(SessionEvent.PromptAdmitted.type)).toEqual([SessionEvent.PromptAdmitted.type, projectDirectory])
      expect(located(SessionEvent.AgentSwitched.type)).toEqual([SessionEvent.AgentSwitched.type, projectDirectory])
      expect(located(SessionEvent.ModelSwitched.type)).toEqual([SessionEvent.ModelSwitched.type, projectDirectory])
    }),
  )
})
