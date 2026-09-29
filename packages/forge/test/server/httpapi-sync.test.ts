import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Flag } from "@turenlabs/core/flag/flag"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { Database } from "@turenlabs/core/database/database"
import { EventSequenceTable, EventTable } from "@turenlabs/core/event/sql"
import { EventV2 } from "@turenlabs/core/event"
import { AgentV2 } from "@turenlabs/core/agent"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionTaskTable } from "@turenlabs/core/session/task.sql"
import { SessionTask } from "@turenlabs/schema/session-task"
import { SessionEvent } from "@turenlabs/core/session/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.FORGE_EXPERIMENTAL_WORKSPACES
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer),
)

afterEach(async () => {
  mock.restore()
  Flag.FORGE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.FORGE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-forge-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync" })

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const rows = (yield* history.json) as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>
        expect(rows.map((row) => row.aggregate_id)).toContain(session.id)

        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: rows
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-forge-directory": tmp.directory, "content-type": "application/json" }
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* requestInDirectory(item.path, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(item.body),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "pages history and excludes durable types and task-protected aggregates",
    () =>
      Effect.gen(function* () {
        Flag.FORGE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-forge-directory": tmp.directory, "content-type": "application/json" }
        const { db } = yield* Database.Service
        const session = yield* Session.use.create({ title: "paged" })
        const child = yield* Session.use.create({ title: "protected child" })

        const seed = Effect.fnUntraced(function* (aggregateID: string, seqs: number[], type: string) {
          yield* db
            .insert(EventSequenceTable)
            .values({ aggregate_id: aggregateID, seq: Math.max(...seqs) })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(EventTable)
            .values(
              seqs.map((seq) => ({
                id: EventV2.ID.make(`evt_${aggregateID}_${seq}`),
                aggregate_id: aggregateID,
                seq,
                type,
                data: { seq },
              })),
            )
            .run()
            .pipe(Effect.orDie)
        })

        yield* seed("agg_page_a", [0, 1, 2, 3, 4], "session.test.event.1")
        yield* seed("agg_page_b", [0, 1, 2], "session.test.event.1")
        yield* seed("agg_durable", [0, 1], EventV2.versionedType(SessionEvent.Task.Updated.type, 1))

        // A session_task row protects its id plus root/parent/child aggregates:
        // both the session's own events and the child's must stay server-side.
        const now = Date.now()
        yield* db
          .insert(SessionTaskTable)
          .values({
            id: SessionTask.ID.make("tsk_sync_protected"),
            root_session_id: session.id,
            parent_session_id: session.id,
            child_session_id: child.id,
            actor_session_id: session.id,
            actor_assistant_message_id: SessionMessage.ID.make("msg_sync_actor"),
            actor_tool_call_id: "call_sync_actor",
            agent: AgentV2.ID.make("explore"),
            prompt: Prompt.make({ text: "protected" }),
            description: "protected aggregate fixture",
            depth: 1,
            status: "running",
            revision: 0,
            parent_permissions: [],
            ancestor_permission_sets: [],
            child_permissions: [],
            hard_permissions: [],
            write_roots: [],
            commands: [],
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)

        // Page exactly like Workspace.syncHistory: advance per-aggregate state
        // after each page and re-request until the server reports nothing new.
        const state: Record<string, number> = {}
        const sizes: number[] = []
        const seen: Array<{ aggregate_id: string; seq: number; type: string }> = []
        for (let page = 0; page < 10; page++) {
          const response = yield* requestInDirectory(`${SyncPaths.history}?limit=3`, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(state),
          })
          expect(response.status).toBe(200)
          const rows = (yield* response.json) as Array<{
            aggregate_id: string
            seq: number
            type: string
          }>
          sizes.push(rows.length)
          for (const row of rows) {
            seen.push(row)
            if (row.seq > (state[row.aggregate_id] ?? -1)) state[row.aggregate_id] = row.seq
          }
          if (rows.length === 0) break
        }

        expect(sizes.at(-1)).toBe(0)
        expect(sizes.every((size) => size <= 3)).toBe(true)
        expect(seen.some((row) => row.aggregate_id === session.id)).toBe(false)
        expect(seen.some((row) => row.aggregate_id === child.id)).toBe(false)
        expect(seen.some((row) => row.aggregate_id === "agg_durable")).toBe(false)
        expect(
          seen
            .filter((row) => row.aggregate_id.startsWith("agg_"))
            .map((row) => ({ aggregate_id: row.aggregate_id, seq: row.seq, type: row.type })),
        ).toEqual([
          ...[0, 1, 2, 3, 4].map((seq) => ({ aggregate_id: "agg_page_a", seq, type: "session.test.event.1" })),
          ...[0, 1, 2].map((seq) => ({ aggregate_id: "agg_page_b", seq, type: "session.test.event.1" })),
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects invalid history limit values",
    () =>
      Effect.gen(function* () {
        Flag.FORGE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-forge-directory": tmp.directory, "content-type": "application/json" }
        for (const limit of ["0", "-1", "abc", "10001"]) {
          const response = yield* requestInDirectory(`${SyncPaths.history}?limit=${limit}`, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-forge-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise((): Promise<unknown> => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
