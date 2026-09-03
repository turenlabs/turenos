import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@turenlabs/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "@turenlabs/core/database/migration"
import { migrations } from "@turenlabs/core/database/migration.gen"
import sessionUsageMigration from "@turenlabs/core/database/migration/20260510033149_session_usage"
import normalizeStoragePathsMigration from "@turenlabs/core/database/migration/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "@turenlabs/core/database/migration/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "@turenlabs/core/database/migration/20260604172448_event_sourced_session_input"
import contextEpochAgentMigration from "@turenlabs/core/database/migration/20260605042240_add_context_epoch_agent"
import simplifyIntegrationCredentialsMigration from "@turenlabs/core/database/migration/20260611192811_lush_chimera"
import simplifySessionInputMigration from "@turenlabs/core/database/migration/20260622202450_simplify_session_input"
import sessionGoalIdentityMigration from "@turenlabs/core/database/migration/20260727201758_session-goal-identity"
import sessionMessageIdentityMigration from "@turenlabs/core/database/migration/20260727204640_session-message-identity"
import sessionGoalRemoveBudgetMigration from "@turenlabs/core/database/migration/20260828141433_session-goal-remove-budget"
import sessionTaskLifecycleMigration from "@turenlabs/core/database/migration/20260727221136_session-task-lifecycle-hardening"
import accountRemoteIdMigration from "@turenlabs/core/database/migration/20260803175613_account_remote_id"
import teamBoardNoteMigration from "@turenlabs/core/database/migration/20260808164633_team_board_note"
import teamBoardParentNotificationMigration from "@turenlabs/core/database/migration/20260809152000_team_board_parent_notification"
import pentestRunOwnerMigration from "@turenlabs/core/database/migration/20260822013004_pentest-run-owner"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTable } from "@turenlabs/core/session/sql"
import sessionMetadataMigration from "@turenlabs/core/database/migration/20260511173437_session-metadata"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@turenlabs/core/database/database"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })

  test("serializes migration admission and rechecks completion across processes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "cross-process.sqlite")
    const worker = fileURLToPath(new URL("./fixture/migration-process.ts", import.meta.url))
    const [first, second] = await Promise.all([
      $`bun ${worker} ${filename}`.quiet().nothrow(),
      $`bun ${worker} ${filename}`.quiet().nothrow(),
    ])

    expect(first.exitCode, first.stderr.toString()).toBe(0)
    expect(second.exitCode, second.stderr.toString()).toBe(0)
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cross_process_migration_probe'`,
          ),
        ).toEqual({ name: "cross_process_migration_probe" })
        expect(
          yield* db.get(sql`SELECT count(*) AS count FROM migration WHERE id = 'test-cross-process-migration-lock'`),
        ).toEqual({ count: 1 })
      }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
    )
  })
  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_goal'`),
        ).toEqual({ name: "session_goal" })
        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_goal') WHERE name = 'token_budget'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_goal_identity') WHERE name = 'token_budget'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_task'`),
        ).toEqual({ name: "session_task" })
        expect(
          yield* db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE name LIKE 'reversing_%'`),
        ).toEqual([])
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_task_operation'`),
        ).toEqual({ name: "session_task_operation" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_task_actor_claim'`),
        ).toEqual({ name: "session_task_actor_claim" })
        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_task') WHERE name = 'actor_session_id'`),
        ).toEqual({ name: "actor_session_id" })
        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_input') WHERE name = 'time_cancelled'`),
        ).toEqual({ name: "time_cancelled" })
        expect(
          yield* db.get(
            sql`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('session_goal') WHERE "from" = 'session_id'`,
          ),
        ).toEqual({ table: "session", from: "session_id", to: "id", on_delete: "CASCADE" })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_context_epoch') WHERE name IN ('agent', 'replacement_seq', 'revision')`,
          ),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_pending_board_session_idx', 'session_input_session_pending_seq_idx', 'session_input_session_pending_delivery_seq_idx', 'session_input_session_pending_source_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_pending_board_session_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_pending_delivery_seq_idx" },
          { name: "session_input_session_pending_source_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
      }),
    )
  })

  test("removes persisted goal budgets and pauses exhausted legacy goals", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`ALTER TABLE session_goal ADD COLUMN token_budget integer`)
        yield* db.run(sql`ALTER TABLE session_goal_identity ADD COLUMN token_budget integer`)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('goal_budget_project', '/goal-budget', 1, 1, '[]')`,
        )
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('ses_goal_budget', 'goal_budget_project', 'goal-budget', '/goal-budget', 'Goal budget', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session_goal_identity (
            goal_id, session_id, objective, state, time_created, token_budget
          ) VALUES ('goal_budget', 'ses_goal_budget', 'legacy objective', 'current', 1, 100)
        `)
        yield* db.run(sql`
          INSERT INTO session_goal (
            session_id, goal_id, revision, objective, status, tokens_used, active_time_ms,
            status_changed_at, time_created, time_updated, token_budget
          ) VALUES (
            'ses_goal_budget', 'goal_budget', 2, 'legacy objective', 'budgetLimited', 100, 1000,
            2, 1, 2, 100
          )
        `)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_goal_budget', 1)`)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_goal_budget',
            'ses_goal_budget',
            1,
            'session.next.goal.updated.1',
            ${JSON.stringify({
              timestamp: 2,
              goal: {
                id: "goal_budget",
                sessionID: "ses_goal_budget",
                revision: 2,
                objective: "legacy objective",
                status: "budgetLimited",
                tokenBudget: 100,
                tokensUsed: 100,
                timeUsedSeconds: 1,
                time: { created: 1, updated: 2, statusChanged: 2 },
              },
              activeTimeMs: 1000,
            })}
          )
        `)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${sessionGoalRemoveBudgetMigration.id}`)

        yield* DatabaseMigration.applyOnly(db, [sessionGoalRemoveBudgetMigration])

        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_goal') WHERE name = 'token_budget'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_goal_identity') WHERE name = 'token_budget'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT status FROM session_goal WHERE session_id = 'ses_goal_budget'`)).toEqual({
          status: "paused",
        })
        const event = yield* db.get<{ data: string }>(sql`SELECT data FROM event WHERE id = 'evt_goal_budget'`)
        const migratedGoal = JSON.parse(event!.data).goal
        expect(migratedGoal).toMatchObject({ status: "paused", tokensUsed: 100 })
        expect(migratedGoal).not.toHaveProperty("tokenBudget")
      }),
    )
  })

  test("adds parent notification state to an existing team board database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.applyOnly(db, [teamBoardNoteMigration])
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('team_board_note') WHERE name = 'parent_notification_status'`,
          ),
        ).toBeUndefined()

        yield* DatabaseMigration.applyOnly(db, [teamBoardParentNotificationMigration])
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('team_board_note') WHERE name = 'parent_notification_status'`,
          ),
        ).toEqual({ name: "parent_notification_status" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'team_board_pending_notification_idx'`,
          ),
        ).toEqual({ name: "team_board_pending_notification_idx" })
      }),
    )
  })

  test("backfills pentest ownership only from unambiguous durable placement", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE pentest_run (
            id text PRIMARY KEY,
            session_id text,
            status text NOT NULL DEFAULT 'queued',
            revision integer NOT NULL DEFAULT 1,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE pentest_execution (
            id text PRIMARY KEY,
            run_id text NOT NULL,
            location_json text,
            state text NOT NULL DEFAULT 'queued',
            lease_owner text,
            lease_until integer,
            error text
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text NOT NULL,
            workspace_id text,
            directory text NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE project_directory (
            project_id text NOT NULL,
            directory text NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO pentest_run (id, session_id, time_updated)
          VALUES
            ('linked_consistent', 'ses_consistent', 1),
            ('linked_conflict', 'ses_conflict', 1),
            ('linked_null', 'ses_null', 1),
            ('unlinked_unique', NULL, 1),
            ('unlinked_location_conflict', NULL, 1),
            ('unlinked_project_ambiguous', NULL, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, workspace_id, directory)
          VALUES
            ('ses_consistent', 'project-a', 'wrk_a', '/project-a'),
            ('ses_conflict', 'project-a', NULL, '/project-a'),
            ('ses_null', 'project-a', NULL, '/project-null')
        `)
        yield* db.run(sql`
          INSERT INTO pentest_execution (id, run_id, location_json)
          VALUES
            ('exec_consistent', 'linked_consistent', '{"directory":"/project-a","workspaceID":"wrk_a"}'),
            ('exec_conflict', 'linked_conflict', '{"directory":"/project-b"}'),
            ('exec_null', 'linked_null', NULL),
            ('exec_unique_a', 'unlinked_unique', '{"directory":"/unique"}'),
            ('exec_unique_b', 'unlinked_unique', '{"directory":"/unique"}'),
            ('exec_location_a', 'unlinked_location_conflict', '{"directory":"/first"}'),
            ('exec_location_b', 'unlinked_location_conflict', '{"directory":"/second"}'),
            ('exec_ambiguous', 'unlinked_project_ambiguous', '{"directory":"/shared"}')
        `)
        yield* db.run(sql`
          INSERT INTO project_directory (project_id, directory)
          VALUES
            ('project-a', '/unique'),
            ('project-a', '/shared'),
            ('project-b', '/shared')
        `)

        yield* DatabaseMigration.applyOnly(db, [pentestRunOwnerMigration])

        expect(
          yield* db.all(sql`
            SELECT id, project_id, location_json
            FROM pentest_run
            ORDER BY id
          `),
        ).toEqual([
          {
            id: "linked_conflict",
            project_id: null,
            location_json: null,
          },
          {
            id: "linked_consistent",
            project_id: "project-a",
            location_json: '{"directory":"/project-a","workspaceID":"wrk_a"}',
          },
          {
            id: "linked_null",
            project_id: "project-a",
            location_json: '{"directory":"/project-null"}',
          },
          {
            id: "unlinked_location_conflict",
            project_id: null,
            location_json: null,
          },
          {
            id: "unlinked_project_ambiguous",
            project_id: null,
            location_json: '{"directory":"/shared"}',
          },
          {
            id: "unlinked_unique",
            project_id: "project-a",
            location_json: '{"directory":"/unique"}',
          },
        ])
        expect(
          yield* db.all(sql`
            SELECT run_id, state, error
            FROM pentest_execution
            ORDER BY run_id, id
          `),
        ).toEqual([
          {
            run_id: "linked_conflict",
            state: "failed",
            error: "Execution quarantined because durable run ownership could not be established",
          },
          { run_id: "linked_consistent", state: "queued", error: null },
          {
            run_id: "linked_null",
            state: "failed",
            error: "Execution quarantined because durable run ownership could not be established",
          },
          {
            run_id: "unlinked_location_conflict",
            state: "failed",
            error: "Execution quarantined because durable run ownership could not be established",
          },
          {
            run_id: "unlinked_location_conflict",
            state: "failed",
            error: "Execution quarantined because durable run ownership could not be established",
          },
          {
            run_id: "unlinked_project_ambiguous",
            state: "failed",
            error: "Execution quarantined because durable run ownership could not be established",
          },
          { run_id: "unlinked_unique", state: "queued", error: null },
          { run_id: "unlinked_unique", state: "queued", error: null },
        ])
        expect(yield* db.get(sql`SELECT status FROM pentest_run WHERE id = 'linked_null'`)).toEqual({
          status: "failed",
        })
      }),
    )
  })

  test("backfills permanent task actor claims before legacy task rows can disappear", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE session_task (
            id text PRIMARY KEY,
            parent_session_id text NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session_task_operation (
            id text PRIMARY KEY,
            task_id text NOT NULL,
            actor_session_id text NOT NULL,
            actor_assistant_message_id text NOT NULL,
            actor_tool_call_id text NOT NULL,
            kind text NOT NULL,
            request_hash text NOT NULL,
            time_created integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_task (id, parent_session_id)
          VALUES ('tsk_existing', 'ses_parent')
        `)
        yield* db.run(sql`
          INSERT INTO session_task_operation (
            id,
            task_id,
            actor_session_id,
            actor_assistant_message_id,
            actor_tool_call_id,
            kind,
            request_hash,
            time_created
          )
          VALUES (
            'tso_existing',
            'tsk_existing',
            'ses_parent',
            'msg_actor',
            'call_actor',
            'spawn',
            'request-hash',
            42
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionTaskLifecycleMigration])

        expect(yield* db.get(sql`SELECT actor_session_id FROM session_task WHERE id = 'tsk_existing'`)).toEqual({
          actor_session_id: "ses_parent",
        })
        expect(
          yield* db.get(sql`
            SELECT
              operation_id,
              task_id,
              actor_session_id,
              actor_assistant_message_id,
              actor_tool_call_id,
              kind,
              request_hash,
              time_created
            FROM session_task_actor_claim
            WHERE operation_id = 'tso_existing'
          `),
        ).toEqual({
          operation_id: "tso_existing",
          task_id: "tsk_existing",
          actor_session_id: "ses_parent",
          actor_assistant_message_id: "msg_actor",
          actor_tool_call_id: "call_actor",
          kind: "spawn",
          request_hash: "request-hash",
          time_created: 42,
        })

        yield* db.run(sql`DELETE FROM session_task_operation WHERE id = 'tso_existing'`)
        yield* db.run(sql`DELETE FROM session_task WHERE id = 'tsk_existing'`)
        expect(
          yield* db.get(sql`
            SELECT operation_id
            FROM session_task_actor_claim
            WHERE operation_id = 'tso_existing'
          `),
        ).toEqual({ operation_id: "tso_existing" })
      }),
    )
  })

  test("backfills permanent identities from reverted admission history and rejects duplicate admissions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DROP TABLE session_message_identity`)
        yield* db.run(sql`DROP TABLE session_goal_identity`)
        yield* db.run(sql`ALTER TABLE session_goal ADD COLUMN token_budget integer`)
        yield* db.run(
          sql`DELETE FROM migration WHERE id IN (${sessionGoalIdentityMigration.id}, ${sessionMessageIdentityMigration.id})`,
        )
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_identity_history', 'global', 'history', '/project', 'History', 'test', 1, 1)`,
        )
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES
            ('ses_goal_cleared_history', 'global', 'cleared', '/project', 'Cleared', 'test', 1, 1),
            ('ses_goal_edited_history', 'global', 'edited', '/project', 'Edited', 'test', 1, 1),
            ('ses_goal_replaced_history', 'global', 'replaced', '/project', 'Replaced', 'test', 1, 1),
            ('ses_goal_tool_history', 'global', 'tool', '/project', 'Tool', 'test', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_identity_history',
            'ses_identity_history',
            1,
            'session.next.prompt.admitted.1',
            '{"timestamp":1,"sessionID":"ses_identity_history","messageID":"msg_identity_history","prompt":{"text":"historical"},"delivery":"steer","agent":"build","model":{"providerID":"provider","id":"model"}}'
          )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            (
              'evt_goal_edited_create',
              'ses_goal_edited_history',
              1,
              'session.next.goal.updated.1',
              '{"timestamp":15,"goal":{"id":"goal_edited_history","sessionID":"ses_goal_edited_history","revision":1,"objective":"original","status":"active","tokenBudget":100,"tokensUsed":0,"timeUsedSeconds":0,"time":{"created":15,"updated":15,"statusChanged":15}},"activeTimeMs":0}'
            ),
            (
              'evt_goal_edited_update',
              'ses_goal_edited_history',
              2,
              'session.next.goal.updated.1',
              '{"timestamp":16,"goal":{"id":"goal_edited_history","sessionID":"ses_goal_edited_history","revision":2,"objective":"edited","status":"paused","tokenBudget":200,"tokensUsed":2,"timeUsedSeconds":1,"time":{"created":15,"updated":16,"statusChanged":16}},"activeTimeMs":1000}'
            )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_identity_visible',
            'ses_identity_history',
            2,
            'session.next.prompted.1',
            '{"timestamp":2,"sessionID":"ses_identity_history","messageID":"msg_identity_visible","prompt":{"text":"visible"},"delivery":"steer"}'
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES ('msg_identity_visible', 'ses_identity_history', 'user', 2, 2, 2, '{}')
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_identity_goal',
            'ses_identity_history',
            3,
            'session.next.goal.updated.1',
            '{"timestamp":3,"goal":{"id":"goal_identity_history","sessionID":"ses_identity_history","revision":1,"objective":"goal","status":"active","tokensUsed":0,"timeUsedSeconds":0,"time":{"created":3,"updated":3,"statusChanged":3}},"activeTimeMs":0,"admission":{"messageID":"msg_identity_goal","prompt":{"text":"goal"},"delivery":"steer","agent":"build","model":{"providerID":"provider","id":"model"}}}'
          )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_identity_shell',
            'ses_identity_history',
            4,
            'session.next.shell.started.1',
            '{"timestamp":4,"messageID":"msg_identity_shell"}'
          )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_identity_message',
            'ses_identity_history',
            5,
            'session.next.synthetic.1',
            '{"timestamp":5,"messageID":"msg_identity_message"}'
          )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            (
              'evt_goal_cleared_create',
              'ses_goal_cleared_history',
              1,
              'session.next.goal.updated.1',
              '{"timestamp":10,"goal":{"id":"goal_cleared_history","sessionID":"ses_goal_cleared_history","revision":1,"objective":"clear me","status":"active","tokensUsed":0,"timeUsedSeconds":0,"time":{"created":10,"updated":10,"statusChanged":10}},"activeTimeMs":0}'
            ),
            (
              'evt_goal_cleared_update',
              'ses_goal_cleared_history',
              2,
              'session.next.goal.updated.1',
              '{"timestamp":11,"goal":{"id":"goal_cleared_history","sessionID":"ses_goal_cleared_history","revision":2,"objective":"clear me","status":"paused","tokensUsed":1,"timeUsedSeconds":1,"time":{"created":10,"updated":11,"statusChanged":11}},"activeTimeMs":1000}'
            ),
            (
              'evt_goal_cleared',
              'ses_goal_cleared_history',
              3,
              'session.next.goal.cleared.1',
              '{"timestamp":12,"goalID":"goal_cleared_history","revision":2}'
            )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            (
              'evt_goal_replaced_create',
              'ses_goal_replaced_history',
              1,
              'session.next.goal.updated.1',
              '{"timestamp":20,"goal":{"id":"goal_replaced_history","sessionID":"ses_goal_replaced_history","revision":1,"objective":"old","status":"active","tokensUsed":0,"timeUsedSeconds":0,"time":{"created":20,"updated":20,"statusChanged":20}},"activeTimeMs":0}'
            ),
            (
              'evt_goal_replaced_complete',
              'ses_goal_replaced_history',
              2,
              'session.next.goal.updated.1',
              '{"timestamp":21,"goal":{"id":"goal_replaced_history","sessionID":"ses_goal_replaced_history","revision":2,"objective":"old","status":"complete","tokensUsed":1,"timeUsedSeconds":1,"time":{"created":20,"updated":21,"statusChanged":21,"completed":21}},"activeTimeMs":1000}'
            ),
            (
              'evt_goal_replacement_create',
              'ses_goal_replaced_history',
              3,
              'session.next.goal.updated.1',
              '{"timestamp":22,"goal":{"id":"goal_replacement_history","sessionID":"ses_goal_replaced_history","revision":1,"objective":"new","status":"active","tokensUsed":0,"timeUsedSeconds":0,"time":{"created":22,"updated":22,"statusChanged":22}},"activeTimeMs":0}'
            )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_goal_tool_create',
            'ses_goal_tool_history',
            1,
            'session.next.goal.updated.1',
            '{"timestamp":30,"goal":{"id":"goal_tool_history","sessionID":"ses_goal_tool_history","revision":1,"objective":"tool goal","status":"active","tokensUsed":0,"timeUsedSeconds":0,"time":{"created":30,"updated":30,"statusChanged":30}},"activeTimeMs":0}'
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionGoalIdentityMigration, sessionMessageIdentityMigration])

        const identity = yield* db.get<{
          owner: string
          kind: string
          state: string
          input: string
        }>(sql`
          SELECT owner, kind, state, input
          FROM session_message_identity
          WHERE id = 'msg_identity_history'
        `)
        expect(identity).toMatchObject({ owner: "input", kind: "prompt", state: "reverted" })
        expect(JSON.parse(identity!.input)).toMatchObject({
          admitted: {
            admittedSeq: 1,
            id: "msg_identity_history",
            sessionID: "ses_identity_history",
            prompt: { text: "historical" },
            delivery: "steer",
            agent: "build",
            model: { providerID: "provider", id: "model" },
            timeCreated: 1,
          },
        })
        expect(
          yield* db.get(sql`
            SELECT owner, kind, state
            FROM session_message_identity
            WHERE id = 'msg_identity_visible'
          `),
        ).toEqual({ owner: "input", kind: "prompt", state: "active" })
        const historical = yield* db.all<{
          id: string
          session_id: string
          owner: string
          kind: string
          state: string
          creator_seq: number | null
          input: string | null
        }>(sql`
          SELECT id, session_id, owner, kind, state, creator_seq, input
          FROM session_message_identity
          WHERE id IN ('msg_identity_goal', 'msg_identity_shell', 'msg_identity_message')
          ORDER BY id
        `)
        expect(
          historical.map((row) => ({
            id: row.id,
            sessionID: row.session_id,
            owner: row.owner,
            kind: row.kind,
            state: row.state,
            creatorSeq: row.creator_seq,
          })),
        ).toEqual([
          {
            id: "msg_identity_goal",
            sessionID: "ses_identity_history",
            owner: "input",
            kind: "goal",
            state: "reverted",
            creatorSeq: null,
          },
          {
            id: "msg_identity_message",
            sessionID: "ses_identity_history",
            owner: "message",
            kind: "message",
            state: "reverted",
            creatorSeq: 5,
          },
          {
            id: "msg_identity_shell",
            sessionID: "ses_identity_history",
            owner: "message",
            kind: "shell",
            state: "reverted",
            creatorSeq: 4,
          },
        ])
        expect(JSON.parse(historical.find((row) => row.id === "msg_identity_goal")!.input!)).toMatchObject({
          admitted: {
            admittedSeq: 3,
            id: "msg_identity_goal",
            sessionID: "ses_identity_history",
            prompt: { text: "goal" },
            delivery: "steer",
            agent: "build",
            model: { providerID: "provider", id: "model" },
            timeCreated: 3,
          },
        })
        expect(
          yield* db.get(sql`
            SELECT goal_id, session_id, message_id, objective, state
            FROM session_goal_identity
            WHERE goal_id = 'goal_identity_history'
          `),
        ).toEqual({
          goal_id: "goal_identity_history",
          session_id: "ses_identity_history",
          message_id: "msg_identity_goal",
          objective: "goal",
          state: "current",
        })
        expect(
          yield* db.get(sql`
            SELECT goal_id, revision, objective, status
            FROM session_goal
            WHERE session_id = 'ses_identity_history'
          `),
        ).toEqual({
          goal_id: "goal_identity_history",
          revision: 1,
          objective: "goal",
          status: "active",
        })
        expect(
          yield* db.all(sql`
            SELECT goal_id, session_id, message_id, state, final_revision, time_terminal
            FROM session_goal_identity
            WHERE goal_id IN (
              'goal_cleared_history',
              'goal_edited_history',
              'goal_replaced_history',
              'goal_replacement_history',
              'goal_tool_history'
            )
            ORDER BY goal_id
          `),
        ).toEqual([
          {
            goal_id: "goal_cleared_history",
            session_id: "ses_goal_cleared_history",
            message_id: null,
            state: "cleared",
            final_revision: 2,
            time_terminal: 12,
          },
          {
            goal_id: "goal_edited_history",
            session_id: "ses_goal_edited_history",
            message_id: null,
            state: "current",
            final_revision: null,
            time_terminal: null,
          },
          {
            goal_id: "goal_replaced_history",
            session_id: "ses_goal_replaced_history",
            message_id: null,
            state: "replaced",
            final_revision: 2,
            time_terminal: 22,
          },
          {
            goal_id: "goal_replacement_history",
            session_id: "ses_goal_replaced_history",
            message_id: null,
            state: "current",
            final_revision: null,
            time_terminal: null,
          },
          {
            goal_id: "goal_tool_history",
            session_id: "ses_goal_tool_history",
            message_id: null,
            state: "current",
            final_revision: null,
            time_terminal: null,
          },
        ])
        expect(
          yield* db.all(sql`
            SELECT session_id, goal_id, revision
            FROM session_goal
            WHERE session_id IN (
              'ses_goal_cleared_history',
              'ses_goal_edited_history',
              'ses_goal_replaced_history',
              'ses_goal_tool_history'
            )
            ORDER BY session_id
          `),
        ).toEqual([
          {
            session_id: "ses_goal_edited_history",
            goal_id: "goal_edited_history",
            revision: 2,
          },
          {
            session_id: "ses_goal_replaced_history",
            goal_id: "goal_replacement_history",
            revision: 1,
          },
          {
            session_id: "ses_goal_tool_history",
            goal_id: "goal_tool_history",
            revision: 1,
          },
        ])
        expect(
          yield* db.get(sql`
            SELECT identity.objective AS identity_objective,
              identity.token_budget AS identity_budget,
              goal.objective AS current_objective,
              goal.token_budget AS current_budget
            FROM session_goal_identity AS identity
            INNER JOIN session_goal AS goal ON goal.goal_id = identity.goal_id
            WHERE identity.goal_id = 'goal_edited_history'
          `),
        ).toEqual({
          identity_objective: "original",
          identity_budget: 100,
          current_objective: "edited",
          current_budget: 200,
        })

        yield* db.run(sql`DROP TABLE session_message_identity`)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${sessionMessageIdentityMigration.id}`)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_identity_duplicate',
            'ses_identity_history',
            6,
            'session.next.prompt.admitted.1',
            '{"timestamp":6,"sessionID":"ses_identity_history","messageID":"msg_identity_history","prompt":{"text":"changed"},"delivery":"queue"}'
          )
        `)
        const duplicate = yield* DatabaseMigration.applyOnly(db, [sessionMessageIdentityMigration]).pipe(Effect.exit)
        expect(duplicate._tag).toBe("Failure")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_message_identity'`),
        ).toBeUndefined()
      }),
    )
  })

  test("rejects duplicate historical creators and mismatched identity projections", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DROP TABLE session_message_identity`)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${sessionMessageIdentityMigration.id}`)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('identity_project', '/identity', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_identity_a', 'identity_project', 'a', '/identity', 'A', 'test', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_identity_b', 'identity_project', 'b', '/identity', 'B', 'test', 1, 1)`,
        )
        const expectRejected = () =>
          Effect.gen(function* () {
            expect(
              (yield* DatabaseMigration.applyOnly(db, [sessionMessageIdentityMigration]).pipe(Effect.exit))._tag,
            ).toBe("Failure")
            expect(
              yield* db.get(
                sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_message_identity'`,
              ),
            ).toBeUndefined()
          })

        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            ('evt_prompted_duplicate_a', 'ses_identity_a', 1, 'session.next.prompted.1', '{"timestamp":1,"messageID":"msg_prompted_duplicate","prompt":{"text":"same"},"delivery":"steer"}'),
            ('evt_prompted_duplicate_b', 'ses_identity_a', 2, 'session.next.prompted.1', '{"timestamp":2,"messageID":"msg_prompted_duplicate","prompt":{"text":"same"},"delivery":"steer"}')
        `)
        yield* expectRejected()
        yield* db.run(sql`DELETE FROM event`)

        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            ('evt_shell_duplicate_a', 'ses_identity_a', 1, 'session.next.shell.started.1', '{"timestamp":1,"messageID":"msg_shell_duplicate"}'),
            ('evt_shell_duplicate_b', 'ses_identity_a', 2, 'session.next.shell.started.1', '{"timestamp":2,"messageID":"msg_shell_duplicate"}')
        `)
        yield* expectRejected()
        yield* db.run(sql`DELETE FROM event`)

        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            ('evt_message_duplicate_a', 'ses_identity_a', 1, 'session.next.synthetic.1', '{"timestamp":1,"messageID":"msg_message_duplicate"}'),
            ('evt_message_duplicate_b', 'ses_identity_a', 2, 'session.next.synthetic.1', '{"timestamp":2,"messageID":"msg_message_duplicate"}')
        `)
        yield* expectRejected()
        yield* db.run(sql`DELETE FROM event`)

        yield* db.run(sql`
          INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
          VALUES ('msg_shell_projection', 'ses_identity_b', 'shell', 1, 1, 1, '{}')
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES ('evt_shell_projection', 'ses_identity_a', 1, 'session.next.shell.started.1', '{"timestamp":1,"messageID":"msg_shell_projection"}')
        `)
        yield* expectRejected()
        yield* db.run(sql`DELETE FROM event`)
        yield* db.run(sql`DELETE FROM session_message`)

        yield* db.run(sql`
          INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created)
          VALUES ('msg_input_projection', 'ses_identity_a', '{"text":"current"}', 'steer', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES (
            'evt_input_projection',
            'ses_identity_a',
            1,
            'session.next.prompt.admitted.1',
            '{"timestamp":1,"messageID":"msg_input_projection","prompt":{"text":"different"},"delivery":"steer"}'
          )
        `)
        yield* expectRejected()
      }),
    )
  })

  test("rejects cross-session goal revisions and stale current goal projections", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DROP TABLE session_goal_identity`)
        yield* db.run(sql`ALTER TABLE session_goal ADD COLUMN token_budget integer`)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${sessionGoalIdentityMigration.id}`)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('goal_history_project', '/goal-history', 1, 1, '[]')`,
        )
        yield* db.run(sql`
          INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES
            ('ses_goal_history_a', 'goal_history_project', 'a', '/goal-history', 'A', 'test', 1, 1),
            ('ses_goal_history_b', 'goal_history_project', 'b', '/goal-history', 'B', 'test', 1, 1)
        `)
        const expectRejected = () =>
          Effect.gen(function* () {
            expect(
              (yield* DatabaseMigration.applyOnly(db, [sessionGoalIdentityMigration]).pipe(Effect.exit))._tag,
            ).toBe("Failure")
            expect(
              yield* db.get(
                sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_goal_identity'`,
              ),
            ).toBeUndefined()
          })

        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            (
              'evt_goal_cross_session_create',
              'ses_goal_history_a',
              1,
              'session.next.goal.updated.1',
              '{"timestamp":1,"goal":{"id":"goal_cross_session","sessionID":"ses_goal_history_a","revision":1,"objective":"first","status":"active","tokensUsed":0,"timeUsedSeconds":0,"time":{"created":1,"updated":1,"statusChanged":1}},"activeTimeMs":0}'
            ),
            (
              'evt_goal_cross_session_update',
              'ses_goal_history_b',
              1,
              'session.next.goal.updated.1',
              '{"timestamp":2,"goal":{"id":"goal_cross_session","sessionID":"ses_goal_history_b","revision":2,"objective":"second","status":"paused","tokensUsed":1,"timeUsedSeconds":1,"time":{"created":1,"updated":2,"statusChanged":2}},"activeTimeMs":1000}'
            )
        `)
        yield* expectRejected()
        yield* db.run(sql`DELETE FROM event`)

        yield* db.run(sql`
          INSERT INTO session_goal (
            session_id,
            goal_id,
            revision,
            objective,
            status,
            tokens_used,
            active_time_ms,
            status_changed_at,
            time_created,
            time_updated
          )
          VALUES (
            'ses_goal_history_a',
            'goal_stale_projection',
            1,
            'stale',
            'active',
            0,
            0,
            1,
            1,
            1
          )
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            (
              'evt_goal_stale_create',
              'ses_goal_history_a',
              1,
              'session.next.goal.updated.1',
              '{"timestamp":1,"goal":{"id":"goal_stale_projection","sessionID":"ses_goal_history_a","revision":1,"objective":"original","status":"active","tokensUsed":0,"timeUsedSeconds":0,"time":{"created":1,"updated":1,"statusChanged":1}},"activeTimeMs":0}'
            ),
            (
              'evt_goal_stale_update',
              'ses_goal_history_a',
              2,
              'session.next.goal.updated.1',
              '{"timestamp":2,"goal":{"id":"goal_stale_projection","sessionID":"ses_goal_history_a","revision":2,"objective":"latest","status":"paused","tokensUsed":2,"timeUsedSeconds":1,"time":{"created":1,"updated":2,"statusChanged":2}},"activeTimeMs":1000}'
            )
        `)
        yield* expectRejected()
      }),
    )
  })

  test("rolls back the ordered migration batch and its journal when a later migration fails", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const result = yield* DatabaseMigration.applyOnly(db, [
          {
            id: "test-ordered-first",
            up: (tx) => tx.run(sql`CREATE TABLE ordered_first (id integer PRIMARY KEY)`).pipe(Effect.asVoid),
          },
          {
            id: "test-ordered-second",
            up: (tx) =>
              tx
                .run(sql`CREATE TABLE ordered_second (id integer PRIMARY KEY)`)
                .pipe(Effect.andThen(Effect.fail(new Error("stop migration batch"))), Effect.asVoid),
          },
        ]).pipe(Effect.exit)

        expect(result._tag).toBe("Failure")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ordered_first'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ordered_second'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`),
        ).toBeUndefined()
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("keeps legacy credential fields nullable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE credential (id text PRIMARY KEY, connector_id text NOT NULL, method_id text NOT NULL, label text NOT NULL, value text NOT NULL, active integer DEFAULT false NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE UNIQUE INDEX credential_connector_active_idx ON credential (connector_id) WHERE active = 1`,
        )
        yield* DatabaseMigration.applyOnly(db, [simplifyIntegrationCredentialsMigration])

        yield* db.run(
          sql`INSERT INTO credential (id, connector_id, method_id, label, value, active, time_created, time_updated) VALUES ('legacy', 'openai', 'oauth', 'Legacy', '{}', 1, 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('current', 'anthropic', 'Current', '{}', 2, 2)`,
        )
        expect(yield* db.get(sql`SELECT connector_id, method_id, active FROM credential WHERE id = 'current'`)).toEqual(
          { connector_id: null, method_id: null, active: null },
        )
      }),
    )
  })

  test("moves the control plane account id to a lookup attribute without re-keying vault scopes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('remote-user-1', 'one@example.com', 'https://one.example.com', 'sealed-at-1', 'sealed-rt-1', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('remote-user-2', 'two@example.com', 'https://two.example.com/', 'sealed-at-2', 'sealed-rt-2', 2, 2)`,
        )

        yield* DatabaseMigration.applyOnly(db, [accountRemoteIdMigration])

        // `id` must survive untouched: it is the secret vault scope every
        // stored token was sealed under.
        expect(yield* db.all(sql`SELECT id, remote_id, url, access_token FROM account ORDER BY id`)).toEqual([
          {
            id: "remote-user-1",
            remote_id: "remote-user-1",
            url: "https://one.example.com",
            access_token: "sealed-at-1",
          },
          {
            id: "remote-user-2",
            remote_id: "remote-user-2",
            url: "https://two.example.com",
            access_token: "sealed-at-2",
          },
        ])
        yield* db.run(
          sql`INSERT INTO account (id, remote_id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('acc_local', 'remote-user-1', 'one@example.com', 'https://two.example.com', 'sealed-at-3', 'sealed-rt-3', 3, 3)`,
        )
        const collision = yield* db
          .run(
            sql`INSERT INTO account (id, remote_id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('acc_duplicate', 'remote-user-1', 'one@example.com', 'https://one.example.com', 'sealed-at-4', 'sealed-rt-4', 4, 4)`,
          )
          .pipe(Effect.exit)
        expect(collision._tag).toBe("Failure")
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("preserves canonical V1 state and restarts its event stream", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO workspace (id, type, project_id, time_used) VALUES ('workspace', 'local', 'global', 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'global', 'workspace', 'session', '/project', 'Before', 'test', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part', 'message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 9)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event', 'session', 9, 'session.updated.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created) VALUES ('input', 'session', '{}', 'steer', 9, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('projected', 'session', 'user', 9, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('session', 'baseline', '{}', 9)`,
        )
        yield* db.run(sql`DELETE FROM migration WHERE id = ${simplifySessionInputMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [simplifySessionInputMigration])

        const database = Layer.succeed(Database.Service, { db })
        yield* EventV2.Service.use((service) =>
          service.publish(SessionV1.Event.Updated, {
            sessionID: SessionSchema.ID.make("session"),
            info: {
              id: SessionSchema.ID.make("session"),
              slug: "session",
              projectID: ProjectV2.ID.global,
              directory: "/project",
              title: "After",
              version: "test",
              time: { created: 1, updated: 2 },
            },
          }),
        ).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([EventV2.node, SessionProjector.node]), [[Database.node, database]]),
          ),
        )

        expect(
          yield* db.get(sql`
            SELECT
              (SELECT title FROM session WHERE id = 'session') AS title,
              (SELECT workspace_id FROM session WHERE id = 'session') AS workspaceID,
              (SELECT COUNT(*) FROM message WHERE id = 'message') AS messages,
              (SELECT COUNT(*) FROM part WHERE id = 'part') AS parts,
              (SELECT COUNT(*) FROM workspace) AS workspaces,
              (SELECT COUNT(*) FROM session_input) AS sessionInputs,
              (SELECT COUNT(*) FROM session_message) AS sessionMessages,
              (SELECT COUNT(*) FROM session_context_epoch) AS contextEpochs,
              (SELECT seq FROM event_sequence WHERE aggregate_id = 'session') AS seq,
              (SELECT type FROM event WHERE aggregate_id = 'session') AS eventType
          `),
        ).toEqual({
          title: "After",
          workspaceID: null,
          messages: 1,
          parts: 1,
          workspaces: 0,
          sessionInputs: 0,
          sessionMessages: 0,
          contextEpochs: 0,
          seq: 0,
          eventType: "session.updated.1",
        })
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectV2.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })
})
