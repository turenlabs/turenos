import { describe, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { Deferred, Duration, Effect, Exit, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppProcess } from "@turenlabs/core/process"
import { ShellJob } from "@turenlabs/core/shell-job"
import { Storage } from "@turenlabs/core/storage"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, AppProcess.node])))
const session = () => `ses_shell_${randomUUID()}`
const input = (app: AppProcess.Interface, sessionID: string, script: string, timeout = 5_000): ShellJob.Start => ({
  sessionID,
  messageID: "msg_shell_test",
  callID: randomUUID(),
  request: script,
  timeout,
  run: app.run(
    ChildProcess.make(process.execPath, ["-e", script], {
      stdin: "ignore",
      detached: process.platform !== "win32",
      forceKillAfter: Duration.millis(100),
    }),
    { combineOutput: true, maxOutputBytes: ShellJob.MAX_OUTPUT_BYTES, timeout: Duration.millis(timeout) },
  ),
})

describe("durable ShellJob runner", () => {
  it.live("joins concurrent and completed retries without repeating real shell side effects; conflicts fail", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const marker = `${tmp.path}/executions`
      const request = input(
        app,
        session(),
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n'); setTimeout(() => { console.log('once'); process.exit(7) }, 80)`,
      )
      const starts = yield* Effect.all([jobs.start(request), jobs.start(request)], { concurrency: "unbounded" })
      expect(starts[0].id).toBe(starts[1].id)
      const result = yield* jobs.wait(request.sessionID, starts[0].id, 5_000)
      expect(result).toMatchObject({ status: "failed", exit: 7, truncated: false, output: "once\n" })
      expect(yield* jobs.start(request)).toEqual(result)
      expect(Exit.isFailure(yield* jobs.start({ ...request, request: "different" }).pipe(Effect.exit))).toBe(true)
      expect(yield* jobs.list(request.sessionID)).toHaveLength(1)
      expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("once\n")
    }),
  )

  it.live("survives the originating scope return and notifies once only for detached work", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const notices: ShellJob.Info[] = []
      const request = {
        ...input(app, session(), "setTimeout(() => console.log('later'), 120)"),
        notify: (info: ShellJob.Info) =>
          Effect.sync(() => {
            notices.push(info)
          }),
      }
      const launched = yield* Effect.scoped(
        Effect.gen(function* () {
          const job = yield* jobs.start(request)
          return yield* jobs.detach(request.sessionID, job.id)
        }),
      )
      expect(launched.status).toBe("running")
      const result = yield* jobs.wait(request.sessionID, launched.id, 5_000)
      expect(result).toMatchObject({ status: "completed", output: "later\n" })
      yield* jobs.deliver(request.sessionID, request.notify)
      expect(notices).toHaveLength(1)
      const quick = yield* jobs.start({ ...request, callID: randomUUID() })
      yield* jobs.wait(request.sessionID, quick.id, 5_000)
      yield* jobs.detach(request.sessionID, quick.id)
      yield* jobs.deliver(request.sessionID, request.notify)
      expect(notices).toHaveLength(1)
    }),
  )

  it.live("enforces session ownership for status, output, wait, cancel and list", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const request = input(app, session(), "setTimeout(() => console.log('private'), 200)")
      const job = yield* jobs.start(request)
      const stranger = session()
      for (const action of [
        jobs.observe(stranger, job.id),
        jobs.wait(stranger, job.id, 1),
        jobs.cancel(stranger, job.id),
        jobs.detach(stranger, job.id),
      ]) {
        expect(Exit.isFailure(yield* action.pipe(Effect.exit))).toBe(true)
      }
      expect(yield* jobs.list(stranger)).toEqual([])
      expect((yield* jobs.wait(request.sessionID, job.id, 5_000)).output).toBe("private\n")
    }),
  )

  it.live("caps actual output and lists bounded summaries without captured output", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const request = input(app, session(), "process.stdout.write('x'.repeat(2 * 1024 * 1024))")
      const job = yield* jobs.start(request)
      const result = yield* jobs.wait(request.sessionID, job.id, 5_000)
      expect(result.status).toBe("completed")
      expect(result.truncated).toBe(true)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(ShellJob.MAX_OUTPUT_BYTES)
      const listing = yield* jobs.list(request.sessionID)
      expect(listing[0]?.output).toBe("")
      expect(JSON.stringify(listing).length).toBeLessThan(1024)
    }),
  )

  it.live("cancels owned processes and retains timeout observations without rerunning", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const request = input(app, session(), "setInterval(() => {}, 1000)")
      const job = yield* jobs.start(request)
      const cancelled = yield* jobs.cancel(request.sessionID, job.id)
      expect(["stopping", "cancelled"]).toContain(cancelled.status)
      expect((yield* jobs.wait(request.sessionID, job.id, 5_000)).status).toBe("cancelled")
      const timed = input(app, request.sessionID, "setInterval(() => {}, 1000)", 30)
      const timedJob = yield* jobs.start(timed)
      expect((yield* jobs.wait(timed.sessionID, timedJob.id, 5_000)).status).toBe("timed_out")
      expect((yield* jobs.start(timed)).status).toBe("timed_out")
    }),
  )

  it.live("does not clobber another live service and marks lost runtime ownership interrupted on reconstruction", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const storage = yield* Storage.Service
      const request = input(app, session(), "setTimeout(() => console.log('done'), 150)")
      const job = yield* jobs.start(request)
      const other = yield* ShellJob.make
      expect((yield* other.observe(request.sessionID, job.id)).status).toBe("running")
      expect(Exit.isFailure(yield* other.cancel(request.sessionID, job.id).pipe(Effect.exit))).toBe(true)
      yield* jobs.wait(request.sessionID, job.id, 5_000)
      const address = { scope: ShellJob.recordScope, key: Storage.Key.make(job.id) }
      const row = yield* storage.get(address)
      const record = Schema.decodeUnknownSync(Schema.fromJsonString(ShellJob.Record))(row!.value)
      yield* storage.set({
        ...address,
        value: JSON.stringify({ ...record, status: "running", owner: "lost-runtime", ownerPID: process.pid }),
      })
      const restarted = yield* ShellJob.make
      expect((yield* restarted.start(request)).status).toBe("interrupted")
      expect((yield* restarted.cancel(request.sessionID, job.id)).status).toBe("interrupted")
    }),
  )

  it.live("retries failed notification delivery even after it falls outside the newest 32 jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const request = input(app, session(), "setTimeout(() => console.log('done'), 60)")
      const job = yield* jobs.start({ ...request, notify: () => Effect.die("delivery failed") })
      yield* jobs.detach(request.sessionID, job.id)
      yield* jobs.wait(request.sessionID, job.id, 5_000)
      for (const index of Array.from({ length: ShellJob.MAX_LIST + 1 }, (_, index) => index)) {
        const newer = yield* jobs.start(input(app, request.sessionID, `console.log(${index})`))
        yield* jobs.wait(request.sessionID, newer.id, 5_000)
      }
      expect((yield* jobs.list(request.sessionID)).map((info) => info.id)).not.toContain(job.id)
      const notices: string[] = []
      const notify = (info: ShellJob.Info) =>
        Effect.sync(() => {
          notices.push(info.id)
        })
      yield* jobs.deliver(request.sessionID, notify)
      yield* jobs.deliver(request.sessionID, notify)
      expect(notices).toEqual([job.id])
    }),
  )

  it.live("returns stopping while a leaked-stdio-style teardown is blocked", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sessionID = session()
      const job = yield* jobs.start({
        sessionID,
        messageID: "msg_teardown",
        callID: "blocked",
        request: "blocked teardown",
        timeout: 5_000,
        run: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.await(release)),
        ),
      })
      yield* Deferred.await(started)
      yield* Effect.gen(function* () {
        expect((yield* jobs.cancel(sessionID, job.id)).status).toBe("stopping")
        expect((yield* jobs.wait(sessionID, job.id, 5)).status).toBe("stopping")
        yield* Deferred.succeed(release, undefined)
        expect((yield* jobs.wait(sessionID, job.id, 5_000)).status).toBe("cancelled")
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    }),
  )

  it.live("limits active jobs per owner before launching another process", () =>
    Effect.gen(function* () {
      const jobs = yield* ShellJob.make
      const app = yield* AppProcess.Service
      const sessionID = session()
      const launched = yield* Effect.forEach(Array.from({ length: ShellJob.MAX_OWNER_ACTIVE }), () =>
        jobs.start(input(app, sessionID, "setInterval(() => {}, 1000)")),
      )
      expect(
        Exit.isFailure(yield* jobs.start(input(app, sessionID, "console.log('not launched')")).pipe(Effect.exit)),
      ).toBe(true)
      for (const job of launched) {
        yield* jobs.cancel(sessionID, job.id)
        yield* jobs.wait(sessionID, job.id, 5_000)
      }
    }),
  )
})
