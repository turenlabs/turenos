import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { LobbySession } from "@turenlabs/schema/lobby-session"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { PermissionV2 } from "@turenlabs/core/permission"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { Storage } from "@turenlabs/core/storage"
import { PermissionTable } from "@turenlabs/core/permission/sql"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Storage.node,
      PermissionChecks.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

const watcher = { polls: 0, started: 0, stopped: 0 }
const abortIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Storage.node,
      PermissionChecks.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [
      [Location.node, current],
      [
        PermissionChecks.node,
        Layer.succeed(
          PermissionChecks.Service,
          PermissionChecks.Service.of({
            enforced: () => Effect.succeed(true),
            set: () => Effect.void,
            untilDisabled: () =>
              Effect.gen(function* () {
                watcher.started++
                while (true) {
                  watcher.polls++
                  yield* Effect.yieldNow
                }
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    watcher.stopped++
                  }),
                ),
              ),
          }),
        ),
      ],
    ],
  ),
)

let taskAuthority: SessionTaskV2.Authority | undefined
const authorityIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Storage.node,
      PermissionChecks.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [
      [Location.node, current],
      [
        SessionTaskV2.node,
        Layer.mock(SessionTaskV2.Service, {
          authority: () => Effect.succeed(taskAuthority),
        }),
      ],
    ],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    yield* (yield* PermissionChecks.Service).set(true)
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("treats invalid persisted permission policy as disabled", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.set({
        scope: Storage.Scope.make("internal/permissions"),
        key: Storage.Key.make("enforce_checks"),
        value: "invalid",
      })
      expect(yield* PermissionChecks.enforced()).toBe(false)
    }),
  )

  it.effect("allows ask rules by default while preserving explicit denies", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* (yield* PermissionChecks.Service).set(false)
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("intersects lobby capability metadata with agent permissions", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          metadata: {
            [LobbySession.MetadataKey]: {
              baseURL: "http://127.0.0.1:8787",
              roomID: "room_test",
              agentMemberID: "forge-agent-test",
              capabilityProfile: "workspace",
            },
          },
        })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const service = yield* PermissionV2.Service

      yield* service.assert(assertion({ action: "read" }))
      yield* service.assert(assertion({ action: "edit" }))
      expect(
        yield* service
          .assert(
            assertion({
              action: "external_directory",
              resources: ["/private/**"],
              metadata: { roomRequestedScope: "/private" },
            }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(PermissionV2.BlockedError)
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  authorityIt.effect("keeps every captured task ceiling independent and deny-dominant", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      yield* (yield* PermissionChecks.Service).set(false)
      yield* (yield* PermissionSaved.Service).add({
        projectID: Project.ID.global,
        action: "read",
        resources: ["src/index.ts"],
      })
      taskAuthority = SessionTaskV2.Authority.make({
        parentPermissions: [{ action: "read", resource: "*", effect: "allow" }],
        ancestorPermissionSets: [
          [{ action: "read", resource: "*", effect: "deny" }],
          [{ action: "read", resource: "*", effect: "allow" }],
        ],
        childPermissions: [{ action: "read", resource: "*", effect: "allow" }],
        hardPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        writeRoots: [],
        commands: [],
      })

      expect(yield* (yield* PermissionV2.Service).ask(assertion())).toMatchObject({ effect: "deny" })
    }),
  )

  authorityIt.effect("never lets disabled checks or saved approval bypass task hard scope", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      yield* (yield* PermissionChecks.Service).set(false)
      yield* (yield* PermissionSaved.Service).add({
        projectID: Project.ID.global,
        action: "edit",
        resources: ["src/private.ts"],
      })
      taskAuthority = SessionTaskV2.Authority.make({
        parentPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        ancestorPermissionSets: [],
        childPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        hardPermissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "deny" },
          { action: "edit", resource: "src/public/*", effect: "allow" },
        ],
        writeRoots: [AbsolutePath.make("/project/src/public")],
        commands: [],
      })
      const service = yield* PermissionV2.Service

      expect(
        yield* service.ask(
          assertion({
            action: "edit",
            resources: ["src/private.ts"],
            metadata: PermissionV2.mutationMetadata(["/project/src/private.ts"]),
          }),
        ),
      ).toMatchObject({ effect: "deny" })
      expect(
        yield* service.ask(
          assertion({
            action: "edit",
            resources: ["src/public/index.ts"],
            metadata: PermissionV2.mutationMetadata(["/project/src/public/index.ts"]),
          }),
        ),
      ).toMatchObject({ effect: "allow" })
      for (const input of [
        assertion({
          action: "edit",
          resources: ["/tmp/outside.txt"],
          metadata: PermissionV2.mutationMetadata(["/tmp/outside.txt"]),
        }),
        assertion({
          action: "external_directory",
          resources: ["/tmp/*"],
          metadata: PermissionV2.mutationMetadata(["/tmp/outside.txt"]),
        }),
        assertion({ action: "edit", resources: ["src/public/index.ts"] }),
      ])
        expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
    }),
  )

  authorityIt.effect("matches task shell commands exactly even when an allowed command contains glob characters", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      yield* (yield* PermissionChecks.Service).set(false)
      yield* (yield* PermissionSaved.Service).add({
        projectID: Project.ID.global,
        action: "bash",
        resources: ["rg secret.ts"],
      })
      taskAuthority = SessionTaskV2.Authority.make({
        parentPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        ancestorPermissionSets: [],
        childPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        hardPermissions: [{ action: "*", resource: "*", effect: "allow" }],
        writeRoots: [],
        commands: ["rg *.ts"],
      })
      const service = yield* PermissionV2.Service

      expect(
        yield* service.ask(assertion({ action: "bash", resources: ["rg *.ts"], metadata: { workdir: "." } })),
      ).toMatchObject({ effect: "allow" })
      for (const input of [
        assertion({ action: "bash", resources: ["rg secret.ts"], metadata: { workdir: "." } }),
        assertion({ action: "bash", resources: [" rg *.ts"], metadata: { workdir: "." } }),
        assertion({ action: "bash", resources: ["rg *.ts "], metadata: { workdir: "." } }),
        assertion({ action: "bash", resources: ["TOKEN=value rg *.ts"], metadata: { workdir: "." } }),
        assertion({ action: "bash", resources: ["rg *.ts"], metadata: { workdir: "src" } }),
        assertion({ action: "bash", resources: ["rg *.ts"], metadata: { workdir: "/tmp" } }),
      ])
        expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("releases a pending permission when checks are disabled", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* (yield* PermissionChecks.Service).set(false)
      yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
      expect(yield* service.get(request.id)).toBeUndefined()
      expect(yield* service.list()).toEqual([])
    }),
  )

  abortIt.effect("stops the disable watcher when an assertion is interrupted", () =>
    Effect.gen(function* () {
      watcher.polls = 0
      watcher.started = 0
      watcher.stopped = 0
      yield* setup()
      expect(watcher.started).toBe(0)
      const service = yield* PermissionV2.Service
      const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
      yield* Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

      expect(yield* service.list()).toHaveLength(1)
      expect(watcher.started).toBe(1)
      yield* Fiber.interrupt(fiber).pipe(Effect.forkDetach({ startImmediately: true }), Effect.asVoid)
      yield* Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })
      const polls = watcher.polls
      yield* Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

      expect(watcher.started).toBe(1)
      expect(watcher.stopped).toBe(1)
      expect(watcher.polls).toBe(polls)
    }),
  )

  it.live("releases API-created pending asks exactly once when checks are disabled", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const replies: { requestID: PermissionV2.ID; reply: PermissionV2.Reply }[] = []
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Replied.type
          ? Effect.sync(() => replies.push(event.data as (typeof replies)[number])).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const id = PermissionV2.ID.create("per_api")
      expect(yield* service.ask(assertion({ id }))).toEqual({ id, effect: "ask" })
      expect(yield* service.get(id)).toBeDefined()
      yield* (yield* PermissionChecks.Service).set(false)
      yield* Effect.gen(function* () {
        while (yield* service.get(id)) yield* Effect.sleep("10 millis")
      }).pipe(Effect.timeout("1 second"))

      const matched = replies.filter((reply) => reply.requestID === id)
      expect(matched).toHaveLength(1)
      expect(matched[0]).toMatchObject({ requestID: id, reply: "once" })
      expect(yield* service.reply({ requestID: id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        PermissionV2.NotFoundError,
      )
    }),
  )

  it.live("lets an explicit reply win once before a later disable", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const replies: { requestID: PermissionV2.ID; reply: PermissionV2.Reply }[] = []
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Replied.type
          ? Effect.sync(() => replies.push(event.data as (typeof replies)[number])).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const id = PermissionV2.ID.create("per_reply_wins")
      expect(yield* service.ask(assertion({ id }))).toMatchObject({ effect: "ask" })
      yield* service.reply({ requestID: id, reply: "once" })
      yield* (yield* PermissionChecks.Service).set(false)
      yield* Effect.sleep("300 millis")

      const matched = replies.filter((reply) => reply.requestID === id)
      expect(matched).toHaveLength(1)
      expect(matched[0]).toMatchObject({ requestID: id, reply: "once" })
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})
