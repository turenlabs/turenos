import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Fiber, Schema } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { ModelV2 } from "@turenlabs/core/model"
import { Project } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { Retention } from "@turenlabs/core/retention"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionMessageTable, SessionTable } from "@turenlabs/core/session/sql"
import { ToolExecutionTable } from "@turenlabs/core/tool/execution.sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

// `Retention.settings` reads the *global* config file, so the suite points `FORGE_CONFIG_DIR` at a
// scratch directory before any layer is built. Without this the tests would read -- and their
// assertions would depend on -- whatever policy the developer running them happens to have.
const previousConfigDir = process.env["FORGE_CONFIG_DIR"]
let configDir: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  configDir = await tmpdir()
  process.env["FORGE_CONFIG_DIR"] = configDir.path
})

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env["FORGE_CONFIG_DIR"]
  else process.env["FORGE_CONFIG_DIR"] = previousConfigDir
  await configDir?.[Symbol.asyncDispose]()
})

// The layer is only *described* here; `Global` reads `FORGE_CONFIG_DIR` when it is constructed,
// which happens inside each test body and therefore after the `beforeAll` above has run.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Retention.node])))

const DAY = 24 * 60 * 60 * 1000
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

/** A payload well past the 2 KB preview budget, with a distinct first and last line. */
const bigOutput = [
  "FIRST LINE OF OUTPUT",
  ...Array.from({ length: 400 }, (_, i) => `filler line ${i}`),
  "LAST LINE",
].join("\n")

const completedTool = (
  id: string,
  output: string,
  extra?: { readonly input?: Record<string, unknown>; readonly outputPaths?: readonly string[] },
): SessionMessage.AssistantTool => ({
  type: "tool",
  id,
  name: "bash",
  state: {
    status: "completed",
    input: extra?.input ?? { command: "ls" },
    content: [{ type: "text", text: output }],
    structured: {},
    ...(extra?.outputPaths === undefined ? {} : { outputPaths: extra.outputPaths }),
  },
  time: { created },
})

const seed = Effect.fn("seed")(function* (input: {
  readonly sessionID: string
  readonly archivedAt?: number
  readonly messages: readonly { readonly message: SessionMessage.Message; readonly createdAt: number }[]
}) {
  const { db } = yield* Database.Service
  const sessionID = SessionV2.ID.make(input.sessionID)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: input.sessionID,
      directory: "/project",
      title: "retention fixture",
      version: "test",
      time_archived: input.archivedAt ?? null,
    })
    .run()
  yield* db
    .insert(SessionMessageTable)
    .values(
      input.messages.map((entry, index) => {
        const { id, type, ...data } = encodeMessage(entry.message)
        return {
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: index,
          time_created: entry.createdAt,
          time_updated: entry.createdAt,
          data,
        }
      }),
    )
    .run()
  return sessionID
})

const readMessage = Effect.fn("readMessage")(function* (id: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, SessionMessage.ID.make(id)))
    .get()
  return row!
})

/** Concatenated text of every tool payload in a stored assistant message. */
const toolText = (data: unknown) =>
  ((data as { content: { type: string; state?: { content?: { type: string; text?: string }[] } }[] }).content ?? [])
    .filter((item) => item.type === "tool")
    .flatMap((item) => item.state?.content ?? [])
    .map((item) => item.text ?? "")
    .join("\n")

const assistantText = (data: unknown) =>
  ((data as { content: { type: string; text?: string }[] }).content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")

async function withFileBackedRetention(
  body: (
    blocker: import("bun:sqlite").Database,
    filename: string,
  ) => Effect.Effect<void, unknown, Database.Service | Retention.Service>,
) {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "retention.sqlite")
  const app = AppNodeBuilder.build(LayerNode.group([Database.node, Retention.node]), [
    [Database.node, Database.layerFromPath(filename)],
  ])
  const sqlite = await import("bun:sqlite")
  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => new sqlite.Database(filename)),
      (blocker) => body(blocker, filename),
      (blocker) => Effect.sync(() => blocker.close()),
    ).pipe(Effect.provide(app), Effect.scoped),
  )
}

