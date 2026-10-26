import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { candidates, fixture, publish } from "../script/team-output-workload"

describe("Team output recovery identities", () => {
  test("bounds pages and avoids published historical bodies on the second idle pass", () => {
    const db = fixture()
    try {
      db.query("insert into team_task values ('old', 'ses', 'succeeded', null)").run()
      const insert = db.query("insert into session_message values (?, 'ses', ?, ?, ?)")
      insert.run("msg_team_old", "user", 0, "{}")
      for (let i = 1; i <= 205; i++) {
        insert.run(
          `msg_${i}`,
          "assistant",
          i,
          JSON.stringify({ time: { completed: 1 }, finish: "stop", content: "x".repeat(65536) }),
        )
      }
      const first = candidates(db, "ses")
      expect(first).toHaveLength(100)
      expect(Object.keys(first[0]).sort()).toEqual(["id", "seq", "taskID"])
      const second = candidates(db, "ses", first.at(-1)!.seq)
      expect(second).toHaveLength(100)
      const third = candidates(db, "ses", second.at(-1)!.seq)
      expect(third).toHaveLength(5)
      for (const row of [...first, ...second, ...third]) publish(db, "ses", row.id)
      expect(candidates(db, "ses")).toEqual([])
      // Reopen the durable state without a process-local cursor.
      const reopened = Database.deserialize(db.serialize())
      try {
        expect(candidates(reopened, "ses")).toEqual([])
      } finally {
        reopened.close()
      }
      insert.run("msg_late", "assistant", 206, JSON.stringify({ time: { completed: 1 }, finish: "stop" }))
      expect(candidates(db, "ses")).toEqual([{ id: "msg_late", seq: 206, taskID: "old" }])
      publish(db, "ses", "msg_late")
      publish(db, "ses", "msg_late")
      expect(candidates(db, "ses")).toEqual([])
      expect(candidates(db, "other")).toEqual([])
    } finally {
      db.close()
    }
  })

  test("uses durable task boundaries, not task status or arbitrary follow-up prompt names", () => {
    const db = fixture()
    try {
      db.exec(
        `insert into team_task values ('old', 'ses', 'succeeded', null), ('new', 'ses', 'running', 1000), ('foreign', 'other', 'succeeded', null)`,
      )
      const insert = db.query("insert into session_message values (?, 'ses', ?, ?, ?)")
      const completed = JSON.stringify({ time: { completed: 1 }, finish: "stop" })
      insert.run("msg_team_old", "user", 0, "{}")
      insert.run("msg_old", "assistant", 1, completed)
      insert.run("msg_team_not_a_task", "user", 2, "{}")
      insert.run("msg_followup", "assistant", 3, completed)
      insert.run("msg_team_new", "user", 4, "{}")
      insert.run("msg_active", "assistant", 5, completed)
      insert.run("msg_team_foreign", "user", 6, "{}")
      insert.run("msg_after_foreign", "assistant", 7, completed)
      expect(candidates(db, "ses", undefined, 100, 500).map((row) => row.taskID)).toEqual(["old", "old", null, null])
      expect(candidates(db, "ses", undefined, 100, 1000).map((row) => row.taskID)).toEqual(["old", "old", "new", "new"])
      db.exec("update team_task set status = 'cancelled' where id = 'new'")
      expect(candidates(db, "ses").at(-1)!.taskID).toBeNull()
      db.exec("update team_task set status = 'stale' where id = 'new'")
      expect(candidates(db, "ses").at(-1)!.taskID).toBe("new")
    } finally {
      db.close()
    }
  })

  test("excludes task-result sources, errors and unfinished replies without losing late completion", () => {
    const db = fixture()
    try {
      db.exec("insert into team_task values ('task', 'ses', 'failed', null)")
      const insert = db.query("insert into session_message values (?, 'ses', ?, ?, ?)")
      insert.run("msg_team_task", "user", 0, "{}")
      insert.run("msg_final", "assistant", 1, JSON.stringify({ time: { completed: 1 }, finish: "stop" }))
      insert.run(
        "msg_error",
        "assistant",
        2,
        JSON.stringify({ time: { completed: 1 }, finish: "stop", error: { message: "error" } }),
      )
      insert.run("msg_pending", "assistant", 3, JSON.stringify({ time: {}, finish: "stop" }))
      insert.run("msg_tool", "assistant", 4, JSON.stringify({ time: { completed: 1 }, finish: "tool-calls" }))
      db.query("insert into team_message values ('ses', 'task:task', ?)").run(JSON.stringify(["msg_final"]))
      expect(candidates(db, "ses")).toEqual([])
      db.query("update session_message set data = ? where id = 'msg_pending'").run(
        JSON.stringify({ time: { completed: 2 }, finish: "stop" }),
      )
      expect(candidates(db, "ses")).toEqual([{ id: "msg_pending", seq: 3, taskID: "task" }])
    } finally {
      db.close()
    }
  })
})
