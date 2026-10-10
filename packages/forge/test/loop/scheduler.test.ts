import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Loop } from "@turenlabs/core/loop"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { SessionMessage } from "@turenlabs/core/session/message"
import { RelativePath } from "@turenlabs/core/schema"
import { extractStepOutput, pollDue, renderWorkflowStep, toLoopRelativePath } from "../../src/loop/scheduler"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { awaitWithTimeout, it, testEffect } from "../lib/effect"

const created = DateTime.makeUnsafe(0)
const completed = DateTime.makeUnsafe(1)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const assistant = (
  id: string,
  content: ReadonlyArray<SessionMessage.AssistantContent>,
  options: {
    readonly completed?: typeof completed
    readonly error?: string
    readonly files?: ReadonlyArray<string>
  } = {},
): SessionMessage.Assistant =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: "build",
    model,
    content: [...content],
    ...(options.error ? { error: { type: "unknown", message: options.error } } : {}),
    ...(options.files ? { snapshot: { files: options.files.map((file) => RelativePath.make(file)) } } : {}),
    time: { created, ...(options.completed ? { completed: options.completed } : {}) },
  })

const text = (id: string, value: string): SessionMessage.AssistantText => ({ type: "text", id, text: value })

const user = (id: string): SessionMessage.User =>
  SessionMessage.User.make({ id: SessionMessage.ID.make(id), type: "user", text: "follow-up", time: { created } })

describe("LoopScheduler Automation workflow", () => {
  test("renders ordered agent and skill steps for Turen delivery", () => {
    const first = renderWorkflowStep(
      { id: "inspect", name: "Inspect CI", type: "agent", prompt: "Find the first actionable failure." },
      0,
      2,
    )
    const final = renderWorkflowStep(
      {
        id: "sweep",
        name: "Run CI skill",
        type: "skill",
        skill: "ci-sweeper",
        instructions: "Only report actionable failures.",
      },
      1,
      2,
    )

    expect(first).toContain("Automation step 1 of 2: Inspect CI")
    expect(first).toContain("Find the first actionable failure.")
    expect(first).not.toContain("delivered inside TurenOS")
    expect(final).toContain("Automation step 2 of 2: Run CI skill")
    expect(final).toContain('Load and follow the "ci-sweeper" skill.')
    expect(final).toContain("Additional instructions: Only report actionable failures.")
    expect(final).toContain("delivered inside TurenOS")
  })

  test("resolves earlier-step bindings when rendering agent prompts", () => {
    const rendered = renderWorkflowStep(
      { id: "sweep", name: "Sweep", type: "agent", prompt: "Triage {{ steps.inspect.output.failures }} failures" },
      1,
      2,
      {
        trigger: { type: "scheduled", scheduledAt: 7, payload: {} },
        steps: { inspect: { text: "fallback", json: { failures: 3 }, artifacts: [] } },
      },
    )

    expect(rendered).toContain("Triage 3 failures")
    expect(rendered).not.toContain("{{")
  })

  test("marks a single-step workflow as the final delivery step", () => {
    const rendered = renderWorkflowStep(
      { id: "only", name: "Only", type: "agent", prompt: "Do it all." },
      0,
      1,
    )

    expect(rendered).toContain("Automation step 1 of 1: Only")
    expect(rendered).toContain("delivered inside TurenOS")
  })

  test("omits the instructions line for skill steps without instructions", () => {
    const rendered = renderWorkflowStep(
      { id: "sweep", name: "Sweep", type: "skill", skill: "ci-sweeper", instructions: "  " },
      0,
      1,
    )

    expect(rendered).toContain('Load and follow the "ci-sweeper" skill.')
    expect(rendered).not.toContain("Additional instructions:")
  })
})