async function startBlockingUpdate(filename: string, statement: string, parameters: readonly string[]) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      'const sqlite=await import("bun:sqlite");const db=new sqlite.Database(process.argv[1]);db.run("PRAGMA busy_timeout = 5000");db.run("BEGIN IMMEDIATE");console.log("ready");await Bun.sleep(500);db.run(process.argv[2],JSON.parse(process.argv[3]));db.run("COMMIT");db.close()',
      filename,
      statement,
      JSON.stringify(parameters),
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()
  if (!ready.value || !new TextDecoder().decode(ready.value).includes("ready")) {
    throw new Error(`blocking updater failed to start: ${await new Response(child.stderr).text()}`)
  }
  return child
}

describe("Retention policy resolution", () => {
  it.effect("applies documented defaults when nothing is configured", () =>
    Effect.gen(function* () {
      expect(Retention.resolve(undefined)).toEqual({ archivedSessionDays: 30, toolOutputDays: 14 })
    }),
  )

  it.effect("clamps an absurd window instead of rejecting the document", () =>
    Effect.gen(function* () {
      expect(Retention.resolve({ archivedSessionDays: 999_999, toolOutputDays: -5 })).toEqual({
        archivedSessionDays: 3650,
        toolOutputDays: 0,
      })
    }),
  )

  it.effect("treats 0 as never rather than as a cutoff of now", () =>
    Effect.gen(function* () {
      const now = Date.now()
      expect(Retention.cutoff(0, now)).toBeUndefined()
      expect(Retention.cutoff(14, now)).toBe(now - 14 * DAY)
    }),
  )

  it.effect("reads the policy from the global config file", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(configDir.path, "forge.json"),
          JSON.stringify({ retention: { archivedSessionDays: 7, toolOutputDays: 3 } }),
        ),
      )
      const retention = yield* Retention.Service
      expect(yield* retention.settings()).toEqual({ archivedSessionDays: 7, toolOutputDays: 3 })
      yield* Effect.promise(() => fs.rm(path.join(configDir.path, "forge.json")))
    }),
  )
})

