import { expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Location } from "@turenlabs/core/location"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionExecutionControl } from "@turenlabs/core/session/execution-control"
import { SessionMessage } from "@turenlabs/core/session/message"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionInputTable, SessionTable } from "@turenlabs/core/session/sql"
import { ShellJob } from "@turenlabs/core/shell-job"
import { ShellJobTool } from "@turenlabs/core/tool/shell-job"
import { ToolRegistry } from "@turenlabs/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

if (process.platform !== "win32")
  test("ShellJobTool admits one queued same-session completion and wakes once", async () => {
    await using tmp = await tmpdir()
    const directory = AbsolutePath.make(tmp.path)
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const db = Database.primary(database.db)
        const agents = yield* AgentV2.Service
        const tools = yield* ShellJobTool.Service
        const registry = yield* ToolRegistry.Service
        const jobs = yield* ShellJob.Service
        const sessionID = SessionSchema.ID.create()
        const agent = AgentV2.ID.make("shell-delivery-test")
        yield* agents.transform((editor) =>
          editor.update(agent, (draft) => {
            draft.mode = "primary"
            draft.permissions = [{ action: "*", resource: "*", effect: "allow" }]
          }),
        )
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
          .onConflictDoNothing()
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: "shell-delivery",
            directory,
            title: "Shell delivery",
            version: "test",
          })
          .run()
        const woken = yield* Deferred.make<void>()
        const wakes: SessionSchema.ID[] = []
        const control: SessionExecutionControl.Interface = {
          ...SessionExecutionControl.noop,
          wake: () => Effect.die("Completion must use advisory wake"),
          wakeAdvisory: (id) =>
            Effect.sync(() => {
              wakes.push(id)
            }).pipe(Effect.andThen(Deferred.succeed(woken, undefined)), Effect.asVoid),
        }
        const materialized = yield* registry.materialize({ session: yield* tools.forExecution({ sessionID, control }) })
        const returned = yield* materialized.settle({
          sessionID,
          agent,
          assistantMessageID: SessionMessage.ID.create(),
          call: {
            type: "tool-call",
            id: "shell-delivery",
            name: "bash",
            input: { command: "sleep 2; printf UNTRUSTED_COMMAND_TEXT" },
          },
        })
        const result = returned.output?.structured as { job_id: string; status: string }
        expect(result.status).toBe("running")
        expect((yield* jobs.wait(sessionID, result.job_id, 5_000)).output).toBe("UNTRUSTED_COMMAND_TEXT")
        yield* Deferred.await(woken).pipe(Effect.timeout(5_000))
        // Retry materialization waits for the delivery latch, then finds the durable sent disposition.
        yield* tools.forExecution({ sessionID, control })
        yield* tools.forExecution({ sessionID, control })
        const rows = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          id: `msg_shell_${result.job_id.slice(4)}`,
          session_id: sessionID,
          source: "shell_job",
          delivery: "queue",
          promoted_seq: null,
        })
        expect(JSON.stringify(rows[0]?.prompt)).not.toContain("UNTRUSTED_COMMAND_TEXT")
        expect(wakes).toEqual([sessionID])
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              Database.node,
              AgentV2.node,
              ShellJob.node,
              ShellJobTool.node,
              ToolRegistry.node,
              SessionProjector.node,
            ]),
            [[Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))]],
          ),
        ),
      ),
    )
  }, 15_000)
