import { PermissionV1 } from "@turenlabs/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Clock, Config, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { CrossSpawnSpawner } from "@turenlabs/core/cross-spawn-spawner"
import { Flag } from "@turenlabs/core/flag/flag"
import { Ripgrep } from "@turenlabs/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { createRoutes, HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { SessionTaskCursor, SessionTaskResponseLimits } from "@turenlabs/protocol/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Database } from "@turenlabs/core/database/database"
import { EventV2 } from "@turenlabs/core/event"
import { EventSequenceTable, EventTable } from "@turenlabs/core/event/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionExecution } from "@turenlabs/core/session/execution"
import { SessionInput } from "@turenlabs/core/session/input"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SessionTaskActorClaimTable, SessionTaskTable } from "@turenlabs/core/session/task.sql"
import { Loop } from "@turenlabs/core/loop"
import {
  MessageTable,
  SessionInputTable,
  SessionMessageIdentityTable,
  SessionMessageTable,
  SessionTable,
} from "@turenlabs/core/session/sql"
import { SessionMessage } from "@turenlabs/core/session/message"
import { AgentV2 } from "@turenlabs/core/agent"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import * as DateTime from "effect/DateTime"
import { and, eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const originalWorkspaces = Flag.FORGE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    EventV2.node,
    SessionTaskV2.node,
    Loop.node,
    Ripgrep.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))
const stuckExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    claimResume: () => Effect.succeed(Effect.void),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.never,
  }),
)
const stuckServedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  createRoutes(undefined, stuckExecution),
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const stuckHttpApiLayer = stuckServedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const stuckIt = testEffect(Layer.mergeAll(appLayer, stuckHttpApiLayer))

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

// Mirrors the durable shape a killed process leaves behind: an assistant turn with no
// `time.completed` whose tool part is still `running`, i.e. the provider was mid tool call.
const insertOrphanedToolMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const id = SessionMessage.ID.create()
    const callID = `call_orphan_${seq}`
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id,
          session_id: sessionID,
          type: "assistant" as const,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: "build",
            model: {
              id: ModelV2.ID.make("model"),
              providerID: ProviderV2.ID.make("provider"),
              variant: ModelV2.VariantID.make("default"),
            },
            content: [
              {
                type: "tool",
                id: callID,
                name: "bash",
                provider: { executed: true },
                state: { status: "running", input: { command: "ls" }, structured: {}, content: [] },
                time: { created: time, ran: time },
              },
            ],
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return { id, callID }
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

const prepareTaskSpawn = Effect.fnUntraced(function* (parent: Session.Info, directory: string, suffix: string) {
  const assistantMessageID = SessionMessage.ID.make(`msg_http_task_actor_${suffix}`)
  const callID = `call_http_task_${suffix}`
  const model = ModelV2.Ref.make({
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test"),
  })
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID: parent.id,
    assistantMessageID,
    timestamp: DateTime.makeUnsafe(Date.now()),
    agent: "build",
    model,
  })
  yield* events.publish(SessionEvent.Tool.Input.Started, {
    sessionID: parent.id,
    assistantMessageID,
    callID,
    timestamp: DateTime.makeUnsafe(Date.now()),
    name: "spawn_agent",
  })
  yield* events.publish(SessionEvent.Tool.Input.Ended, {
    sessionID: parent.id,
    assistantMessageID,
    callID,
    timestamp: DateTime.makeUnsafe(Date.now()),
    text: "{}",
  })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID: parent.id,
    assistantMessageID,
    callID,
    timestamp: DateTime.makeUnsafe(Date.now()),
    tool: "spawn_agent",
    input: {},
    provider: { executed: false },
  })
  return {
    actor: SessionTaskV2.Actor.make({
      sessionID: parent.id,
      assistantMessageID,
      toolCallID: callID,
    }),
    agent: AgentV2.ID.make("explore"),
    model,
    prompt: Prompt.make({ text: `Inspect ${suffix}` }),
    description: `HTTP task ${suffix}`,
    authority: SessionTaskV2.Authority.make({
      parentPermissions: [],
      ancestorPermissionSets: [],
      childPermissions: [],
      hardPermissions: [],
      writeRoots: [AbsolutePath.make(directory)],
      commands: [],
    }),
  } satisfies SessionTaskV2.SpawnInput
})