describe("LoopScheduler extractStepOutput", () => {
  test("returns empty output when the step produced no assistant messages", () => {
    expect(extractStepOutput([])).toEqual({ text: "", artifacts: [] })
    expect(extractStepOutput([user("msg_u1")])).toEqual({ text: "", artifacts: [] })
  })

  test("keeps the last completed error-free assistant turn", () => {
    const output = extractStepOutput([
      assistant("msg_first", [text("part-1", "first")], { completed }),
      assistant("msg_err", [text("part-1", "boom")], { completed, error: "provider failed" }),
      assistant("msg_draft", [text("part-1", "unfinished")]),
      assistant("msg_final", [text("part-1", "fin"), text("part-2", "al")], { completed }),
    ])

    expect(output.text).toBe("final")
  })

  test("ignores turns after the next user message", () => {
    const output = extractStepOutput([
      assistant("msg_step", [text("part-1", "step output")], { completed, files: ["step.md"] }),
      user("msg_u1"),
      assistant("msg_later", [text("part-1", "later chatter")], { completed, files: ["later.md"] }),
    ])

    expect(output.text).toBe("step output")
    expect(output.artifacts).toEqual([{ type: "changed", path: "step.md" }])
  })

  test("decodes JSON output while leaving prose as text", () => {
    const structured = extractStepOutput([
      assistant("msg_json", [text("part-1", '{"failures": 2}')], { completed }),
    ])
    expect(structured).toMatchObject({ text: '{"failures": 2}', json: { failures: 2 } })

    const prose = extractStepOutput([assistant("msg_prose", [text("part-1", "all clear")], { completed })])
    expect(prose.text).toBe("all clear")
    expect("json" in prose).toBe(false)
  })

  test("collects changed, output, and file artifacts while skipping unsettled tool calls", () => {
    const output = extractStepOutput([
      assistant(
        "msg_work",
        [
          text("part-1", "done"),
          {
            type: "tool",
            id: "call_paths",
            name: "write",
            state: {
              status: "completed",
              input: {},
              content: [
                { type: "file", uri: "file:///work/report.md", mime: "text/markdown", name: "report.md" },
                { type: "file", uri: "file:///work/blob", mime: "application/octet-stream" },
                { type: "text", text: "noise" },
              ],
              structured: {},
              outputPaths: ["out.json"],
            },
            time: { created },
          },
          {
            type: "tool",
            id: "call_pending",
            name: "bash",
            state: { status: "pending", input: "{}" },
            time: { created },
          },
          {
            type: "tool",
            id: "call_broken",
            name: "bash",
            state: {
              status: "error",
              input: {},
              content: [{ type: "text", text: "traceback" }],
              structured: {},
              error: { type: "unknown", message: "exit 1" },
            },
            time: { created },
          },
        ],
        { completed, files: ["report.md"] },
      ),
    ])

    expect(output.artifacts).toEqual([
      { type: "changed", path: "report.md" },
      { type: "output", path: "out.json" },
      { type: "file", uri: "file:///work/report.md", mime: "text/markdown", name: "report.md" },
      { type: "file", uri: "file:///work/blob", mime: "application/octet-stream" },
    ])
  })
})

