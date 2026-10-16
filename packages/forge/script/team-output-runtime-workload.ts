import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { isolateWorkload } from "./team-output-isolation"

const rounds = Number(process.argv[2] ?? 3)
const idleDurationMs = Number(process.argv[3] ?? 60_000)
const sampleIntervalMs = Number(process.argv[4] ?? 1_000)
const toolBytes = Number(process.argv[5] ?? 65_536)
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("Rounds must be 1..20")
if (!Number.isSafeInteger(idleDurationMs) || idleDurationMs < 1_000 || idleDurationMs > 3_600_000)
  throw new Error("Idle duration must be 1000..3600000 milliseconds")
if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 100 || sampleIntervalMs > idleDurationMs / 2)
  throw new Error("Sample interval must be 100 milliseconds through half the idle duration")
if (!Number.isSafeInteger(toolBytes) || toolBytes < 32_768 || toolBytes > 262_144)
  throw new Error("Tool bytes must be 32768..262144")
if (process.env.NODE_ENV !== "test") throw new Error("Use NODE_ENV=test with disposable state only")

// Redirect state before importing any runtime service. Never use a developer vault key.
const root = await isolateWorkload("team-output-runtime-")

const started = performance.now()
const headProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
const head = (await new Response(headProcess.stdout).text()).trim()
assert.equal(await headProcess.exited, 0)
const identity = {
  head,
  harnessSHA256: new Bun.CryptoHasher("sha256").update(await Bun.file(import.meta.path).bytes()).digest("hex"),
  isolationSHA256: new Bun.CryptoHasher("sha256").update(await Bun.file(new URL("./team-output-isolation.ts", import.meta.url)).bytes()).digest("hex"),
  bun: Bun.version,
  pid: process.pid,
  ppid: process.ppid,
  rounds,
  idleDurationMs,
  sampleIntervalMs,
  toolBytes,
  concurrency: 1,
}
const samples: { phase: string; elapsedMs: number; rss: number; heapUsed: number; external: number }[] = []
const counts = { factories: 0, cancelled: 0, tools: 0, generatedToolBytes: 0, providerCalls: 0, providerAborts: 0 }
const latencyMs: number[] = []
const sample = (phase: string) => {
  const value = {
    ...identity,
    utc: new Date().toISOString(),
    phase,
    elapsedMs: performance.now() - started,
    ...process.memoryUsage(),
  }
  samples.push(value)
  console.log(JSON.stringify(value))
}
const sampler = setInterval(() => sample("periodic"), sampleIntervalMs)
try {
  const { Context, Effect, Schema } = await import("effect")
  const { Team } = await import("@turenlabs/schema/team")
  const { Global } = await import("@turenlabs/core/global")
  const { HttpApiApp } = await import("../src/server/routes/instance/httpapi/server")
  const { InstanceRuntime } = await import("../src/project/instance-runtime")
  const { AppRuntime } = await import("../src/effect/app-runtime")
  const { TestLLMServer, reply } = await import("../test/lib/llm-server")
  const directory = path.join(root, "workspace")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "forge.json"), JSON.stringify({ model: "team-fixture/chat" }))
  const request = async (route: string, method = "GET", body?: unknown) => {
    const response = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost${route}`, {
        method,
        headers: { "x-forge-directory": directory, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      Context.makeUnsafe<unknown>(new Map()),
    )
    assert.equal(response.status, 200, `Unexpected status for ${route}`)
    return response.json()
  }
  const wait = async <T>(read: () => Promise<T | undefined>) => {
    const deadline = performance.now() + 40_000
    while (performance.now() < deadline) {
      const value = await read()
      if (value !== undefined) return value
      await Bun.sleep(25)
    }
    throw new Error("Runtime readiness deadline exceeded")
  }
  sample("before-setup")
  try {
    await Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* Effect.promise(() =>
        Bun.write(
          path.join(Global.Path.config, "forge.json"),
          JSON.stringify({
            providers: {
              "team-fixture": {
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: llm.url,
                  settings: { apiKey: "scratch-fixture" },
                },
                models: {
                  chat: {
                    api: {
                      id: "chat",
                      type: "aisdk",
                      package: "@ai-sdk/openai-compatible",
                      url: llm.url,
                      settings: { apiKey: "scratch-fixture" },
                    },
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    limit: { context: 128_000, output: 2_000 },
                  },
                },
              },
            },
          }),
        ),
      )
      const room = Schema.decodeUnknownSync(Team.State)(yield* Effect.promise(() => request("/api/team"))).room
      const member = Schema.decodeUnknownSync(Team.Teammate)(
        yield* Effect.promise(() =>
          request("/api/team/teammate", "POST", {
            roomID: room.id,
            name: "Scratch worker",
            handle: "scratchworker",
            role: "Worker",
            mission: "Execute bounded scratch work.",
            directory,
            model: { id: "chat", providerID: "team-fixture" },
          }),
        ),
      )
      yield* Effect.promise(() =>
        request(`/api/team/room/${room.id}/factory`, "PUT", {
          outcome: "Run bounded scratch output.",
          parameters: {},
          constraints: "Scratch only.",
          acceptanceCriteria: "The tool ran and cancellation interrupts the provider.",
          directory,
          coordinatorTeammateID: member.id,
          teammateIDs: [member.id],
        }),
      )
      for (let round = 0; round < rounds; round++) {
        const begin = performance.now()
        const assignment = `Produce scratch output ${round}.`
        yield* llm.text(JSON.stringify({ assignments: [{ teammateID: member.id, prompt: assignment }] }))
        yield* llm.tool("bash", {
          command: `bun -e 'process.stdout.write("workload-tool-${round}\\n" + "x".repeat(${toolBytes}))'`,
        })
        yield* llm.pushFactory(
          () => true,
          (hit) => {
            assert.ok(
              JSON.stringify(hit.body).includes(`workload-tool-${round}`),
              "Actual tool output must reach the provider",
            )
            counts.tools++
            counts.generatedToolBytes += toolBytes
            return reply().text(`Scratch tool verified ${round}.`).stop()
          },
        )
        yield* llm.text(JSON.stringify({ status: "accepted", summary: `Scratch accepted ${round}.` }))
        const input = { id: `frun_workload_${round}` }
        const run = Schema.decodeUnknownSync(Team.FactoryRun)(
          yield* Effect.promise(() => request(`/api/team/room/${room.id}/factory/run`, "POST", input)),
        )
        const retry = Schema.decodeUnknownSync(Team.FactoryRun)(
          yield* Effect.promise(() => request(`/api/team/room/${room.id}/factory/run`, "POST", input)),
        )
        assert.equal(retry.id, run.id)
        const settled = yield* Effect.promise(() =>
          wait(async () => {
            const value = Schema.decodeUnknownSync(Team.FactoryRun)(await request(`/api/team/factory-run/${run.id}`))
            return value.status === "running" ? undefined : value
          }),
        )
        assert.equal(settled.status, "succeeded", JSON.stringify(settled))
        counts.factories++
        latencyMs.push(performance.now() - begin)
        sample(`factory-${round}`)

        const beforeAborts = yield* llm.aborts
        const beforeCalls = yield* llm.calls
        yield* llm.hang
        const cancelled = Schema.decodeUnknownSync(Team.FactoryRun)(
          yield* Effect.promise(() =>
            request(`/api/team/room/${room.id}/factory/run`, "POST", { id: `frun_cancel_${round}` }),
          ),
        )
        yield* llm.wait(beforeCalls + 1)
        const stopped = Schema.decodeUnknownSync(Team.FactoryRun)(
          yield* Effect.promise(() => request(`/api/team/factory-run/${cancelled.id}/cancel`, "POST")),
        )
        assert.equal(stopped.status, "cancelled")
        yield* Effect.promise(() =>
          wait(async () => ((await Effect.runPromise(llm.aborts)) > beforeAborts ? true : undefined)),
        )
        const current = Schema.decodeUnknownSync(Team.State)(
          yield* Effect.promise(() => request(`/api/team?roomID=${room.id}`)),
        )
        const cancelledTasks = current.tasks.filter((task) => cancelled.taskIDs.includes(task.id))
        assert.equal(cancelledTasks.length, 1)
        assert.ok(cancelledTasks.every((task) => task.status === "cancelled"))
        assert.ok(current.tasks.every((task) => ["succeeded", "cancelled"].includes(task.status)))
        counts.cancelled++
        assert.equal((yield* llm.misses).length, 0, "Unexpected provider request")
        counts.providerCalls += yield* llm.calls
        counts.providerAborts += yield* llm.aborts
        // Drop test-server request bodies before observing retained runtime state.
        yield* llm.reset
        sample(`cancelled-${round}`)
      }
      assert.equal(counts.tools, rounds)
      assert.equal(counts.providerCalls, rounds * 5)
      assert.equal(counts.providerAborts, rounds)
      sample("idle-start")
      yield* Effect.promise(() => Bun.sleep(idleDurationMs))
      sample("idle-end")
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped, Effect.runPromise)
  } finally {
    await InstanceRuntime.disposeAllInstances()
    await HttpApiApp.webHandler().dispose()
    await AppRuntime.dispose()
  }
  sample("services-disposed")
  const durableBytes = (
    await Promise.all(
      ["", "-wal", "-shm"].map((suffix) =>
        fs
          .stat(`${process.env.FORGE_DB}${suffix}`)
          .then((value) => value.size)
          .catch(() => 0),
      ),
    )
  ).reduce((sum, value) => sum + value, 0)
  await fs.rm(root, { recursive: true, force: true })
  await Bun.sleep(1_000)
  sample("post-cleanup")
  const idle = samples.filter(
    (value) =>
      value.elapsedMs >= samples.find((value) => value.phase === "idle-start")!.elapsedMs &&
      value.elapsedMs <= samples.find((value) => value.phase === "idle-end")!.elapsedMs,
  )
  console.log(
    JSON.stringify({
      ...identity,
      utc: new Date().toISOString(),
      phase: "summary",
      counts,
      latencyMs,
      durableBytes,
      peakSampledRSS: Math.max(...samples.map((value) => value.rss)),
      retained: process.memoryUsage(),
      idleSamples: idle.length,
      idleRSSSlopeBytesPerSecond:
        (idle.at(-1)!.rss - idle[0]!.rss) / ((idle.at(-1)!.elapsedMs - idle[0]!.elapsedMs) / 1000),
      nativeBytes: null,
      limits:
        "Loopback synthetic provider; actual provider transport, tools, Sessions and Team factory; sequential churn; sampled peaks; natural GC; not incident attribution",
    }),
  )
} finally {
  clearInterval(sampler)
  await fs.rm(root, { recursive: true, force: true })
}
