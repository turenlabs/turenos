import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Team } from "@turenlabs/schema/team"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamAttachmentTable } from "@turenlabs/core/team/workspace.sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node, TeamWorkspace.node])))

const attachment = (name: string, mime: string, bytes: Uint8Array | string): Team.Attachment => ({
  name,
  mime,
  uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
})
const notes = attachment("notes.txt", "text/plain", "alpha notes")
const pixel = attachment("pixel.png", "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]))
const archive = attachment("bundle.zip", "application/zip", new Uint8Array([80, 75, 3, 4, 0, 255, 254]))

function roomWithMate(name: string) {
  return Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const room = yield* team.createRoom({ name })
    const mate = yield* team.createTeammate({
      roomID: room.id,
      name: "Moss",
      handle: "moss",
      role: "Analyst",
      mission: "Review",
    })
    return { team, room, mate }
  })
}

describe("Team message attachments", () => {
  it.effect("persists ordered attachments with the message and returns them on reload", () =>
    Effect.gen(function* () {
      const { team, room } = yield* roomWithMate("attach-persist")
      const posted = yield* team.postMessage({
        id: "msg_attach_persist",
        roomID: room.id,
        text: "Review these",
        attachments: [notes, pixel, archive],
      })
      expect(posted.message.attachments).toEqual([notes, pixel, archive])
      expect(posted.tasks).toHaveLength(1)

      const reloaded = yield* team.state({ roomID: room.id, attachments: true })
      expect(reloaded.messages.find((message) => message.id === "msg_attach_persist")?.attachments).toEqual([
        notes,
        pixel,
        archive,
      ])
      expect(yield* team.messageAttachments({ roomID: room.id, messageID: "msg_attach_persist" })).toEqual([
        notes,
        pixel,
        archive,
      ])
      expect(
        yield* team.messageAttachments({ roomID: "trm_missing", messageID: "msg_attach_persist" }).pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.NotFoundError)
      expect(
        yield* team.messageAttachments({ roomID: room.id, messageID: "msg_missing" }).pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.NotFoundError)
      // Model-facing reads never carry attachment bytes.
      const summary = yield* team.state({ roomID: room.id })
      expect(summary.messages.find((message) => message.id === "msg_attach_persist")).not.toHaveProperty("attachments")
      expect(summary.messages.find((message) => message.id === "msg_attach_persist")?.attachmentInfo).toEqual([
        { name: notes.name, mime: notes.mime, size: 11 },
        { name: pixel.name, mime: pixel.mime, size: 12 },
        { name: archive.name, mime: archive.mime, size: 7 },
      ])

      const plain = yield* team.postMessage({ id: "msg_attach_plain", roomID: room.id, text: "No files" })
      expect(plain.message).not.toHaveProperty("attachments")
      const after = yield* team.state({ roomID: room.id, attachments: true })
      expect(after.messages.find((message) => message.id === "msg_attach_plain")).not.toHaveProperty("attachments")
    }),
  )

  it.effect("accepts attachment-only sends and gives the task the exact uploaded files", () =>
    Effect.gen(function* () {
      const { team, room } = yield* roomWithMate("attach-only")
      const posted = yield* team.postMessage({
        id: "msg_attach_only",
        roomID: room.id,
        text: "",
        attachments: [pixel, notes],
      })
      expect(posted.message.text).toBe("")
      expect(posted.message.attachments).toEqual([pixel, notes])
      expect(posted.tasks).toHaveLength(1)
      const task = yield* team.getTask(posted.tasks[0]!.id)
      expect(task.execution.prompt).toContain("pixel.png")
      expect(task.execution.prompt).toContain("notes.txt")
      expect(task.execution.prompt).not.toContain(pixel.uri)
      expect(yield* team.taskAttachments(task.id)).toEqual([pixel, notes])

      expect(
        yield* team.postMessage({ id: "msg_attach_empty", roomID: room.id, text: "  " }).pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.InvalidRequestError)
      expect(
        yield* team
          .postMessage({ id: "msg_attach_empty", roomID: room.id, text: "", attachments: [] })
          .pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.InvalidRequestError)

      const followup = yield* team.postMessage({ id: "msg_attach_followup", roomID: room.id, text: "And then?" })
      const context = (yield* team.getTask(followup.tasks[0]!.id)).execution.prompt
      expect(context).toContain("pixel.png")
      expect(context).not.toContain(pixel.uri)
      expect(yield* team.taskAttachments(followup.tasks[0]!.id)).toEqual([])
    }),
  )

  it.effect("returns the original message for exact retries and rejects any attachment change", () =>
    Effect.gen(function* () {
      const { team, room } = yield* roomWithMate("attach-retry")
      const input = { id: "msg_attach_retry", roomID: room.id, text: "Check", attachments: [notes, pixel] }
      const first = yield* team.postMessage(input)
      const retry = yield* team.postMessage(input)
      expect(retry.message).toEqual(first.message)
      expect(retry.message.attachments).toEqual([notes, pixel])
      expect(retry.tasks.map((task) => task.id)).toEqual(first.tasks.map((task) => task.id))
      const database = yield* Database.Service
      expect(
        yield* Database.primary(database.db)
          .select()
          .from(TeamAttachmentTable)
          .where(eq(TeamAttachmentTable.message_id, input.id))
          .all(),
      ).toHaveLength(2)

      const changed = [
        [attachment("notes.txt", "text/plain", "alpha notez"), pixel],
        [{ ...notes, name: "renamed.txt" }, pixel],
        [attachment("notes.txt", "text/markdown", "alpha notes"), pixel],
        [pixel, notes],
        [notes],
        [notes, pixel, archive],
        [],
      ]
      for (const attachments of changed)
        expect(yield* team.postMessage({ ...input, attachments }).pipe(Effect.flip)).toBeInstanceOf(
          TeamWorkspace.ConflictError,
        )
      expect(
        yield* team.postMessage({ id: input.id, roomID: room.id, text: input.text }).pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.ConflictError)

      const plain = { id: "msg_attach_retry_plain", roomID: room.id, text: "Plain" }
      yield* team.postMessage(plain)
      expect((yield* team.postMessage({ ...plain, attachments: [] })).message.id).toBe(plain.id)
      expect(yield* team.postMessage({ ...plain, attachments: [notes] }).pipe(Effect.flip)).toBeInstanceOf(
        TeamWorkspace.ConflictError,
      )
      expect(
        (yield* team.state({ roomID: room.id, attachments: true })).messages.find((message) => message.id === input.id)
          ?.attachments,
      ).toEqual([notes, pixel])
    }),
  )

  it.effect("enforces count, per-file, and aggregate size limits on the server", () =>
    Effect.gen(function* () {
      const { team, room } = yield* roomWithMate("attach-limits")
      const sized = (name: string, size: number) => attachment(name, "application/octet-stream", new Uint8Array(size))
      const rejected = (id: string, attachments: ReadonlyArray<Team.Attachment>) =>
        team.postMessage({ id, roomID: room.id, text: "Limits", attachments }).pipe(Effect.flip)

      expect(
        yield* rejected(
          "msg_limit_count",
          Array.from({ length: Team.MAX_ATTACHMENTS + 1 }, (_, index) => sized(`f${index}.bin`, 1)),
        ),
      ).toBeInstanceOf(TeamWorkspace.InvalidRequestError)
      expect(yield* rejected("msg_limit_single", [sized("big.bin", Team.MAX_ATTACHMENT_BYTES + 1)])).toBeInstanceOf(
        TeamWorkspace.InvalidRequestError,
      )
      const seven = 7 * 1024 * 1024
      expect(
        yield* rejected("msg_limit_total", [sized("a.bin", seven), sized("b.bin", seven), sized("c.bin", seven)]),
      ).toBeInstanceOf(TeamWorkspace.InvalidRequestError)

      const atLimit = [
        sized("a.bin", Team.MAX_ATTACHMENT_BYTES),
        sized("b.bin", Team.MAX_ATTACHMENT_TOTAL_BYTES - Team.MAX_ATTACHMENT_BYTES),
      ]
      const posted = yield* team.postMessage({
        id: "msg_limit_ok",
        roomID: room.id,
        text: "Limits",
        attachments: atLimit,
      })
      expect(posted.message.attachments).toEqual(atLimit)
      const most = Array.from({ length: Team.MAX_ATTACHMENTS }, (_, index) => sized(`f${index}.bin`, 1))
      expect(most).toHaveLength(5)
      expect(
        (yield* team.postMessage({ id: "msg_limit_most", roomID: room.id, text: "Limits", attachments: most })).message
          .attachments,
      ).toEqual(most)
      const state = yield* team.state({ roomID: room.id, attachments: true })
      expect(state.messages.map((message) => message.id)).not.toContain("msg_limit_count")
      expect(state.messages.map((message) => message.id)).not.toContain("msg_limit_single")
      expect(state.messages.map((message) => message.id)).not.toContain("msg_limit_total")
    }),
  )

  it.effect("accepts only canonical base64 data URIs with a matching mime and a safe name", () =>
    Effect.gen(function* () {
      const { team, room } = yield* roomWithMate("attach-uris")
      const payload = Buffer.from("hello").toString("base64")
      const invalid: ReadonlyArray<Team.Attachment> = [
        { ...notes, uri: "https://example.com/notes.txt" },
        { ...notes, uri: "file:///etc/passwd" },
        { ...notes, uri: "/etc/passwd" },
        { ...notes, uri: "data:text/plain,hello" },
        { ...notes, uri: "data:text/plain;charset=utf-8;base64,aGVsbG8=" },
        { ...notes, uri: "data:TEXT/PLAIN;base64,aGVsbG8=" },
        { ...notes, uri: "DATA:text/plain;base64,aGVsbG8=" },
        { ...notes, uri: "data:text/plain;base64,aGVsbG8" },
        { ...notes, uri: "data:text/plain;base64,aGVsbG9=" },
        { ...notes, uri: "data:text/plain;base64,aGVs bG8=" },
        { ...notes, uri: "data:text/plain;base64,aGVsbG8=\n" },
        { ...notes, uri: "data:text/plain;base64,aGVsbG-_" },
        { ...notes, uri: `data:image/png;base64,${payload}` },
        { ...notes, mime: "text" },
        { ...notes, name: "../notes.txt" },
        { ...notes, name: "dir\\notes.txt" },
        { ...notes, name: ".." },
        { ...notes, name: "notes\u0000.txt" },
        { ...notes, name: "   " },
      ]
      for (const [index, item] of invalid.entries())
        expect(
          yield* team
            .postMessage({ id: `msg_uri_invalid_${index}`, roomID: room.id, text: "Bad", attachments: [item] })
            .pipe(Effect.flip),
        ).toBeInstanceOf(TeamWorkspace.InvalidRequestError)
      const database = yield* Database.Service
      expect(
        yield* Database.primary(database.db)
          .select()
          .from(TeamAttachmentTable)
          .where(eq(TeamAttachmentTable.room_id, room.id))
          .all(),
      ).toEqual([])

      const empty = attachment("empty.txt", "text/plain", "")
      const posted = yield* team.postMessage({
        id: "msg_uri_valid",
        roomID: room.id,
        text: "Good",
        attachments: [empty, notes],
      })
      expect(posted.message.attachments).toEqual([empty, notes])
    }),
  )

  it.effect("keeps attachments owned by their room", () =>
    Effect.gen(function* () {
      const { team, room } = yield* roomWithMate("attach-owner-a")
      const other = yield* team.createRoom({ name: "attach-owner-b" })
      yield* team.createTeammate({
        roomID: other.id,
        name: "Reed",
        handle: "reed",
        role: "Analyst",
        mission: "Review",
      })
      const input = { id: "msg_attach_owner", roomID: room.id, text: "Private", attachments: [notes] }
      const posted = yield* team.postMessage(input)
      expect(yield* team.postMessage({ ...input, roomID: other.id }).pipe(Effect.flip)).toBeInstanceOf(
        TeamWorkspace.ConflictError,
      )
      expect(
        yield* team
          .postMessage({ id: "msg_attach_missing_room", roomID: "trm_missing", text: "x", attachments: [notes] })
          .pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.NotFoundError)

      const elsewhere = yield* team.postMessage({ id: "msg_attach_other", roomID: other.id, text: "Other room" })
      const otherState = yield* team.state({ roomID: other.id, attachments: true })
      expect(otherState.messages.some((message) => message.attachments !== undefined)).toBe(false)

      // A row that claims another room's message is never served through that message or its tasks.
      const database = yield* Database.Service
      const db = Database.primary(database.db)
      yield* db
        .update(TeamAttachmentTable)
        .set({ room_id: other.id })
        .where(eq(TeamAttachmentTable.message_id, input.id))
        .run()
      expect(
        (yield* team.state({ roomID: room.id, attachments: true })).messages.find((message) => message.id === input.id),
      ).not.toHaveProperty("attachments")
      expect(yield* team.messageAttachments({ roomID: room.id, messageID: input.id })).toEqual([])
      expect(
        (yield* team.state({ roomID: room.id })).messages.find((message) => message.id === input.id),
      ).not.toHaveProperty("attachmentInfo")
      expect(yield* team.taskAttachments(posted.tasks[0]!.id)).toEqual([])
      expect(yield* team.taskAttachments(elsewhere.tasks[0]!.id)).toEqual([])
      expect(yield* team.taskAttachments("job_missing").pipe(Effect.flip)).toBeInstanceOf(TeamWorkspace.NotFoundError)
    }),
  )

  it.effect("rejects new attachment writes to archived rooms and preserves exact retries", () =>
    Effect.gen(function* () {
      const { team, room, mate } = yield* roomWithMate("attach-archive")
      yield* team.editTeammate({ id: mate.id, status: "paused" })
      const input = { id: "msg_attach_archived", roomID: room.id, text: "Before archive", attachments: [notes, pixel] }
      const first = yield* team.postMessage(input)
      yield* team.archiveRoom(room.id)

      const retry = yield* team.postMessage(input)
      expect(retry.message).toEqual(first.message)
      expect(retry.message.attachments).toEqual([notes, pixel])
      expect(yield* team.postMessage({ ...input, attachments: [pixel, notes] }).pipe(Effect.flip)).toBeInstanceOf(
        TeamWorkspace.ConflictError,
      )
      const blocked = yield* team
        .postMessage({ id: "msg_attach_after_archive", roomID: room.id, text: "", attachments: [notes] })
        .pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(TeamWorkspace.ConflictError)
      expect(blocked).toMatchObject({ message: "Archived rooms are read-only" })

      const database = yield* Database.Service
      const db = Database.primary(database.db)
      expect(
        yield* db.select().from(TeamAttachmentTable).where(eq(TeamAttachmentTable.room_id, room.id)).all(),
      ).toHaveLength(2)
      expect(
        (yield* team.state({ roomID: room.id, attachments: true })).messages.find((message) => message.id === input.id)
          ?.attachments,
      ).toEqual([notes, pixel])

      yield* team.deleteRoom(room.id)
      expect(
        yield* db.select().from(TeamAttachmentTable).where(eq(TeamAttachmentTable.room_id, room.id)).all(),
      ).toEqual([])
    }),
  )
})
