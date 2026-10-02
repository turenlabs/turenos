import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Database } from "@turenlabs/core/database/database"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { AppProcess } from "@turenlabs/core/process"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SecretOutput } from "@turenlabs/core/secret-output"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTable } from "@turenlabs/core/session/sql"
import { ShellJob } from "@turenlabs/core/shell-job"
import { Storage } from "@turenlabs/core/storage"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      AppProcess.node,
      Storage.node,
      SecretOutput.node,
      EventV2.node,
      SessionProjector.node,
    ]),
  ),
)

it.live("cancelSession admits no notice when a queried live job settles while its notice is being delivered", () =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const app = yield* AppProcess.Service
    const db = Database.primary((yield* Database.Service).db)
    const events = yield* EventV2.Service
    const finish = yield* Deferred.make<void>()
    const delivering = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const delivered = yield* Deferred.make<void>()
    const sessionID = SessionSchema.ID.create()
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(import.meta.dir), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.global,
        slug: "race",
        directory: import.meta.dir,
        title: "race",
        version: "test",
      })
      .run()
    // The hook runs after the real query returned its snapshot, so the job is live there but settles before the sweep reads it.
    let afterSnapshot = () => Effect.void
    const jobs = yield* ShellJob.make.pipe(
      Effect.provideService(Storage.Service, {
        ...storage,
        query: (input) => storage.query(input).pipe(Effect.tap(() => afterSnapshot())),
      }),
    )
    const job = yield* jobs.start({
      sessionID,
      messageID: "msg_cancel_race",
      callID: "call_cancel_race",
      request: "race",
      timeout: 5_000,
      run: Deferred.await(finish).pipe(
        Effect.andThen(
          app.run(ChildProcess.make(process.execPath, ["-e", ""], { stdin: "ignore" }), { combineOutput: true }),
        ),
      ),
      notify: (info) =>
        Deferred.succeed(delivering, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            SessionInput.admit(db, events, {
              sessionID,
              id: SessionMessage.ID.make(`msg_shell_${info.id.slice(4)}`),
              prompt: Prompt.make({ text: "Shell job observation" }),
              delivery: "queue",
              source: "shell_job",
              kind: "prompt",
            }),
          ),
          Effect.andThen(Deferred.succeed(delivered, undefined)),
          Effect.asVoid,
        ),
    })
    yield* jobs.detach(sessionID, job.id)
    afterSnapshot = () =>
      Deferred.succeed(finish, undefined).pipe(
        Effect.andThen(jobs.wait(sessionID, job.id, 5_000)),
        Effect.andThen(Deferred.await(delivering)),
        Effect.orDie,
      )
    const sweep = yield* jobs.cancelSession(sessionID).pipe(Effect.forkChild)
    // The in-flight delivery finishes only after the sweep has started waiting on it.
    yield* Deferred.succeed(release, undefined).pipe(Effect.delay("100 millis"), Effect.forkChild)
    yield* Fiber.join(sweep)
    afterSnapshot = () => Effect.void
    yield* SessionInput.cancelPendingBySource(db, sessionID, "shell_job")
    yield* Deferred.await(delivered)
    expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(false)
    yield* jobs.deliver(sessionID, () => Effect.die("A swept job must not be delivered again"))
  }),
)