describe("Retention selection", () => {
  it.effect("leaves a tool payload inside the tool-output window untouched", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_fresh_tool",
        messages: [
          {
            createdAt: now - 5 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_fresh_tool"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_fresh", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      const report = yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 })
      expect(report.messages).toBe(0)
      expect(toolText((yield* readMessage("msg_fresh_tool")).data)).toBe(bigOutput)
    }),
  )

  it.effect("reduces a tool payload once past the tool-output window", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_stale_tool",
        messages: [
          {
            createdAt: now - 20 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_stale_tool"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_stale", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      const report = yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 })
      expect(report.messages).toBe(1)
      expect(report.bytes).toBeGreaterThan(0)
      expect(toolText((yield* readMessage("msg_stale_tool")).data)).toContain(Retention.TOOL_MARKER)
    }),
  )

  it.effect("reduces every payload in an archived session past its window, at any message age", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_archived",
        archivedAt: now - 40 * DAY,
        messages: [
          {
            // One minute old: far inside the tool-output window, which is disabled here anyway.
            createdAt: now - 60_000,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_archived_tool"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_archived", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      const report = yield* retention.sweep({ toolOutputDays: 0, archivedSessionDays: 30 })
      expect(report.messages).toBe(1)
      expect(toolText((yield* readMessage("msg_archived_tool")).data)).toContain(Retention.TOOL_MARKER)
    }),
  )

  it.effect("leaves an archived session that is still inside its window alone", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_recently_archived",
        archivedAt: now - 5 * DAY,
        messages: [
          {
            createdAt: now - 5 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_recently_archived"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_recent_archive", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      const report = yield* retention.sweep({ toolOutputDays: 0, archivedSessionDays: 30 })
      expect(report.messages).toBe(0)
      expect(toolText((yield* readMessage("msg_recently_archived")).data)).toBe(bigOutput)
    }),
  )

  it.effect("never touches a live session when only the archive window is enabled", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_live_old",
        messages: [
          {
            createdAt: now - 400 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_live_old"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_live_old", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      expect((yield* retention.sweep({ toolOutputDays: 0, archivedSessionDays: 30 })).messages).toBe(0)
      expect(toolText((yield* readMessage("msg_live_old")).data)).toBe(bigOutput)
    }),
  )

  it.effect("0 disables both windows, even for a decade-old archived session", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_disabled",
        archivedAt: now - 3650 * DAY,
        messages: [
          {
            createdAt: now - 3650 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_disabled"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_disabled", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      expect(yield* retention.sweep({ toolOutputDays: 0, archivedSessionDays: 0 })).toEqual({
        messages: 0,
        executions: 0,
        bytes: 0,
      })
      expect(toolText((yield* readMessage("msg_disabled")).data)).toBe(bigOutput)
    }),
  )

  it.effect("reduces shell output only for an archived session", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const shell = (id: string) =>
        SessionMessage.Shell.make({
          id: SessionMessage.ID.make(id),
          type: "shell",
          callID: id,
          command: "yarn build",
          output: bigOutput,
          time: { created },
        })
      yield* seed({
        sessionID: "ses_shell_live",
        messages: [{ createdAt: now - 400 * DAY, message: shell("msg_shell_live") }],
      })
      yield* seed({
        sessionID: "ses_shell_archived",
        archivedAt: now - 40 * DAY,
        messages: [{ createdAt: now - 400 * DAY, message: shell("msg_shell_archived") }],
      })
      const retention = yield* Retention.Service
      yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 30 })

      const live = (yield* readMessage("msg_shell_live")).data as unknown as { output: string }
      const archived = (yield* readMessage("msg_shell_archived")).data as unknown as {
        output: string
        truncated?: boolean
      }
      expect(live.output).toBe(bigOutput)
      expect(archived.output).toContain(Retention.SHELL_MARKER)
      expect(archived.truncated).toBe(true)
      // The command itself is identity, not payload, and must survive.
      expect((yield* readMessage("msg_shell_archived")).data).toMatchObject({ command: "yarn build" })
    }),
  )

  it.effect("does not bump time_updated, so a swept session still reads as idle", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const createdAt = now - 90 * DAY
      yield* seed({
        sessionID: "ses_timestamps",
        messages: [
          {
            createdAt,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_timestamps"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_timestamps", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 })
      const row = yield* readMessage("msg_timestamps")
      expect(row.time_updated).toBe(createdAt)
      expect(row.time_created).toBe(createdAt)
    }),
  )

  it.effect("is idempotent: a second sweep rewrites nothing", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_idempotent",
        messages: [
          {
            createdAt: now - 90 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_idempotent"),
              type: "assistant",
              agent: "build",
              model,
              content: [completedTool("call_idempotent", bigOutput)],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      expect((yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 30 })).messages).toBe(1)
      const first = (yield* readMessage("msg_idempotent")).data
      const second = yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 30 })
      expect(second).toEqual({ messages: 0, executions: 0, bytes: 0 })
      expect((yield* readMessage("msg_idempotent")).data).toEqual(first)
    }),
  )

  test("does not overwrite a projection changed after the retention read", async () => {
    await withFileBackedRetention((blocker, filename) =>
      Effect.gen(function* () {
        const createdAt = Date.now() - 90 * DAY
        yield* seed({
          sessionID: "ses_retention_race",
          messages: [
            {
              createdAt,
              message: SessionMessage.Assistant.make({
                id: SessionMessage.ID.make("msg_retention_race"),
                type: "assistant",
                agent: "build",
                model,
                content: [completedTool("call_retention_race", bigOutput)],
                time: { created },
              }),
            },
          ],
        })
        const stored = blocker.query("SELECT data FROM session_message WHERE id = ?").get("msg_retention_race") as {
          data: string
        }
        const newer = JSON.stringify({ ...JSON.parse(stored.data), projectorNewer: true })
        const updater = yield* Effect.promise(() =>
          startBlockingUpdate(filename, "UPDATE session_message SET data = ? WHERE id = ?", [
            newer,
            "msg_retention_race",
          ]),
        )
        const retention = yield* Retention.Service
        const sweeping = yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 }).pipe(Effect.forkChild)

        expect(yield* Fiber.join(sweeping)).toEqual({ messages: 0, executions: 0, bytes: 0 })
        expect(yield* Effect.promise(() => updater.exited)).toBe(0)
        expect(
          JSON.parse(
            (
              blocker.query("SELECT data FROM session_message WHERE id = ?").get("msg_retention_race") as {
                data: string
              }
            ).data,
          ),
        ).toMatchObject({ projectorNewer: true })
      }),
    )
  })
})