describe("LoopScheduler event trigger scoping", () => {
  const fileTrigger = (paths: ReadonlyArray<string>): Loop.FileChangeConfig => ({ type: "file-change", paths })

  test("maps absolute file events to loop-relative paths", () => {
    expect(toLoopRelativePath("/work/proj", "/work/proj/src/a.ts")).toBe("src/a.ts")
    expect(toLoopRelativePath("/work/proj", "/work/proj")).toBeUndefined()
    expect(toLoopRelativePath("/work/proj", "/work/other/a.ts")).toBeUndefined()
    expect(toLoopRelativePath("/work/proj", "/work/proj2/x.ts")).toBeUndefined()
  })

  test("selects file-change loops by directory scope and glob", () => {
    const loops = [
      { directory: "/work/proj", trigger: fileTrigger(["src/**"]) },
      { directory: "/work/proj", trigger: fileTrigger(["*.md"]) },
      { directory: "/work/other", trigger: fileTrigger(["src/**"]) },
    ]
    const firedFor = (file: string) =>
      loops.filter((loop) => {
        const relative = toLoopRelativePath(loop.directory, file)
        return relative !== undefined && Loop.matchesFileTrigger(loop.trigger, relative)
      })

    expect(firedFor("/work/proj/src/a.ts")).toHaveLength(1)
    expect(firedFor("/work/proj/README.md")).toHaveLength(1)
    expect(firedFor("/work/other/src/a.ts")).toHaveLength(1)
    expect(firedFor("/work/proj/etc/a.ts")).toHaveLength(0)
    expect(firedFor("/work/elsewhere/src/a.ts")).toHaveLength(0)
  })

  test("renders trigger payload bindings in step prompts and skill instructions", () => {
    const context = {
      trigger: {
        type: "file-change" as const,
        scheduledAt: 9,
        payload: { file: "status/now.md", directory: "/work/proj" },
      },
      steps: {},
    }
    const agent = renderWorkflowStep(
      { id: "a", name: "A", type: "agent", prompt: "Handle {{ trigger.payload.file }} in {{ trigger.payload.directory }}" },
      0,
      1,
      context,
    )
    expect(agent).toContain("Handle status/now.md in /work/proj")
    const skill = renderWorkflowStep(
      { id: "s", name: "S", type: "skill", skill: "ci-sweeper", instructions: "Check {{ trigger.payload.file }}" },
      0,
      1,
      context,
    )
    expect(skill).toContain("Check status/now.md")
  })

  test("evaluates when gates and onFailure policies without executing steps", () => {
    const context = {
      trigger: { type: "scheduled" as const, scheduledAt: 1, payload: {} },
      steps: { fetch: { text: "", json: { ok: false }, artifacts: [] } },
    }
    expect(Loop.evaluateWhen("{{ steps.fetch.output.ok }}", context)).toBe(false)
    expect(Loop.evaluateWhen("true", context)).toBe(true)
    expect(Loop.evaluateWhen(undefined, context)).toBe(true)
    expect(
      Loop.shouldContinueOnFailure({ id: "a", name: "A", type: "agent", prompt: "p", onFailure: "continue" }),
    ).toBe(true)
    expect(Loop.shouldContinueOnFailure({ id: "a", name: "A", type: "agent", prompt: "p" })).toBe(false)
  })

  test("keeps the file-change debounce default inside the validated window", () => {
    expect(Loop.FILE_CHANGE_DEBOUNCE_DEFAULT_MS).toBeGreaterThanOrEqual(0)
    expect(Loop.FILE_CHANGE_DEBOUNCE_DEFAULT_MS).toBeLessThanOrEqual(Loop.FILE_CHANGE_DEBOUNCE_MAX_MS)
    expect(Loop.FILE_CHANGE_DEBOUNCE_MAX_MS).toBe(60_000)
  })
})

