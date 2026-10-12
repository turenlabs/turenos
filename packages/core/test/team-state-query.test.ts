import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { DatabaseMigration } from "@turenlabs/core/database/migration"
import teamHistoryIndexes from "@turenlabs/core/database/migration/20261012142833_team-history-indexes"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node, TeamWorkspace.node])))

describe("Team state query plans", () => {
  it.effect("uses room/time indexes for recent and active tasks and factory runs", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const database = yield* Database.Service
      const room = yield* team.createRoom({ name: "query-plans" })
      const state = yield* team.state({ roomID: room.id })
      expect(state.tasks).toEqual([])
      expect(state.factoryRuns).toEqual([])

      const db = Database.primary(database.db)
      const recentTaskPlan = yield* db.all<{ detail: string }>(sql`
        EXPLAIN QUERY PLAN
        SELECT id, room_id, message_id, teammate_id, session_id, status, error, factory_run_id, time_created, time_updated
        FROM team_task WHERE room_id = ${room.id} ORDER BY time_created DESC LIMIT 100
      `)
      const activeTaskPlan = yield* db.all<{ detail: string }>(sql`
        EXPLAIN QUERY PLAN
        SELECT id, room_id, message_id, teammate_id, session_id, status, error, factory_run_id, time_created, time_updated
        FROM team_task WHERE room_id = ${room.id} AND status IN ('claimed', 'running')
        ORDER BY time_created ASC LIMIT 100
      `)
      const factoryRunPlan = yield* db.all<{ detail: string }>(sql`
        EXPLAIN QUERY PLAN
        SELECT id, room_id, status, phase, task_ids, result, error, time_created, time_updated
        FROM team_factory_run WHERE room_id = ${room.id} ORDER BY time_created DESC LIMIT 20
      `)
      expect(recentTaskPlan.map((row) => row.detail).join(" ")).toContain("team_task_room_time_idx")
      expect(activeTaskPlan.map((row) => row.detail).join(" ")).toContain("team_task_active_room_time_idx")
      expect(factoryRunPlan.map((row) => row.detail).join(" ")).toContain("team_factory_run_room_time_idx")
      const activeRoomsPlan = yield* db.all<{ detail: string }>(sql`
        EXPLAIN QUERY PLAN
        SELECT DISTINCT room_id FROM team_task WHERE status IN ('queued', 'claimed', 'running')
      `)
      expect(activeRoomsPlan.map((row) => row.detail).join(" ")).toContain("team_task_status_lease_idx")
      expect(recentTaskPlan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE")
      expect(activeTaskPlan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE")
      expect(factoryRunPlan.map((row) => row.detail).join(" ")).not.toContain("TEMP B-TREE")
    }),
  )

  it.effect("upgrades existing room history and does not decode unused task or factory snapshots", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const database = yield* Database.Service
      const room = yield* team.createRoom({ name: "existing-history" })
      const teammate = yield* team.createTeammate({
        roomID: room.id,
        name: "Lead",
        handle: "lead",
        role: "Lead",
        mission: "Check",
      })
      const db = Database.primary(database.db)
      yield* db.run(sql`INSERT INTO team_message (id, room_id, seq, kind, author, text, time_created)
        VALUES ('history-message', ${room.id}, 1, 'human', 'Tom', 'Preserved history', 1)`)
      yield* db.run(sql`INSERT INTO team_task (id, room_id, message_id, teammate_id, session_id, status, snapshot, time_created, time_updated)
        VALUES ('history-task', ${room.id}, 'history-message', ${teammate.id}, 'history-session', 'running', 'unused-invalid-json', 1, 2)`)
      yield* db.run(sql`INSERT INTO team_factory_run (id, room_id, request, status, phase, config, profiles, task_ids, time_created, time_updated)
        VALUES ('history-run', ${room.id}, 'Unused request', 'running', 'work', 'unused-invalid-json', 'unused-invalid-json', '["history-task"]', 1, 2)`)
      yield* db.run(sql`DROP INDEX team_task_room_time_idx`)
      yield* db.run(sql`DROP INDEX team_task_active_room_time_idx`)
      yield* db.run(sql`DROP INDEX team_factory_run_room_time_idx`)
      yield* db.run(sql`DELETE FROM migration WHERE id = ${teamHistoryIndexes.id}`)
      yield* DatabaseMigration.applyOnly(db, [teamHistoryIndexes])
      yield* DatabaseMigration.applyOnly(db, [teamHistoryIndexes])
      const upgraded = yield* team.state({ roomID: room.id })
      expect(upgraded.messages.map((message) => message.text)).toEqual(["Preserved history"])
      expect(upgraded.tasks.map((task) => [task.id, task.status])).toEqual([["history-task", "running"]])
      expect(upgraded.factoryRuns?.map((run) => [run.id, run.taskIDs])).toEqual([["history-run", ["history-task"]]])
      expect(
        yield* db.all(
          sql`SELECT name FROM sqlite_master WHERE name IN ('team_task_room_time_idx', 'team_task_active_room_time_idx', 'team_factory_run_room_time_idx') ORDER BY name`,
        ),
      ).toEqual([
        { name: "team_factory_run_room_time_idx" },
        { name: "team_task_active_room_time_idx" },
        { name: "team_task_room_time_idx" },
      ])
    }),
  )
})