describe("Retention tool_execution selection", () => {
  const settlement = (text: string) => ({ output: { structured: {}, content: [{ type: "text" as const, text }] } })

  const seedExecution = Effect.fn("seedExecution")(function* (input: {
    readonly callID: string
    readonly status: "running" | "completed" | "indeterminate"
    readonly updatedAt: number
    readonly sessionID?: string
  }) {
    const { db } = yield* Database.Service
    yield* db
      .insert(ToolExecutionTable)
      .values({
        session_id: SessionV2.ID.make(input.sessionID ?? "ses_exec"),
        assistant_message_id: SessionMessage.ID.make("msg_exec"),
        call_id: input.callID,
        request_hash: "hash",
        status: input.status,
        settlement: settlement(bigOutput),
        time_created: input.updatedAt,
        time_updated: input.updatedAt,
      })
      .run()
  })

  const readExecution = Effect.fn("readExecution")(function* (callID: string, sessionID = "ses_exec") {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(ToolExecutionTable)
      .where(
        and(eq(ToolExecutionTable.session_id, SessionV2.ID.make(sessionID)), eq(ToolExecutionTable.call_id, callID)),
      )
      .get()
  })

  it.effect("reduces only completed settlements past the tool-output window", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seedExecution({ callID: "exec_stale_completed", status: "completed", updatedAt: now - 40 * DAY })
      yield* seedExecution({ callID: "exec_fresh_completed", status: "completed", updatedAt: now - 1 * DAY })
      yield* seedExecution({ callID: "exec_stale_running", status: "running", updatedAt: now - 40 * DAY })
      yield* seedExecution({ callID: "exec_stale_indeterminate", status: "indeterminate", updatedAt: now - 40 * DAY })

      const retention = yield* Retention.Service
      const report = yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 })
      expect(report.executions).toBe(1)

      const reduced = yield* readExecution("exec_stale_completed")
      expect(reduced?.settlement?.output?.content[0]).toMatchObject({ type: "text" })
      expect(JSON.stringify(reduced?.settlement)).toContain(Retention.TOOL_MARKER)
      // `filler line 200` sits in the middle of the payload, which is the only part a head/tail
      // preview drops -- the first and last lines survive truncation and cannot discriminate.
      expect(JSON.stringify(reduced?.settlement)).not.toContain("filler line 200")
      // A row that may still be claimed or resumed keeps every byte of its outcome.
      for (const untouched of ["exec_fresh_completed", "exec_stale_running", "exec_stale_indeterminate"]) {
        const settlement = JSON.stringify((yield* readExecution(untouched))?.settlement)
        expect(settlement).toContain("filler line 200")
        expect(settlement).not.toContain(Retention.TOOL_MARKER)
      }
    }),
  )

  it.effect("sweeps every eligible row across batch boundaries when call ids repeat", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const { db } = yield* Database.Service
      // More rows than one batch, sharing only three distinct call ids so duplicate groups are
      // guaranteed to straddle a boundary. A cursor keyed on `call_id` alone steps over the rest of
      // the straddling group and leaves most of these untouched.
      const total = 250
      yield* db
        .insert(ToolExecutionTable)
        .values(
          Array.from({ length: total }, (_, index) => ({
            session_id: SessionV2.ID.make("ses_exec_paging"),
            assistant_message_id: SessionMessage.ID.make(`msg_paged_${String(index).padStart(4, "0")}`),
            call_id: `toolu_${index % 3}`,
            request_hash: "hash",
            status: "completed" as const,
            settlement: settlement(bigOutput),
            time_created: now - 40 * DAY,
            time_updated: now - 40 * DAY,
          })),
        )
        .run()

      const retention = yield* Retention.Service
      expect((yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 })).executions).toBe(total)
      const remaining = yield* db
        .select()
        .from(ToolExecutionTable)
        .where(eq(ToolExecutionTable.session_id, SessionV2.ID.make("ses_exec_paging")))
        .all()
      expect(remaining.length).toBe(total)
      expect(remaining.filter((row) => JSON.stringify(row.settlement).includes("filler line 200")).length).toBe(0)
    }),
  )

  test("does not overwrite a settlement changed after the retention read", async () => {
    await withFileBackedRetention((blocker, filename) =>
      Effect.gen(function* () {
        const updatedAt = Date.now() - 90 * DAY
        yield* seedExecution({ callID: "exec_retention_race", status: "completed", updatedAt })
        const stored = blocker
          .query("SELECT settlement FROM tool_execution WHERE call_id = ?")
          .get("exec_retention_race") as { settlement: string }
        const newer = JSON.stringify({ ...JSON.parse(stored.settlement), projectorNewer: true })
        const updater = yield* Effect.promise(() =>
          startBlockingUpdate(filename, "UPDATE tool_execution SET settlement = ? WHERE call_id = ?", [
            newer,
            "exec_retention_race",
          ]),
        )
        const retention = yield* Retention.Service
        const sweeping = yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 }).pipe(Effect.forkChild)

        expect(yield* Fiber.join(sweeping)).toEqual({ messages: 0, executions: 0, bytes: 0 })
        expect(yield* Effect.promise(() => updater.exited)).toBe(0)
        expect(
          JSON.parse(
            (
              blocker.query("SELECT settlement FROM tool_execution WHERE call_id = ?").get("exec_retention_race") as {
                settlement: string
              }
            ).settlement,
          ),
        ).toMatchObject({ projectorNewer: true })
      }),
    )
  })
})