describe("LoopScheduler wake", () => {
  // A stand-in for the Loop surface the poll loop reads: the earliest due time, and a change token that the
  // test signals the way the Loop service does after a local write.
  const harness = (initial: number | undefined, claims = 1) => {
    const state = {
      next: initial,
      claims,
      reads: 0,
      scans: 0,
      failures: 0,
      wake: Deferred.makeUnsafe<void>(),
    }
    const loops = {
      nextWakeAt: () =>
        Effect.sync(() => {
          state.reads++
          return state.next
        }),
      awaitChange: () => Effect.sync(() => Deferred.await(state.wake)),
    }
    const scan = Effect.suspend(() => {
      state.scans++
      if (state.failures > 0) {
        state.failures--
        return Effect.die("scan failed")
      }
      if (state.claims > 0) state.next = undefined
      return Effect.succeed(state.claims)
    })
    const signal = Effect.suspend(() => {
      const previous = state.wake
      state.wake = Deferred.makeUnsafe<void>()
      return Deferred.succeed(previous, undefined)
    })
    return { state, loops, scan, signal }
  }

  // Lets the forked poll loop run until it parks on its sleep.
  const settle = TestClock.adjust(0)

  it.effect("scans once at startup and then does not claim while nothing is scheduled", () =>
    Effect.gen(function* () {
      const poll = harness(undefined)
      const fiber = yield* Effect.forkChild(pollDue(poll.loops, poll.scan))
      yield* settle
      expect(poll.state.scans).toBe(1)

      yield* TestClock.adjust("59 seconds")
      expect(poll.state.scans).toBe(1)
      expect(poll.state.reads).toBe(1)

      // The idle cap re-reads, which is how another process's writes are noticed, but still does not claim.
      yield* TestClock.adjust("1 second")
      expect(poll.state.reads).toBe(2)
      expect(poll.state.scans).toBe(1)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("claims at the due time and not before", () =>
    Effect.gen(function* () {
      const poll = harness(20_000, 0)
      const fiber = yield* Effect.forkChild(pollDue(poll.loops, poll.scan))
      yield* settle
      expect(poll.state.scans).toBe(1)

      yield* TestClock.adjust("19 seconds")
      expect(poll.state.scans).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(poll.state.scans).toBe(2)
      expect(poll.state.reads).toBe(2)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("wakes for a local change without waiting for the idle cap", () =>
    Effect.gen(function* () {
      const poll = harness(undefined)
      const fiber = yield* Effect.forkChild(pollDue(poll.loops, poll.scan))
      yield* settle
      expect(poll.state.scans).toBe(1)

      poll.state.next = 0
      yield* poll.signal
      yield* settle
      expect(poll.state.scans).toBe(2)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("does not lose a change that lands between the token and the read", () =>
    Effect.gen(function* () {
      const poll = harness(undefined)
      // The write completes inside the read, after the token was captured.
      const racing = {
        awaitChange: poll.loops.awaitChange,
        nextWakeAt: () =>
          poll.loops.nextWakeAt().pipe(Effect.tap(() => (poll.state.reads === 1 ? poll.signal : Effect.void))),
      }
      const fiber = yield* Effect.forkChild(pollDue(racing, poll.scan))
      yield* settle
      // The first read was signalled mid-read, so the pass re-reads without any time passing.
      expect(poll.state.reads).toBe(2)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("waits at least 250 ms after a predicted-due scan that claimed nothing", () =>
    Effect.gen(function* () {
      const poll = harness(0, 0)
      const fiber = yield* Effect.forkChild(pollDue(poll.loops, poll.scan))
      yield* settle
      // Startup scan, then one predicted-due scan that claimed nothing.
      expect(poll.state.scans).toBe(2)

      yield* TestClock.adjust("249 millis")
      expect(poll.state.scans).toBe(2)
      yield* TestClock.adjust("1 millis")
      expect(poll.state.scans).toBe(3)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("keeps claiming without sleeping while claims come back", () =>
    Effect.gen(function* () {
      const poll = harness(0)
      let remaining = 3
      const scan = Effect.suspend(() => {
        poll.state.scans++
        remaining--
        poll.state.next = remaining > 0 ? 0 : undefined
        return Effect.succeed(32)
      })
      const fiber = yield* Effect.forkChild(pollDue(poll.loops, scan))
      yield* settle
      expect(poll.state.scans).toBe(3)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("retries after a failed scan following a one second pause", () =>
    Effect.gen(function* () {
      const poll = harness(undefined)
      poll.state.failures = 1
      const fiber = yield* Effect.forkChild(pollDue(poll.loops, poll.scan))
      yield* settle
      expect(poll.state.scans).toBe(1)
      expect(poll.state.reads).toBe(0)

      yield* TestClock.adjust("999 millis")
      expect(poll.state.reads).toBe(0)
      yield* TestClock.adjust("1 millis")
      expect(poll.state.reads).toBe(1)
      yield* Fiber.interrupt(fiber)
    }),
  )
})

describe("LoopScheduler wake with the Loop service", () => {
  const live = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node])))

  live.live("claims a loop created while the scheduler is idle without waiting for the idle cap", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const claimed = yield* Deferred.make<ReadonlyArray<string>>()
      const started = yield* Deferred.make<void>()
      const scan = loops.claimDue({ owner: "test" }).pipe(
        Effect.orDie,
        Effect.tap(() => Deferred.succeed(started, undefined)),
        Effect.tap((runs) =>
          runs.length
            ? Deferred.succeed(
                claimed,
                runs.map((run) => run.loopID),
              )
            : Effect.void,
        ),
        Effect.map((runs) => runs.length),
      )
      const fiber = yield* Effect.forkChild(pollDue(loops, scan))
      yield* awaitWithTimeout(Deferred.await(started), "startup scan did not run")
      yield* loops.create({
        id: "lop_idle_wake",
        name: "idle wake",
        prompt: "prompt",
        location: { directory: "/work/idle-wake" },
        intervalSeconds: Loop.MIN_INTERVAL_SECONDS,
      })
      expect(yield* awaitWithTimeout(Deferred.await(claimed), "loop was not claimed after create")).toEqual([
        "lop_idle_wake",
      ])
      yield* Fiber.interrupt(fiber)
    }),
  )
})