const createTaskOwnedChild = Effect.fnUntraced(function* (parent: Session.Info, directory: string, suffix: string) {
  const created = yield* (yield* SessionTaskV2.Service).spawn(yield* prepareTaskSpawn(parent, directory, suffix))
  const child = yield* (yield* Session.Service).get(created.task.childSessionID)
  return { child, inputID: created.operation.messageID!, task: created.task, taskID: created.task.id }
})

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.FORGE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.instance(
    "binds one shared PTY to a session and exposes it through canonical PTY routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const session = yield* createSession({ title: "shared terminal" })

        const first = yield* requestJson<{ data: { ptyID: string; shared: boolean } }>(
          `/api/session/${session.id}/terminal`,
          { method: "POST", headers },
        )
        const second = yield* requestJson<{ data: { ptyID: string; shared: boolean } }>(
          `/api/session/${session.id}/terminal`,
          { method: "POST", headers },
        )
        expect(second.data.ptyID).toBe(first.data.ptyID)
        expect(first.data.shared).toBe(true)

        const canonical = yield* request(`/api/pty/${first.data.ptyID}`, { headers })
        expect(canonical.status).toBe(200)

        const closed = yield* request(`/api/session/${session.id}/terminal`, { method: "DELETE", headers })
        expect(closed.status).toBe(204)
        expect((yield* request(`/api/pty/${first.data.ptyID}`, { headers })).status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(404)
        expect(yield* responseJson(abort)).toEqual(missingSessionBody)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects a parent session owned by another project",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const foreignDir = yield* tmpdirScoped({ git: true })
        const foreign = yield* createSession({ title: "foreign" }).pipe(provideInstanceEffect(foreignDir))

        // Session IDs resolve against the global table; a foreign project ID must
        // answer like a missing session rather than resolving across projects.
        const created = yield* request(SessionPaths.create, {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ parentID: foreign.id }),
        })
        expect(created.status).toBe(404)
        expect(yield* responseJson(created)).toEqual({
          name: "NotFoundError",
          data: { message: `Session not found: ${foreign.id}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "searches the durable session replay index through the query DSL",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const events = yield* EventV2.Service
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const created = (yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ location: { directory: test.directory } }),
        })).data
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: SessionV2.ID.make(created.id),
          timestamp: DateTime.makeUnsafe(Date.parse("2026-08-20T12:00:00.000Z")),
          assistantMessageID: SessionMessage.ID.create(),
          callID: "call_http_replay",
          tool: "bash",
          input: { command: "bun typecheck" },
          provider: { executed: false },
        })

        const response = yield* requestJson<{
          data: Array<{ kind: string; session: { id: string }; event?: { id: string; type: string; seq: number } }>
          total: number
          index: { status: "indexing" | "ready"; progress: number }
          parsed: { filters: Array<{ field: string; value: string }> }
        }>(
          `/api/session/replay?${new URLSearchParams({ query: `session:${created.id} type:tool tool:bash typecheck` })}`,
          {
            headers,
          },
        )

        expect(response.total).toBe(1)
        expect(response.data[0]).toMatchObject({
          kind: "event",
          session: { id: created.id },
          event: { type: "session.next.tool.called", seq: 1 },
        })
        expect(response.parsed.filters.map((filter) => filter.field)).toEqual(["session", "type", "tool"])
        expect(response.index).toEqual({ status: "ready", progress: 1 })

        const anchored = yield* requestJson<{
          data: Array<{ id: string }>
          cursor: { previous?: string; next?: string }
        }>(
          `/api/session/${created.id}/replay?${new URLSearchParams({ anchor: response.data[0]!.event!.id, limit: "1" })}`,
          { headers },
        )
        expect(anchored.data[0]).toMatchObject({ id: response.data[0]!.event!.id })

        const replayFirst = yield* requestJson<{
          data: Array<{ id: string; type: string }>
          cursor: { next?: string }
        }>(`/api/session/${created.id}/replay?limit=1`, { headers })
        const replaySecond = yield* requestJson<{
          data: Array<{ id: string; type: string }>
          cursor: { next?: string }
        }>(`/api/session/${created.id}/replay?${new URLSearchParams({ cursor: replayFirst.cursor.next! })}`, {
          headers,
        })
        expect([...replayFirst.data, ...replaySecond.data].map((event) => event.type)).toContain("session.created")
        expect(new Set([...replayFirst.data, ...replaySecond.data].map((event) => event.id)).size).toBe(
          replayFirst.data.length + replaySecond.data.length,
        )

        const invalid = yield* request("/api/session/replay?query=unknown:value", { headers })
        expect(invalid.status).toBe(400)
        expect(yield* responseJson(invalid)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "session_replay_query",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const archivedSession = yield* createSession({ title: "archived v2 cursor" })
        yield* Database.Service.use(({ db }) =>
          db
            .update(SessionTable)
            .set({ time_archived: Date.now() })
            .where(eq(SessionTable.id, archivedSession.id))
            .run()
            .pipe(Effect.orDie),
        )
        const activeOnly = yield* requestJson<{ data: Session.Info[] }>(
          `/api/session?${new URLSearchParams({ archived: "false", roots: "true" })}`,
          { headers },
        )
        expect(activeOnly.data.map((item) => item.id)).not.toContain(archivedSession.id)
        const archivedOnly = yield* requestJson<{ data: Session.Info[] }>(
          `/api/session?${new URLSearchParams({ archived: "true", roots: "true" })}`,
          { headers },
        )
        expect(archivedOnly.data.map((item) => item.id)).toContain(archivedSession.id)

        const recentSession = yield* createSession({ title: "recent v2 session" })
        const inactiveSession = yield* createSession({ title: "inactive v2 session" })
        yield* Database.Service.use(({ db }) =>
          db
            .update(SessionTable)
            .set({ time_updated: Date.now() - 49 * 60 * 60 * 1_000 })
            .where(eq(SessionTable.id, inactiveSession.id))
            .run()
            .pipe(Effect.orDie),
        )
        const recentOnly = yield* requestJson<{ data: Session.Info[] }>(
          `/api/session?${new URLSearchParams({ archived: "false", inactive: "false", roots: "true" })}`,
          { headers },
        )
        expect(recentOnly.data.map((item) => item.id)).toContain(recentSession.id)
        expect(recentOnly.data.map((item) => item.id)).not.toContain(inactiveSession.id)
        const inactiveOnly = yield* requestJson<{ data: Session.Info[]; cursor: { next?: string } }>(
          `/api/session?${new URLSearchParams({
            archived: "false",
            inactive: "true",
            roots: "true",
            limit: "1",
          })}`,
          { headers },
        )
        expect(inactiveOnly.data.map((item) => item.id)).toEqual([inactiveSession.id])
        expect(JSON.parse(Buffer.from(inactiveOnly.cursor.next!, "base64url").toString("utf8"))).toMatchObject({
          archived: "false",
          inactive: "true",
          inactivityThreshold: expect.any(Number),
          anchor: { id: inactiveSession.id, direction: "next" },
        })

        const historySession = yield* createSession({ title: "v2 history tail" })
        for (const agent of ["one", "two"]) {
          const switched = yield* request(`/api/session/${historySession.id}/agent`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ agent }),
          })
          expect(switched.status).toBe(204)
        }
        const history = yield* requestJson<{
          data: Array<{ durable?: { seq: number } }>
          hasMore: boolean
          latest: number
        }>(`/api/session/${historySession.id}/history?limit=1`, { headers })
        expect(history.data).toHaveLength(1)
        expect(history.hasMore).toBe(true)
        expect(history.latest).toBe(2)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const ascendingPage = yield* request(`/api/session/${session.id}/message?limit=1&order=asc`, {
          headers,
        })
        const ascendingBody = yield* json<{
          data: SessionMessage.Message[]
          cursor: { next?: string }
        }>(ascendingPage)
        expect(ascendingBody.data.map((message) => message.id)).toEqual([firstMessage.id])
        expect(ascendingBody.cursor.next).toBeTruthy()
        const ascendingNext = yield* request(`/api/session/${session.id}/message?cursor=${ascendingBody.cursor.next}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(ascendingNext)).data.map((message) => message.id),
        ).toEqual([secondMessage.id])

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const inputStatus = yield* request(`/api/session/${missing}/input/msg_missing`, { headers })
        expect(inputStatus.status).toBe(404)
        expect(yield* responseJson(inputStatus)).toEqual(expected)

        const outbox = yield* request(`/api/session/${missing}/outbox`, { headers })
        expect(outbox.status).toBe(404)
        expect(yield* responseJson(outbox)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "encodes transcript quiescence failures across direct reads and every mutating goal endpoint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "goal adoption failure" })
        const legacy = yield* Session.Service
        const message = yield* legacy.updateMessage({
          id: MessageID.ascending("msgincompatible"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
          time: { created: Date.now() },
        })
        yield* legacy.updatePart({
          id: PartID.ascending("prtincompatible"),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "legacy transcript",
        })

        for (const path of [`/api/session/${session.id}/context`, `/api/session/${session.id}/message/msg_missing`]) {
          const response = yield* request(path, { headers })
          expect(response.status, `GET ${path}`).toBe(400)
          expect(yield* responseJson(response)).toEqual({
            _tag: "InvalidRequestError",
            kind: "session_transcript_adoption",
            message: "Legacy message ID is incompatible with Session V2: msgincompatible",
          })
        }

        for (const input of [
          {
            method: "PUT",
            path: `/api/session/${session.id}/goal`,
            body: {
              id: "goal_adoption",
              messageID: "msg_goal_adoption",
              objective: "Adopt before setting a goal",
            },
          },
          {
            method: "PATCH",
            path: `/api/session/${session.id}/goal`,
            body: {
              goalID: "goal_adoption",
              expectedRevision: 1,
              objective: "Adopt before editing a goal",
            },
          },
          {
            method: "POST",
            path: `/api/session/${session.id}/goal/status`,
            body: { goalID: "goal_adoption", expectedRevision: 1, status: "paused" },
          },
          {
            method: "DELETE",
            path: `/api/session/${session.id}/goal`,
            body: { goalID: "goal_adoption", expectedRevision: 1 },
          },
        ]) {
          const response = yield* request(input.path, {
            method: input.method,
            headers,
            body: JSON.stringify(input.body),
          })
          expect(response.status, `${input.method} ${input.path}`).toBe(400)
          expect(yield* responseJson(response)).toEqual({
            _tag: "InvalidRequestError",
            kind: "session_transcript_adoption",
            message: "Legacy message ID is incompatible with Session V2: msgincompatible",
          })
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" }, resume: false }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: PromptBody[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toHaveLength(0)
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: SessionMessage.ID.make("msg_http_prompt"),
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const inputStatus = yield* requestJson<{ data?: SessionInput.OutboxItem }>(
          `/api/session/${session.id}/input/msg_http_prompt`,
          { headers },
        )
        expect(inputStatus.data).toEqual({
          id: SessionMessage.ID.make("msg_http_prompt"),
          status: "admitted",
          sessionID: session.id,
          source: "user",
          prompt: { text: "hello" },
          delivery: "steer",
          admittedSeq: admitted!.admitted_seq,
          timeCreated: expect.any(Number),
        })
        const outbox = yield* requestJson<{
          data: Array<{ id: string; status: string }>
          next?: number
        }>(`/api/session/${session.id}/outbox?limit=1`, { headers })
        expect(outbox.data).toEqual([expect.objectContaining({ id: "msg_http_prompt", status: "admitted" })])
        const admissionEvents = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(EventTable)
            .where(
              and(
                eq(EventTable.aggregate_id, session.id),
                eq(EventTable.type, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)),
              ),
            )
            .all()
            .pipe(Effect.orDie),
        )
        expect(admissionEvents).toHaveLength(1)
        expect(admissionEvents[0]?.data).toMatchObject({ messageID: "msg_http_prompt" })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" } }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })

        const wakeID = SessionMessage.ID.make("msg_http_wake")
        const wake = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: wakeID, prompt: { text: "hello again" } }),
        })
        expect(wake.status).toBe(200)
        const message = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, { headers }).pipe(
            Effect.map(({ data }) => data.find((message) => message.id === wakeID)),
          ),
          "V2 prompt was not promoted after wake",
          "10 seconds",
        )
        expect(message).toMatchObject({ id: wakeID, type: "user" })

        const routed = yield* createSession({ title: "v2 atomic route" })
        const routedResponse = yield* request(`/api/session/${routed.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            id: "msg_http_routed_prompt",
            prompt: { text: "route atomically" },
            agent: "review",
            model: { providerID: "test", id: "route-model", variant: "high" },
            resume: false,
          }),
        })
        expect(routedResponse.status).toBe(200)
        expect(yield* json<{ data: PromptBody }>(routedResponse)).toMatchObject({
          data: {
            id: "msg_http_routed_prompt",
            agent: "review",
            model: { providerID: "test", id: "route-model", variant: "high" },
          },
        })
        expect(
          yield* Database.Service.use(({ db }) =>
            db
              .select({
                agent: SessionInputTable.agent,
                model: SessionInputTable.model,
              })
              .from(SessionInputTable)
              .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_routed_prompt")))
              .get()
              .pipe(Effect.orDie),
          ),
        ).toEqual({
          agent: AgentV2.ID.make("review"),
          model: ModelV2.Ref.make({
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("route-model"),
            variant: ModelV2.VariantID.make("high"),
          }),
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns a public conflict before a revert can delete the durable goal input",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "v2 revert goal guard" })
        const sessionID = SessionV2.ID.make(session.id)
        const boundaryID = SessionMessage.ID.make("msg_http_goal_guard_boundary")
        const goalID = "goal_http_revert_guard"
        const goalMessageID = "msg_http_goal_guard_input"

        const boundary = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: boundaryID,
            prompt: { text: "Keep this boundary" },
            resume: false,
          }),
        })
        expect(boundary.status).toBe(200)
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* SessionInput.promoteSteers(
            Database.primary(db),
            yield* EventV2.Service,
            sessionID,
            Number.MAX_SAFE_INTEGER,
          )
        })

        const setGoal = () =>
          request(`/api/session/${session.id}/goal`, {
            method: "PUT",
            headers,
            body: JSON.stringify({
              id: goalID,
              messageID: goalMessageID,
              objective: "Do not lose this durable goal",
            }),
          })
        expect((yield* setGoal()).status).toBe(200)
        const staged = yield* request(`/api/session/${session.id}/revert/stage`, {
          method: "POST",
          headers,
          body: JSON.stringify({ messageID: boundaryID, files: false }),
        })
        expect(staged.status).toBe(200)

        const commit = yield* request(`/api/session/${session.id}/revert/commit`, {
          method: "POST",
          headers,
        })
        expect(commit.status).toBe(409)
        expect(yield* responseJson(commit)).toEqual({
          _tag: "ConflictError",
          message: `Cannot commit a revert that would remove the durable input for active goal ${goalID}`,
          resource: boundaryID,
        })
        const prompt = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: "msg_http_goal_guard_blocked",
            prompt: { text: "This admission must not partially commit the revert" },
            resume: false,
          }),
        })
        expect(prompt.status).toBe(409)
        expect(yield* responseJson(prompt)).toMatchObject({
          _tag: "ConflictError",
          resource: boundaryID,
        })
        expect((yield* setGoal()).status).toBe(200)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "runs one bounded v2 shell command and reconciles exact HTTP retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 shell recording" })
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const payload = {
          id: "msg_http_shell",
          command: "sleep 0.5; printf forge; exit 7",
          timeout: 5_000,
        }
        const run = () =>
          request(`/api/session/${session.id}/shell`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          })

        const first = yield* run()
        const retried = yield* run()
        const firstBody = yield* json<{ data: SessionMessage.Shell }>(first)
        const retriedBody = yield* json<{ data: SessionMessage.Shell }>(retried)

        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(firstBody.data).toMatchObject({
          id: payload.id,
          type: "shell",
          command: payload.command,
          timeout: payload.timeout,
          output: "",
          status: "running",
        })
        expect(retriedBody.data).toMatchObject({
          id: payload.id,
          callID: firstBody.data.callID,
          status: "running",
        })

        const completed = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message }>(`/api/session/${session.id}/message/${payload.id}`, {
            headers,
          }).pipe(
            Effect.map(({ data }) => (data.type === "shell" && data.time.completed !== undefined ? data : undefined)),
          ),
          "V2 shell command did not settle",
          "10 seconds",
        )
        expect(completed).toMatchObject({
          id: payload.id,
          type: "shell",
          command: payload.command,
          timeout: payload.timeout,
          output: "forge",
          status: "completed",
          exitCode: 7,
          truncated: false,
        })
        expect(
          yield* Database.Service.use(({ db }) =>
            db
              .select()
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, SessionMessage.ID.make(payload.id)))
              .all()
              .pipe(Effect.orDie),
          ),
        ).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  it.instance(
    "returns a typed 409 for concurrent cross-session shell message-ID reuse",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const firstSession = yield* createSession({ title: "v2 shell race first" })
        const secondSession = yield* createSession({ title: "v2 shell race second" })
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const messageID = "msg_http_shell_cross_session_race"
        const run = (sessionID: string, output: string) =>
          request(`/api/session/${sessionID}/shell`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: messageID, command: `printf ${output}`, timeout: 5_000 }),
          })

        const responses = yield* Effect.all([run(firstSession.id, "first"), run(secondSession.id, "second")], {
          concurrency: "unbounded",
        })
        const accepted = responses.find((response) => response.status === 200)
        const conflict = responses.find((response) => response.status === 409)

        expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409])
        expect(accepted).toBeDefined()
        expect(conflict).toBeDefined()
        expect(yield* responseJson(conflict!)).toEqual({
          _tag: "ConflictError",
          message: `Shell message ID conflicts with an existing durable record: ${messageID}`,
          resource: messageID,
        })
        expect(
          yield* Database.Service.use(({ db }) =>
            db
              .select()
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, SessionMessage.ID.make(messageID)))
              .all()
              .pipe(Effect.orDie),
          ),
        ).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns public shell 409s for pending prompt, command, and goal identities",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 shell identity conflicts" })
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const shell = (id: string) =>
          request(`/api/session/${session.id}/shell`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id, command: "printf must-not-run", timeout: 5_000 }),
          })
        const assertConflict = Effect.fnUntraced(function* (id: string) {
          const response = yield* shell(id)
          expect(response.status).toBe(409)
          expect(yield* responseJson(response)).toEqual({
            _tag: "ConflictError",
            message: `Shell message ID conflicts with an existing durable record: ${id}`,
            resource: id,
          })
        })
        const assertInputOwner = Effect.fnUntraced(function* (id: string, kind: "prompt" | "command" | "goal") {
          const rows = yield* Database.Service.use(({ db }) => {
            const primary = Database.primary(db)
            return Effect.all({
              identities: primary
                .select()
                .from(SessionMessageIdentityTable)
                .where(eq(SessionMessageIdentityTable.id, SessionMessage.ID.make(id)))
                .all()
                .pipe(Effect.orDie),
              inputs: primary
                .select()
                .from(SessionInputTable)
                .where(eq(SessionInputTable.id, SessionMessage.ID.make(id)))
                .all()
                .pipe(Effect.orDie),
              shells: primary
                .select()
                .from(SessionMessageTable)
                .where(
                  and(eq(SessionMessageTable.id, SessionMessage.ID.make(id)), eq(SessionMessageTable.type, "shell")),
                )
                .all()
                .pipe(Effect.orDie),
            })
          })
          expect(rows.identities).toHaveLength(1)
          expect(rows.identities[0]).toMatchObject({
            session_id: session.id,
            owner: "input",
            kind,
            state: "active",
          })
          expect(rows.inputs).toHaveLength(1)
          expect(rows.shells).toHaveLength(0)
        })

        const promptID = "msg_http_shell_prompt_identity"
        expect(
          (yield* request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id: promptID, prompt: { text: "pending" }, resume: false }),
          })).status,
        ).toBe(200)
        yield* assertConflict(promptID)
        yield* assertInputOwner(promptID, "prompt")

        const commandID = "msg_http_shell_command_identity"
        expect(
          (yield* request(`/api/session/${session.id}/command`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: commandID,
              command: "review",
              arguments: "identity",
              resume: false,
            }),
          })).status,
        ).toBe(200)
        yield* assertConflict(commandID)
        yield* assertInputOwner(commandID, "command")

        const goalID = "msg_http_shell_goal_identity"
        expect(
          (yield* request(`/api/session/${session.id}/goal`, {
            method: "PUT",
            headers,
            body: JSON.stringify({
              id: "goal_http_shell_identity",
              messageID: goalID,
              objective: "Keep the goal identity globally unique",
            }),
          })).status,
        ).toBe(200)
        yield* assertConflict(goalID)
        yield* assertInputOwner(goalID, "goal")
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        command: {
          review: { template: "Review $ARGUMENTS", subtask: false },
        },
      },
    },
  )

  it.instance(
    "times out one v2 shell, clears active ownership, and runs the next command",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 shell timeout cleanup" })
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const timedOutID = "msg_http_shell_timeout"
        const started = yield* request(`/api/session/${session.id}/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: timedOutID, command: "sleep 5", timeout: 50 }),
        })
        expect(started.status).toBe(200)

        const timedOut = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message }>(`/api/session/${session.id}/message/${timedOutID}`, {
            headers,
          }).pipe(
            Effect.map(({ data }) => (data.type === "shell" && data.time.completed !== undefined ? data : undefined)),
          ),
          "V2 shell command did not time out",
          "10 seconds",
        )
        expect(timedOut).toMatchObject({
          id: timedOutID,
          type: "shell",
          timeout: 50,
          status: "timed_out",
          error: "Shell command exceeded the 50 ms timeout.",
        })
        yield* pollWithTimeout(
          requestJson<{ data: Record<string, unknown> }>("/api/session/active", { headers }).pipe(
            Effect.map(({ data }) => (data[session.id] ? undefined : data)),
          ),
          "Timed-out V2 shell left the Session active",
          "5 seconds",
        )

        const recoveredID = "msg_http_shell_after_timeout"
        const recovered = yield* request(`/api/session/${session.id}/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: recoveredID, command: "printf recovered", timeout: 5_000 }),
        })
        expect(recovered.status).toBe(200)
        const completed = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message }>(`/api/session/${session.id}/message/${recoveredID}`, {
            headers,
          }).pipe(
            Effect.map(({ data }) => (data.type === "shell" && data.time.completed !== undefined ? data : undefined)),
          ),
          "V2 shell did not run after timeout cleanup",
          "10 seconds",
        )
        expect(completed).toMatchObject({
          id: recoveredID,
          type: "shell",
          status: "completed",
          output: "recovered",
          exitCode: 0,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  it.instance(
    "resolves the owning location and interrupts a live v2 shell process tree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const directory = path.join(test.directory, "shell-owner")
        const startedMarker = path.join(directory, "started.txt")
        const leakedMarker = path.join(directory, "leaked.txt")
        yield* Effect.promise(() => mkdir(directory, { recursive: true }))
        const session = (yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ location: { directory } }),
        })).data
        const messageID = "msg_http_shell_interrupt"
        const started = yield* request(`/api/session/${session.id}/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: messageID,
            command: "printf started > started.txt; (sleep 0.5; printf leaked > leaked.txt) & wait",
            timeout: 60_000,
          }),
        })
        expect(started.status).toBe(200)
        expect((yield* json<{ data: SessionMessage.Shell }>(started)).data).toMatchObject({
          id: messageID,
          status: "running",
        })
        yield* pollWithTimeout(
          Effect.promise(() => Bun.file(startedMarker).exists()).pipe(
            Effect.map((exists) => (exists ? true : undefined)),
          ),
          "V2 shell did not execute in its owning location",
          "5 seconds",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, "started.txt")).exists())).toBe(false)
        yield* Effect.sleep("30 millis")
        const active = yield* requestJson<{ data: Record<string, unknown> }>("/api/session/active", { headers })
        expect(active.data[session.id]).toBeDefined()

        const interrupted = yield* request(`/api/session/${session.id}/interrupt`, {
          method: "POST",
          headers,
        })
        expect(interrupted.status).toBe(204)
        const settled = yield* requestJson<{ data: SessionMessage.Message }>(
          `/api/session/${session.id}/message/${messageID}`,
          { headers },
        )
        expect(settled.data).toMatchObject({
          id: messageID,
          type: "shell",
          status: "cancelled",
          error: "User cancelled the shell command.",
        })
        yield* Effect.sleep("650 millis")
        expect(yield* Effect.promise(() => Bun.file(leakedMarker).exists())).toBe(false)
        const idle = yield* pollWithTimeout(
          requestJson<{ data: Record<string, unknown> }>("/api/session/active", { headers }).pipe(
            Effect.map(({ data }) => (data[session.id] ? undefined : data)),
          ),
          "Interrupted V2 shell left the Session active",
          "5 seconds",
        )
        expect(idle[session.id]).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  it.instance(
    "resolves one configured v2 command and preserves exact retry identity",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 command recording" })
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const payload = {
          id: "msg_http_command",
          command: "review",
          arguments: "storage",
          resume: false,
        }
        const run = (body = payload) =>
          request(`/api/session/${session.id}/command`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })

        const first = yield* run()
        const retried = yield* run()
        type CommandBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: CommandBody }>(first)
        const retriedBody = yield* json<{ data: CommandBody }>(retried)

        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: {
            id: payload.id,
            prompt: { text: "Review storage" },
            delivery: "steer",
          },
        })
        expect(
          yield* Database.Service.use(({ db }) =>
            db
              .select()
              .from(SessionInputTable)
              .where(eq(SessionInputTable.id, SessionMessage.ID.make(payload.id)))
              .all()
              .pipe(Effect.orDie),
          ),
        ).toHaveLength(1)

        const conflict = yield* run({ ...payload, arguments: "network" })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toMatchObject({
          _tag: "ConflictError",
          resource: payload.id,
        })
        const unsupported = yield* run({
          ...payload,
          id: "msg_http_command_inline",
          command: "inline",
        })
        expect(unsupported.status).toBe(400)
        expect(yield* responseJson(unsupported)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "session_command",
          message: expect.stringContaining("inline shell interpolation is disabled"),
        })
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        command: {
          review: { template: "Review $ARGUMENTS", subtask: false },
          inline: { template: "Inspect !`pwd`", subtask: false },
        },
      },
    },
  )

  it.instance(
    "settles one stale v2 shell tail on resume without replay",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 shell restart recovery" })
        const headers = { "x-forge-directory": test.directory }
        const shellMessageID = SessionMessage.ID.make("msg_http_shell_recovery")
        const callID = "call_http_shell_recovery"
        yield* (yield* EventV2.Service).publish(SessionEvent.Shell.Started, {
          sessionID: session.id,
          messageID: shellMessageID,
          callID,
          command: "printf must-not-replay",
          timeout: 5_000,
          timestamp: yield* DateTime.now,
        })

        const resume = () =>
          request(`/api/session/${session.id}/resume`, {
            method: "POST",
            headers,
          })
        const first = yield* resume()
        const reason = "Shell execution was interrupted before this TurenOS process observed completion."
        expect(first.status).toBe(200)
        expect(yield* json<{ data: unknown }>(first)).toEqual({
          data: {
            status: "interrupted",
            shellMessageID,
            reason,
            next: "idle",
          },
        })
        expect(
          (yield* requestJson<{ data: SessionMessage.Message }>(
            `/api/session/${session.id}/message/${shellMessageID}`,
            { headers },
          )).data,
        ).toMatchObject({
          id: shellMessageID,
          type: "shell",
          command: "printf must-not-replay",
          status: "failed",
          output: reason,
          error: reason,
        })
        const ended = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(EventTable)
            .where(
              and(
                eq(EventTable.aggregate_id, session.id),
                eq(EventTable.type, EventV2.versionedType(SessionEvent.Shell.Ended.type, 1)),
              ),
            )
            .all()
            .pipe(Effect.orDie),
        )
        expect(ended.filter((event) => event.data.callID === callID)).toHaveLength(1)

        const second = yield* resume()
        expect(second.status).toBe(200)
        expect(yield* json<{ data: unknown }>(second)).toEqual({ data: { status: "idle" } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "settles a stale shell and reports that its already-admitted prompt was scheduled",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 shell recovery with prompt" })
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const shellMessageID = SessionMessage.ID.make("msg_http_shell_recovery_pending")
        const promptMessageID = SessionMessage.ID.make("msg_http_after_shell_recovery")
        yield* (yield* EventV2.Service).publish(SessionEvent.Shell.Started, {
          sessionID: session.id,
          messageID: shellMessageID,
          callID: "call_http_shell_recovery_pending",
          command: "printf must-not-replay",
          timeout: 5_000,
          timestamp: yield* DateTime.now,
        })
        const admitted = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: promptMessageID,
            prompt: { text: "Continue from the recovered shell boundary" },
            resume: false,
          }),
        })
        expect(admitted.status).toBe(200)

        const resumed = yield* request(`/api/session/${session.id}/resume`, { method: "POST", headers })
        expect(resumed.status).toBe(200)
        expect(yield* json<{ data: unknown }>(resumed)).toEqual({
          data: {
            status: "interrupted",
            shellMessageID,
            reason: "Shell execution was interrupted before this TurenOS process observed completion.",
            next: "scheduled",
          },
        })
        expect(
          yield* Database.Service.use(({ db }) =>
            db
              .select()
              .from(SessionInputTable)
              .where(and(eq(SessionInputTable.id, promptMessageID), eq(SessionInputTable.session_id, session.id)))
              .all()
              .pipe(Effect.orDie),
          ),
        ).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns an interrupted recovery outcome once and idle on the next resume",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 recovery contract" })
        const assistant = yield* insertLegacyAssistantMessage(session.id)
        const headers = { "x-forge-directory": test.directory }
        const resume = () =>
          request(`/api/session/${session.id}/resume`, {
            method: "POST",
            headers,
          })

        const first = yield* resume()
        expect(first.status).toBe(200)
        expect(yield* json<{ data: unknown }>(first)).toEqual({
          data: {
            status: "interrupted",
            assistantMessageID: assistant.id,
            reason: "Provider turn was interrupted by process restart and was not replayed.",
            next: "idle",
          },
        })

        const second = yield* resume()
        expect(second.status).toBe(200)
        expect(yield* json<{ data: unknown }>(second)).toEqual({ data: { status: "idle" } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  // Regression: a sidecar restart under an already-open session page. The client never
  // remounts, so it never re-probes /resume -- it only reattaches its durable event stream.
  // Before this, the orphaned tool call stayed `running` forever and the UI rendered
  // "Called `Bash`" with no result until the page was reopened or the process restarted again.
  it.instance(
    "settles an orphaned tool call when a client reattaches to the session event stream",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 recovery on attach" })
        const orphan = yield* insertOrphanedToolMessage(session.id)
        const headers = { "x-forge-directory": test.directory }
        const promptMessageID = MessageID.ascending()
        yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            id: promptMessageID,
            prompt: { text: "keep going after the restart" },
            delivery: "steer",
            resume: false,
          }),
        })

        // Attaching to the stream is the only signal a restarted process gets that a client
        // is watching. Hold it open the way a live client does, then drop it.
        const attached = yield* Effect.scoped(
          request(`/api/session/${session.id}/event`, { headers }).pipe(
            Effect.flatMap((response) =>
              response.stream.pipe(
                Stream.take(1),
                Stream.runDrain,
                Effect.as({ status: response.status, cacheControl: response.headers["cache-control"] }),
              ),
            ),
          ),
        )
        expect(attached).toEqual({ status: 200, cacheControl: "no-store, no-transform" })

        // (a) the in-flight tool call reached a terminal state
        const settled = yield* pollWithTimeout(
          Database.Service.use(({ db }) =>
            db
              .select({ data: SessionMessageTable.data })
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, orphan.id))
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((row) => (row?.data && "finish" in row.data ? row : undefined)),
              ),
          ),
          "timed out waiting for the orphaned tool call to reach a terminal state",
          "3 seconds",
        )
        expect(settled).toMatchObject({
          data: {
            finish: "error",
            time: { completed: expect.any(Number) },
            content: [{ type: "tool", id: orphan.callID, state: { status: "error" } }],
          },
        })

        // (b) recovery re-admitted nothing: exactly one durable row for the pending prompt
        expect(
          yield* Database.Service.use(({ db }) =>
            db
              .select()
              .from(SessionInputTable)
              .where(eq(SessionInputTable.session_id, session.id))
              .all()
              .pipe(Effect.orDie),
          ),
        ).toHaveLength(1)

        // (c) recovery converged: a follow-up probe finds nothing left to interrupt and the
        // already-admitted steer is scheduled (or the woken execution already owns it), rather
        // than reporting the same interruption a second time.
        const resumed = yield* requestJson<{ data: { status: string } }>(`/api/session/${session.id}/resume`, {
          method: "POST",
          headers,
        })
        expect(["scheduled", "running"]).toContain(resumed.data.status)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public unavailable errors for unfinished session mutations",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        // `compact` used to answer here with the same "not available yet" stub as `wait`. It is
        // now implemented, so its coverage lives in the compaction tests below; `wait` keeps this
        // block.
        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(503)
        expect(yield* responseJson(wait)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session wait is not available yet",
          service: "session.wait",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  stuckIt.instance(
    "cancels idle v2 task rows and exposes active descendant cancellation timeouts",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const tasks = yield* SessionTaskV2.Service
        const v2Parent = yield* createSession({ title: "v2 stuck child" })
        const v2Owned = yield* createTaskOwnedChild(v2Parent, test.directory, "v2_interrupt_timeout")

        const v2 = yield* request(`/api/session/${v2Parent.id}/interrupt`, { method: "POST", headers })
        expect(v2.status).toBe(204)
        expect(yield* tasks.get(v2Owned.taskID)).toMatchObject({ status: "cancelled", revision: 2 })

        const cancelParent = yield* createSession({ title: "task cancel stuck child" })
        const cancelOwned = yield* createTaskOwnedChild(cancelParent, test.directory, "task_cancel_timeout")
        const cancel = yield* request(`/api/session/${cancelParent.id}/task/${cancelOwned.taskID}/cancel`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: cancelOwned.task.revision }),
        })
        expect(cancel.status).toBe(503)
        expect(yield* responseJson(cancel)).toEqual({
          _tag: "ServiceUnavailableError",
          message: `Subagent execution did not stop within 5 seconds: ${cancelOwned.child.id}`,
          service: "session.task.cancel",
        })
        expect(yield* tasks.get(cancelOwned.taskID)).toMatchObject({ status: "running", revision: 1 })

        const legacyParent = yield* createSession({ title: "legacy stuck child" })
        const legacyOwned = yield* createTaskOwnedChild(legacyParent, test.directory, "legacy_abort_timeout")
        const legacy = yield* request(pathFor(SessionPaths.abort, { sessionID: legacyParent.id }), {
          method: "POST",
          headers,
        })
        expect(legacy.status).toBe(503)
        expect(yield* responseJson(legacy)).toMatchObject({
          _tag: "ServiceUnavailableError",
          message: `Session execution did not stop within 5 seconds: ${legacyOwned.child.id}`,
          service: "session.abort",
        })
        expect(yield* tasks.get(legacyOwned.taskID)).toMatchObject({ status: "running", revision: 1 })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-forge-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-forge-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-forge-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-forge-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects legacy mutations of a task-owned child before its first drain",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const parent = yield* createSession({ title: "task owner" })
        const owned = yield* createTaskOwnedChild(parent, test.directory, "legacy_mutation_guard")
        const database = yield* Database.Service
        const before = yield* database.db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, owned.child.id))
          .get()
          .pipe(Effect.orDie)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: owned.child.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "legacy prompt must not be admitted" }],
          }),
        })
        const update = yield* request(pathFor(SessionPaths.update, { sessionID: owned.child.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "legacy update must not persist" }),
        })
        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: owned.child.id }), {
          method: "DELETE",
          headers,
        })

        for (const [operation, response] of [
          ["POST prompt", prompt],
          ["PATCH session", update],
          ["DELETE session", remove],
        ] as const) {
          expect(response.status, operation).toBe(400)
          expect(yield* responseJson(response)).toMatchObject({
            _tag: "InvalidRequestError",
            kind: "session_task_owned",
            message: expect.stringContaining(`${owned.child.id} is owned by ${owned.taskID}`),
          })
        }

        expect(
          yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, owned.child.id))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(before)
        expect(
          yield* database.db
            .select()
            .from(MessageTable)
            .where(eq(MessageTable.session_id, owned.child.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, owned.inputID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({
          session_id: owned.child.id,
          promoted_seq: null,
          time_cancelled: null,
        })
        expect(
          yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.id, owned.taskID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({
          child_session_id: owned.child.id,
          status: "running",
          revision: 1,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "requires coordinated root removal and cleans task children only after durable cancellation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const parent = yield* createSession({ title: "task removal owner" })
        const owned = yield* createTaskOwnedChild(parent, test.directory, "coordinated_removal")
        const unrelatedParent = yield* createSession({ title: "unrelated task removal owner" })
        const unrelated = yield* createTaskOwnedChild(unrelatedParent, test.directory, "unrelated_coordinated_removal")
        const session = yield* Session.Service
        const database = yield* Database.Service

        const direct = yield* session.remove(parent.id).pipe(Effect.exit)
        expect(Exit.isFailure(direct)).toBe(true)
        if (Exit.isFailure(direct))
          expect(Cause.squash(direct.cause)).toMatchObject({
            _tag: "SessionTaskCleanupRequired",
            sessionID: parent.id,
          })
        expect(
          yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, owned.child.id))
            .get()
            .pipe(Effect.orDie),
        ).toBeDefined()
        expect(
          yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.id, owned.taskID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ status: "running", revision: 1 })
        expect(
          yield* database.db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, owned.taskID))
            .all()
            .pipe(Effect.orDie),
        ).not.toEqual([])
        const syncHistory = yield* requestJson<Array<{ aggregate_id: string; type: string }>>("/sync/history", {
          method: "POST",
          headers: { "x-forge-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(
          syncHistory.some(
            (event) =>
              event.aggregate_id === parent.id ||
              event.aggregate_id === owned.child.id ||
              event.aggregate_id === owned.taskID ||
              SessionTaskV2.isDurableEventType(event.type),
          ),
        ).toBe(false)
        const replayTask = yield* request("/sync/replay", {
          method: "POST",
          headers: { "x-forge-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({
            directory: test.directory,
            events: [
              {
                id: EventV2.ID.create(),
                aggregateID: "safe_replay_decoy",
                seq: 0,
                type: "decoy.1",
                data: {},
              },
              {
                id: EventV2.ID.create(),
                aggregateID: owned.child.id,
                seq: 0,
                type: "decoy.1",
                data: {},
              },
            ],
          }),
        })
        expect(replayTask.status).toBe(400)

        const interrupted: SessionIDType[] = []
        yield* session.removeCoordinated({
          sessionID: parent.id,
          interrupt: (childSessionID) =>
            Effect.gen(function* () {
              expect(
                yield* database.db
                  .select()
                  .from(SessionTaskTable)
                  .where(eq(SessionTaskTable.id, owned.taskID))
                  .get()
                  .pipe(Effect.orDie),
              ).toMatchObject({ status: "running", revision: 1 })
              expect(
                yield* database.db
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, childSessionID))
                  .get()
                  .pipe(Effect.orDie),
              ).toBeDefined()
              interrupted.push(childSessionID)
            }),
          beforeRemove: Effect.void,
        })

        expect(interrupted).toEqual([owned.child.id])
        expect(
          yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, parent.id)).all().pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, owned.child.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.id, owned.taskID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, owned.taskID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, owned.taskID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionTaskActorClaimTable)
            .where(eq(SessionTaskActorClaimTable.task_id, owned.taskID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionTaskActorClaimTable)
            .where(eq(SessionTaskActorClaimTable.task_id, unrelated.taskID))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(1)
        expect(
          yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, unrelated.child.id))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects a concurrent spawn while coordinated root deletion waits for child settlement",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const parent = yield* createSession({ title: "task removal race owner" })
        const owned = yield* createTaskOwnedChild(parent, test.directory, "coordinated_removal_race")
        const pendingSpawn = yield* prepareTaskSpawn(parent, test.directory, "spawn_during_coordinated_removal")
        const session = yield* Session.Service
        const tasks = yield* SessionTaskV2.Service
        const database = yield* Database.Service
        const interruptStarted = yield* Deferred.make<void>()
        const releaseInterrupt = yield* Deferred.make<void>()

        const removalFiber = yield* session
          .removeCoordinated({
            sessionID: parent.id,
            interrupt: (childSessionID) =>
              Effect.gen(function* () {
                expect(childSessionID).toBe(owned.child.id)
                yield* Deferred.succeed(interruptStarted, undefined)
                yield* Deferred.await(releaseInterrupt)
              }),
            beforeRemove: Effect.void,
          })
          .pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(interruptStarted)
        expect(yield* tasks.get(owned.taskID)).toMatchObject({ status: "running", revision: 1 })

        const spawnFiber = yield* tasks.spawn(pendingSpawn).pipe(Effect.exit, Effect.forkChild)
        const spawnExit = yield* Fiber.join(spawnFiber)
        expect(Exit.isFailure(spawnExit)).toBe(true)
        if (Exit.isFailure(spawnExit))
          expect(Cause.squash(spawnExit.cause)).toMatchObject({
            _tag: "SessionTask.ConflictError",
            resource: parent.id,
            message: "Session task graph is being removed",
          })
        expect(yield* tasks.listAggregateIDs(parent.id)).toEqual([owned.taskID])

        yield* Deferred.succeed(releaseInterrupt, undefined)
        expect(Exit.isSuccess(yield* Fiber.join(removalFiber))).toBe(true)

        expect(
          yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, parent.id)).all().pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.parent_id, parent.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionTaskTable)
            .where(eq(SessionTaskTable.root_session_id, parent.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* database.db
            .select()
            .from(SessionTaskActorClaimTable)
            .where(eq(SessionTaskActorClaimTable.task_id, owned.taskID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "aborts coordinated deletion when a child execution does not settle before timeout",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const parent = yield* createSession({ title: "task removal timeout owner" })
        const owned = yield* createTaskOwnedChild(parent, test.directory, "coordinated_removal_timeout")
        const session = yield* Session.Service
        const tasks = yield* SessionTaskV2.Service
        const database = yield* Database.Service
        const clock = yield* TestClock.make({ warningDelay: "30 seconds" })
        const interruptStarted = yield* Deferred.make<void>()
        const removalFiber = yield* session
          .removeCoordinated({
            sessionID: parent.id,
            interrupt: () => Deferred.succeed(interruptStarted, undefined).pipe(Effect.andThen(Effect.never)),
            beforeRemove: Effect.die(new Error("deletion continued after a timed-out child interrupt")),
          })
          .pipe(Effect.provideService(Clock.Clock, clock), Effect.exit, Effect.forkChild)

        yield* Deferred.await(interruptStarted)
        yield* clock.adjust("5 seconds")
        const removalExit = yield* Fiber.join(removalFiber)
        expect(Exit.isFailure(removalExit)).toBe(true)
        if (Exit.isFailure(removalExit))
          expect(Cause.squash(removalExit.cause)).toMatchObject({
            _tag: "SessionTaskInterruptionTimeout",
            sessionID: owned.child.id,
          })
        expect(yield* tasks.get(owned.taskID)).toMatchObject({ status: "running", revision: 1 })
        expect(
          yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, parent.id)).all().pipe(Effect.orDie),
        ).toHaveLength(1)
        expect(
          yield* database.db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, owned.child.id))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(1)
        expect(
          yield* database.db
            .select()
            .from(SessionTaskActorClaimTable)
            .where(eq(SessionTaskActorClaimTable.task_id, owned.taskID))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "cancels the bound loop run when its session is deleted",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const loops = yield* Loop.Service
        const database = yield* Database.Service
        const loop = yield* loops.create({
          name: "delete bound session",
          prompt: "do work",
          intervalSeconds: 3600,
          location: { directory: test.directory },
        })
        const run = yield* loops.runNow({ id: loop.id, owner: "test" })
        const bound = yield* createSession({ title: "loop run session" })
        yield* loops.recordRunSession({ id: run.id, owner: "test", sessionID: bound.id })
        yield* loops.startRun({ id: run.id, owner: "test", sessionID: bound.id })

        const removed = yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: bound.id }), {
          method: "DELETE",
          headers,
        })
        expect(removed).toBe(true)
        expect(yield* loops.getRun({ id: run.id })).toMatchObject({ status: "cancelled" })
        expect(
          yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, bound.id)).all().pipe(Effect.orDie),
        ).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "interrupts a running root drain while deleting the session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "delete running session" })
        const started = yield* request(`/api/session/${session.id}/shell`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "msg_http_shell_delete", command: "sleep 60", timeout: 120_000 }),
        })
        expect(started.status).toBe(200)
        yield* pollWithTimeout(
          requestJson<{ data: Record<string, unknown> }>("/api/session/active", { headers }).pipe(
            Effect.map(({ data }) => (data[session.id] ? true : undefined)),
          ),
          "V2 shell session never became active",
          "5 seconds",
        )

        const removed = yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: session.id }), {
          method: "DELETE",
          headers,
        })
        expect(removed).toBe(true)

        const active = yield* requestJson<{ data: Record<string, unknown> }>("/api/session/active", { headers })
        expect(active.data[session.id]).toBeUndefined()
        const missing = yield* request(`/api/session/${session.id}`, { headers })
        expect(missing.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "paginates safe task summaries and bounds persisted task detail fields",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const parent = yield* createSession({ title: "task api owner" })
        const tasks = yield* SessionTaskV2.Service
        const owned = yield* Effect.forEach(
          Array.from({ length: 5 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const created = yield* createTaskOwnedChild(parent, test.directory, `task_page_${index}`)
              if (index < 4) {
                yield* tasks.cancelWithInterrupt({
                  sessionID: parent.id,
                  taskID: created.taskID,
                  interrupt: () => Effect.void,
                })
              }
              return created
            }),
          { concurrency: 1 },
        )
        const detailTask = owned[4]!
        const longRules = Array.from({ length: 2 }, () => ({
          action: "a".repeat(SessionTaskResponseLimits.permissionAction + 1),
          resource: "r".repeat(SessionTaskResponseLimits.permissionResource + 1),
          effect: "allow" as const,
        }))
        const shortRules = Array.from({ length: SessionTaskResponseLimits.permissionRules + 1 }, () => ({
          action: "a".repeat(SessionTaskResponseLimits.permissionAction + 1),
          resource: "resource",
          effect: "allow" as const,
        }))
        const longRoot = AbsolutePath.make(`/${"w".repeat(SessionTaskResponseLimits.writeRoot - 1)}`)
        const database = yield* Database.Service
        yield* database.db
          .update(SessionTaskTable)
          .set({
            agent: AgentV2.ID.make("a".repeat(SessionTaskResponseLimits.agentID + 1)),
            model: ModelV2.Ref.make({
              id: ModelV2.ID.make("m".repeat(SessionTaskResponseLimits.modelID + 1)),
              providerID: ProviderV2.ID.make("p".repeat(SessionTaskResponseLimits.providerID + 1)),
              variant: ModelV2.VariantID.make("v".repeat(SessionTaskResponseLimits.variantID + 1)),
            }),
            actor_tool_call_id: "c".repeat(SessionTaskResponseLimits.actorToolCallID),
            prompt: Prompt.make({ text: "p".repeat(SessionTaskResponseLimits.detailPrompt + 1) }),
            description: "d".repeat(SessionTaskResponseLimits.detailDescription),
            parent_permissions: longRules,
            ancestor_permission_sets: Array.from(
              { length: SessionTaskResponseLimits.ancestorPermissionSets },
              () => [],
            ),
            child_permissions: shortRules,
            hard_permissions: shortRules,
            write_roots: Array.from({ length: SessionTaskResponseLimits.writeRoots }, () => longRoot),
            commands: Array.from({ length: SessionTaskResponseLimits.commands }, () =>
              "x".repeat(SessionTaskResponseLimits.command + 1),
            ),
            result: "r".repeat(SessionTaskResponseLimits.detailResult),
            error: "e".repeat(SessionTaskResponseLimits.detailError),
          })
          .where(eq(SessionTaskTable.id, detailTask.taskID))
          .run()
          .pipe(Effect.orDie)

        type TaskPage = {
          data: Array<{
            id: string
            agent: string
            model?: { id: string; providerID: string; variant?: string }
            description: string
            result?: string
            error?: string
            status: string
            [key: string]: unknown
          }>
          active: Array<{ id: string; status: string }>
          cursor: { next?: string | null }
        }
        const firstResponse = yield* request(`/api/session/${parent.id}/task?limit=2`, { headers })
        const first = (yield* responseJson(firstResponse)) as TaskPage
        expect(firstResponse.status, JSON.stringify(first)).toBe(200)
        const firstAnchor = yield* SessionTaskCursor.parse(first.cursor.next!)
        expect(
          yield* tasks.listPage({
            rootSessionID: firstAnchor.rootSessionID,
            after: { timeCreated: firstAnchor.timeCreated, id: firstAnchor.id },
            limit: 3,
          }),
        ).toHaveLength(3)
        const second = yield* requestJson<TaskPage>(
          `/api/session/${parent.id}/task?limit=2&cursor=${encodeURIComponent(first.cursor.next!)}`,
          { headers },
        )
        const third = yield* requestJson<TaskPage>(
          `/api/session/${parent.id}/task?limit=2&cursor=${encodeURIComponent(second.cursor.next!)}`,
          { headers },
        )
        const summaries = [...first.data, ...second.data, ...third.data]

        expect(first.data).toHaveLength(2)
        expect(second.data).toHaveLength(2)
        expect(third.data).toHaveLength(1)
        expect(third.cursor.next).toBeNull()
        expect(first.data[0]?.id).toBe(detailTask.taskID)
        expect(first.active).toEqual([{ ...first.data[0], status: "running" }])
        expect(second.active.map((task) => task.id)).toEqual([detailTask.taskID])
        expect(third.active.map((task) => task.id)).toEqual([detailTask.taskID])
        expect(summaries.map((task) => task.id)).toEqual(owned.toReversed().map((task) => task.taskID))
        expect(summaries.some((task) => "prompt" in task || "authority" in task || "actor" in task)).toBe(false)
        const detailSummary = summaries.find((task) => task.id === detailTask.taskID)
        expect(detailSummary?.description).toHaveLength(SessionTaskResponseLimits.summaryDescription)
        expect(detailSummary?.agent).toHaveLength(SessionTaskResponseLimits.agentID)
        expect(detailSummary?.model?.id).toHaveLength(SessionTaskResponseLimits.modelID)
        expect(detailSummary?.model?.providerID).toHaveLength(SessionTaskResponseLimits.providerID)
        expect(detailSummary?.model?.variant).toHaveLength(SessionTaskResponseLimits.variantID)
        expect(detailSummary?.result).toHaveLength(SessionTaskResponseLimits.summaryResult)
        expect(detailSummary?.error).toHaveLength(SessionTaskResponseLimits.summaryError)

        const other = yield* createSession({ title: "other task tree" })
        const crossTree = yield* request(
          `/api/session/${other.id}/task?limit=2&cursor=${encodeURIComponent(first.cursor.next!)}`,
          { headers },
        )
        expect(crossTree.status).toBe(400)
        expect(yield* responseJson(crossTree)).toMatchObject({ _tag: "InvalidCursorError" })
        expect((yield* request(`/api/session/${parent.id}/task?limit=101`, { headers })).status).toBe(400)

        type TaskDetail = {
          data: {
            agent: string
            model?: { id: string; providerID: string; variant?: string }
            actor: { toolCallID: string }
            prompt: { text: string }
            description: string
            authority: {
              parentPermissions: Array<{ action: string; resource: string }>
              ancestorPermissionSets: Array<unknown>
              childPermissions: Array<unknown>
              hardPermissions: Array<unknown>
              writeRoots: Array<string>
              commands: Array<string>
            }
            result?: string
            error?: string
            status: string
          }
        }
        const detail = yield* requestJson<TaskDetail>(`/api/session/${parent.id}/task/${detailTask.taskID}`, {
          headers,
        })

        expect(detail.data.actor.toolCallID).toHaveLength(SessionTaskResponseLimits.actorToolCallID)
        expect(detail.data.agent).toHaveLength(SessionTaskResponseLimits.agentID)
        expect(detail.data.model?.id).toHaveLength(SessionTaskResponseLimits.modelID)
        expect(detail.data.model?.providerID).toHaveLength(SessionTaskResponseLimits.providerID)
        expect(detail.data.model?.variant).toHaveLength(SessionTaskResponseLimits.variantID)
        expect(detail.data.prompt).toEqual({
          text: "p".repeat(SessionTaskResponseLimits.detailPrompt),
        })
        expect(detail.data.description).toHaveLength(SessionTaskResponseLimits.detailDescription)
        expect(detail.data.authority.parentPermissions).toHaveLength(2)
        expect(detail.data.authority.parentPermissions[0]?.action).toHaveLength(
          SessionTaskResponseLimits.permissionAction,
        )
        expect(detail.data.authority.parentPermissions[0]?.resource).toHaveLength(
          SessionTaskResponseLimits.permissionResource,
        )
        expect(detail.data.authority.ancestorPermissionSets).toHaveLength(
          SessionTaskResponseLimits.ancestorPermissionSets,
        )
        expect(detail.data.authority.childPermissions).toHaveLength(SessionTaskResponseLimits.permissionRules)
        expect(detail.data.authority.hardPermissions).toHaveLength(SessionTaskResponseLimits.permissionRules)
        expect(detail.data.authority.writeRoots).toHaveLength(SessionTaskResponseLimits.writeRoots)
        expect(detail.data.authority.writeRoots[0]).toHaveLength(SessionTaskResponseLimits.writeRoot)
        expect(detail.data.authority.commands).toHaveLength(SessionTaskResponseLimits.commands)
        expect(detail.data.authority.commands[0]).toHaveLength(SessionTaskResponseLimits.command)
        expect(detail.data.result).toHaveLength(SessionTaskResponseLimits.detailResult)
        expect(detail.data.error).toHaveLength(SessionTaskResponseLimits.detailError)

        const cancelStarted = Date.now()
        const cancelled = yield* requestJson<TaskDetail>(`/api/session/${parent.id}/task/${detailTask.taskID}/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify({ expectedRevision: detailTask.task.revision }),
        })
        expect(cancelled.data.status).toBe("cancelled")
        expect(Date.now() - cancelStarted).toBeLessThan(5_000)
        expect(
          yield* database.db
            .select({ cancelled: SessionInputTable.time_cancelled })
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, detailTask.inputID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ cancelled: expect.any(Number) })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects share creation while preserving legacy unshare",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const session = yield* createSession({ title: "private session" })
        const path = pathFor(SessionPaths.unshare, { sessionID: session.id })

        expect((yield* request(path, { method: "POST", headers })).status).toBe(404)

        const response = yield* request(path, { method: "DELETE", headers })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).id).toBe(session.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "refuses to delete a shared session when legacy revocation credentials are missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "inconsistent legacy share" })
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ share_url: "https://legacy-share.example.com/share/missing" })
          .where(eq(SessionTable.id, session.id))
          .run()
          .pipe(Effect.orDie)

        const response = yield* request(pathFor(SessionPaths.remove, { sessionID: session.id }), {
          method: "DELETE",
          headers: { "x-forge-directory": test.directory },
        })

        expect(response.status).toBe(500)
        expect((yield* Session.use.get(session.id)).shared).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.FORGE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-forge-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-forge-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "archives and unarchives a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archive round trip" })

        const archivedAt = () =>
          Database.Service.use(({ db }) =>
            db
              .select({ archived: SessionTable.time_archived })
              .from(SessionTable)
              .where(eq(SessionTable.id, session.id))
              .all()
              .pipe(Effect.orDie),
          )

        const update = (body: unknown) =>
          requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: session.id }), {
            method: "PATCH",
            headers,
            body: JSON.stringify(body),
          })

        const archived = yield* update({ time: { archived: 1234 } })
        expect(archived.time.archived).toBe(1234)
        expect(yield* archivedAt()).toEqual([{ archived: 1234 }])

        // Unrelated updates must not disturb archival.
        const renamed = yield* update({ title: "renamed while archived" })
        expect(renamed.title).toBe("renamed while archived")
        expect(renamed.time.archived).toBe(1234)
        expect(yield* archivedAt()).toEqual([{ archived: 1234 }])

        // Explicit null is the reversal. The projected row must actually clear:
        // drizzle omits undefined columns from UPDATE SET, so a response that
        // reports success while the row keeps its timestamp is the bug here.
        const restored = yield* update({ time: { archived: null } })
        expect(restored.time.archived).toBeUndefined()
        expect(yield* archivedAt()).toEqual([{ archived: null }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "forge", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir })),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/forge/src",
          directory: currentDir,
        })
        const headers = { "x-forge-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists sessions created through an equivalent directory hint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hint = test.directory + path.sep
        const headers = { "x-forge-directory": hint, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "hinted" }),
        })

        const query = new URLSearchParams({ directory: hint, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(created.id)

        const globalQuery = new URLSearchParams({ directory: hint })
        const global = yield* requestJson<Session.Info[]>(`${ExperimentalPaths.session}?${globalQuery}`, { headers })
        expect(global.map((item) => item.id)).toContain(created.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists Windows sessions for equivalent directory spellings",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "windows spelling" }),
        })

        const forwardSlashes = test.directory.replaceAll("\\", "/")
        const lowercaseDrive = test.directory.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        const trailingSeparator = `${test.directory}\\`
        for (const spelling of [forwardSlashes, lowercaseDrive, trailingSeparator]) {
          const query = new URLSearchParams({ directory: spelling, roots: "true" })
          const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
          expect({ spelling, ids: listed.map((item) => item.id) }).toEqual({ spelling, ids: [created.id] })
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 15000 },
  )

  it.instance(
    "lists Windows sessions created through the global worktree sentinel",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const globalWorktreeSentinel = "/"
        const headers = { "x-forge-directory": globalWorktreeSentinel, "content-type": "application/json" }
        const driveRootSession = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created at drive root" }),
        })
        expect(driveRootSession.directory).toMatch(/^[A-Za-z]:\\$/)

        const query = new URLSearchParams({ directory: globalWorktreeSentinel, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(driveRootSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 15000 },
  )

  it.instance(
    "pages the human transcript across checkpoints without expanding model context",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const session = yield* createSession({ title: "compacted transcript" })
        const events = yield* EventV2.Service
        const sessionID = SessionV2.ID.make(session.id)
        const expected: string[] = []
        for (let index = 0; index < 5; index++) {
          const messageID = SessionMessage.ID.create()
          expected.push(messageID)
          const prompted = yield* events.publish(SessionEvent.Prompted, {
            sessionID,
            messageID,
            prompt: { text: `Human ${index}` },
            delivery: "steer",
            source: "user",
            timestamp: DateTime.makeUnsafe(index),
          })
          if (index !== 1 && index !== 3) continue
          const checkpoint = SessionMessage.ID.create()
          expected.push(checkpoint)
          yield* events.publish(SessionEvent.Compaction.Ended, {
            sessionID,
            messageID: checkpoint,
            text: `Summary ${index}`,
            recent: "",
            reason: "manual",
            throughSeq: prompted.durable!.seq,
            timestamp: DateTime.makeUnsafe(index),
          })
        }
        const actual: string[] = []
        let cursor: string | undefined
        for (;;) {
          const page = yield* requestJson<{ data: Array<{ id: string }>; cursor: { next?: string } }>(
            `/api/session/${session.id}/message?${new URLSearchParams(cursor ? { cursor, limit: "2" } : { order: "asc", limit: "2" })}`,
            { headers },
          )
          actual.push(...page.data.map((message) => message.id))
          if (!page.cursor.next) break
          cursor = page.cursor.next
        }
        expect(actual).toEqual(expected)
        expect(new Set(actual).size).toBe(expected.length)
        const context = yield* requestJson<{ data: Array<{ id: string }> }>(`/api/session/${session.id}/context`, {
          headers,
        })
        expect(context.data.map((message) => message.id)).toEqual(expected.slice(-2))
        const original = yield* requestJson<{ data: { text: string; source: string } }>(
          `/api/session/${session.id}/message/${expected[0]}`,
          { headers },
        )
        expect(original.data).toMatchObject({ text: "Human 0", source: "user" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-forge-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