describe("Retention preview rewrite", () => {
  it.effect("keeps the head and tail of the original payload around the marker", () =>
    Effect.gen(function* () {
      const next = Retention.truncateToolState(
        { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: bigOutput }], structured: {} },
        { pruneInputs: false },
      )
      expect(next).toBeDefined()
      const text = (next as unknown as { content: { text: string }[] }).content[0]!.text
      expect(text).toContain("FIRST LINE OF OUTPUT")
      expect(text).toContain("LAST LINE")
      expect(text).toContain(Retention.TOOL_MARKER)
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(Retention.PREVIEW_MAX_BYTES)
    }),
  )

  it.effect("keeps the tool call identifiable: name, input, and outputPaths survive", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_identifiable",
        messages: [
          {
            createdAt: now - 90 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_identifiable"),
              type: "assistant",
              agent: "build",
              model,
              content: [
                completedTool("call_identifiable", bigOutput, {
                  input: { command: "rg --files" },
                  outputPaths: ["/data/tool-output/tool_abc"],
                }),
              ],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 0 })
      const data = (yield* readMessage("msg_identifiable")).data as unknown as {
        content: { type: string; name?: string; state?: Record<string, unknown> }[]
      }
      const tool = data.content.find((item) => item.type === "tool")!
      expect(tool.name).toBe("bash")
      expect(tool.state).toMatchObject({
        status: "completed",
        input: { command: "rg --files" },
        outputPaths: ["/data/tool-output/tool_abc"],
      })
      // `content` must never be emptied: an empty array makes `toResultValue` fall back to
      // `structured` and re-ship the payload that was just cleared.
      expect((tool.state as { content: unknown[] }).content.length).toBe(1)
      expect(tool.state).toMatchObject({ structured: {} })
    }),
  )

  it.effect("keeps the transcript readable: user prompts and assistant text survive a sweep", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed({
        sessionID: "ses_readable",
        archivedAt: now - 60 * DAY,
        messages: [
          {
            createdAt: now - 90 * DAY,
            message: SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_readable_user"),
              type: "user",
              text: "please find every TODO in the repo",
              time: { created },
            }),
          },
          {
            createdAt: now - 90 * DAY,
            message: SessionMessage.Assistant.make({
              id: SessionMessage.ID.make("msg_readable_assistant"),
              type: "assistant",
              agent: "build",
              model,
              content: [
                { type: "text", id: "txt_1", text: "I searched the repository and found 12 TODOs." },
                completedTool("call_readable", bigOutput),
                { type: "text", id: "txt_2", text: "The oldest one is in src/legacy.ts." },
              ],
              time: { created },
            }),
          },
        ],
      })
      const retention = yield* Retention.Service
      yield* retention.sweep({ toolOutputDays: 14, archivedSessionDays: 30 })

      // The user's own words are never a retention target.
      expect((yield* readMessage("msg_readable_user")).data).toMatchObject({
        text: "please find every TODO in the repo",
      })
      const assistant = (yield* readMessage("msg_readable_assistant")).data
      expect(assistantText(assistant)).toBe(
        "I searched the repository and found 12 TODOs.\nThe oldest one is in src/legacy.ts.",
      )
      expect(toolText(assistant)).toContain(Retention.TOOL_MARKER)
      // The session itself and its title are never removed.
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionV2.ID.make("ses_readable")))
          .get(),
      ).toMatchObject({ title: "retention fixture" })
    }),
  )

  it.effect("leaves a payload already within the preview budget completely alone", () =>
    Effect.gen(function* () {
      expect(
        Retention.truncateToolState(
          { status: "completed", input: {}, content: [{ type: "text", text: "ok" }], structured: {} },
          { pruneInputs: false },
        ),
      ).toBeUndefined()
    }),
  )

  it.effect("clears oversized tool inputs only when the archive window applies", () =>
    Effect.gen(function* () {
      const state = {
        status: "completed" as const,
        input: { filePath: "/src/index.ts", content: "x".repeat(5_000) },
        content: [{ type: "text" as const, text: bigOutput }],
        structured: {},
      }
      const kept = Retention.truncateToolState(state, { pruneInputs: false })
      const cleared = Retention.truncateToolState(state, { pruneInputs: true })
      expect((kept as { input: Record<string, unknown> }).input["content"]).toBe(state.input.content)
      expect((cleared as { input: Record<string, unknown> }).input["content"]).toBe(Retention.INPUT_REMOVED_TEXT)
      // Small fields are identity, not payload, and survive either way.
      expect((cleared as { input: Record<string, unknown> }).input["filePath"]).toBe("/src/index.ts")
    }),
  )

  it.effect("preserves the error on a failed tool call while clearing its payload", () =>
    Effect.gen(function* () {
      const next = Retention.truncateToolState(
        {
          status: "error",
          input: { command: "ls" },
          content: [{ type: "text", text: bigOutput }],
          structured: {},
          error: { type: "unknown", message: "exited with code 1" },
        },
        { pruneInputs: false },
      )
      expect(next).toMatchObject({ status: "error", error: { type: "unknown", message: "exited with code 1" } })
    }),
  )
})
