import { expect, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { AppProcess } from "@turenlabs/core/process"
import { ShellJob } from "@turenlabs/core/shell-job"
import { Storage } from "@turenlabs/core/storage"
import { SecretOutput } from "@turenlabs/core/secret-output"
import { SecretRedaction } from "@turenlabs/core/secret-redaction"
import { ExtensionRuntime } from "@turenlabs/core/extension"
import { Extension } from "@turenlabs/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, SecretOutput.node, ExtensionRuntime.node])))
const secret = `ghp_${"aB3d".repeat(9)}`

it.live("protects opaque configured credentials before shell output persistence", () =>
  Effect.gen(function* () {
    const extensions = yield* ExtensionRuntime.Service
    const storage = yield* Storage.Service
    const jobs = yield* ShellJob.make
    const opaque = "synthetic-shell-extension-credential-78234"
    yield* extensions.update(
      Extension.ID.make("turenlabs", "pagerduty"),
      {
        enabled: false,
        secrets: { PAGERDUTY_CLIENT_SECRET: opaque },
      },
      { local: true },
    )
    const input = request(`credential=${opaque}`)
    const job = yield* jobs.start(input)
    const result = yield* jobs.wait(input.sessionID, job.id, 5_000)
    expect(result.output.includes(opaque)).toBe(false)
    expect(result.output).toContain("[SECRET:v1:known:")
    const stored = yield* storage.get({ scope: ShellJob.outputScope, key: Storage.Key.make(job.id) })
    expect(stored?.value).toBe(result.output)
  }),
)

it.live("withholds capture when sanitization throws without stranding completion or active slots", () =>
  Effect.gen(function* () {
    const { SecretRedaction } = yield* Effect.promise(() => import("@turenlabs/core/secret-redaction"))
    const jobs = yield* ShellJob.make
    const storage = yield* Storage.Service
    // Fault injection is scoped to the synchronous boundary; never replace the runner or storage.
    // Snapshots compile their redactor once, so the throwing redactor is injected there.
    const fail = () => {
      throw new Error(`synthetic sanitizer failure ${secret}`)
    }
    const sanitizer = spyOn(SecretRedaction, "compile").mockImplementation(() =>
      Object.freeze({ text: fail, json: fail, boundary: fail }),
    )
    yield* Effect.gen(function* () {
      const sessionID = `ses_failure_${randomUUID()}`
      for (const index of Array.from({ length: ShellJob.MAX_OWNER_ACTIVE + 1 }, (_, index) => index)) {
        const input = { ...request(secret), sessionID, callID: String(index) }
        const job = yield* jobs.start(input)
        const result = yield* jobs.wait(sessionID, job.id, 100)
        expect(result.status).toBe("completed")
        expect(result.output).toBe("Shell output withheld because secret sanitization failed.")
        const stored = yield* storage.get({ scope: ShellJob.outputScope, key: Storage.Key.make(job.id) })
        expect(stored?.value).toBe(result.output)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => sanitizer.mockRestore())))
  }),
)

it.live("sanitizes nonzero exit capture and never exposes process error details", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJob.make
    const storage = yield* Storage.Service
    for (const input of [
      request(secret, 7),
      {
        ...request(""),
        run: Effect.fail(new AppProcess.AppProcessError({ command: secret, stderr: secret, cause: new Error(secret) })),
      },
    ]) {
      const job = yield* jobs.start(input)
      const result = yield* jobs.wait(input.sessionID, job.id, 5_000)
      expect(result.status).toBe("failed")
      expect(result.output).not.toContain(secret)
      expect(result.output.length).toBeGreaterThan(0)
      const stored = yield* storage.get({ scope: ShellJob.outputScope, key: Storage.Key.make(job.id) })
      expect(stored?.value).toBe(result.output)
    }
  }),
)

it.live("reports truncation when placeholders expand otherwise bounded capture", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJob.make
    const input = request(`${"x".repeat(ShellJob.MAX_OUTPUT_BYTES - secret.length - 1)} ${secret}`)
    const job = yield* jobs.start(input)
    const result = yield* jobs.wait(input.sessionID, job.id, 5_000)
    expect(result.status).toBe("completed")
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(ShellJob.MAX_OUTPUT_BYTES)
    expect(result.output).not.toContain("ghp_")
  }),
)

it.live("recognizes credentials crossing the shell storage cap before truncation", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJob.make
    const storage = yield* Storage.Service
    const input = request(`${"x".repeat(ShellJob.MAX_OUTPUT_BYTES - 12)} ${secret}`)
    const job = yield* jobs.start(input)
    const result = yield* jobs.wait(input.sessionID, job.id, 5_000)
    expect(result.status).toBe("completed")
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(ShellJob.MAX_OUTPUT_BYTES)
    expect(result.output).not.toContain("ghp_")
    const stored = yield* storage.get({ scope: ShellJob.outputScope, key: Storage.Key.make(job.id) })
    expect(SecretRedaction.containsPlaceholder(result.output)).toBe(true)
    expect(stored?.value).toBe(result.output)
  }),
)
const request = (output: string, exitCode = 0): ShellJob.Start => ({
  sessionID: `ses_secret_${randomUUID()}`,
  messageID: "msg_secret",
  callID: randomUUID(),
  request: "synthetic capture",
  timeout: 5_000,
  run: Effect.succeed({
    command: "synthetic capture",
    exitCode,
    output: Buffer.from(output),
    stdout: Buffer.from(output),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
  }),
})

it.live("redacts shell capture before persistence and returns stable placeholders on repeat observations", () =>
  Effect.gen(function* () {
    const jobs = yield* ShellJob.make
    const storage = yield* Storage.Service
    const input = request(`first ${secret}\nsecond ${secret}`)
    const job = yield* jobs.start(input)
    const result = yield* jobs.wait(input.sessionID, job.id, 5_000)
    expect(result.status).toBe("completed")
    expect(result.output).not.toContain(secret)
    const placeholders = result.output.match(/\[SECRET:v1:[a-z0-9_-]+:[a-f0-9]{32}\]/g)
    expect(placeholders).toHaveLength(2)
    expect(placeholders![0]).toBe(placeholders![1])
    const stored = yield* storage.get({ scope: ShellJob.outputScope, key: Storage.Key.make(job.id) })
    expect(stored?.value).toBe(result.output)
    expect((yield* jobs.observe(input.sessionID, job.id)).output).toBe(result.output)
    expect((yield* jobs.start(input)).output).toBe(result.output)
  }),
)
