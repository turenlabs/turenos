import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { AgentV2 } from "@turenlabs/core/agent"
import { ModelV2 } from "@turenlabs/core/model"
import { ProviderV2 } from "@turenlabs/core/provider"
import { LoopRunTable, LoopTable } from "@turenlabs/core/loop/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node])))

const input = (id: string, overrides: Partial<Loop.CreateInput> = {}): Loop.CreateInput => ({
  id,
  name: id,
  prompt: `prompt for ${id}`,
  location: { directory: `/work/${id}` },
  intervalSeconds: Loop.MIN_INTERVAL_SECONDS,
  ...overrides,
})

const makeDue = (id: string, scheduledAt = Date.now() - 1) =>
  Database.Service.use(({ db }) =>
    db
      .update(LoopTable)
      .set({ status: "active", next_run_at: scheduledAt, expires_at: Date.now() + 60_000 })
      .where(eq(LoopTable.id, id))
      .run()
      .pipe(Effect.orDie),
  )

describe("Loop", () => {
  it.effect("creates active loops due immediately and roundtrips location data", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const before = Date.now()
      const created = yield* loops.create(
        input("lop_create", {
          location: { directory: "/work/tree", workspaceID: "workspace-1" },
          timezone: "America/New_York",
        }),
      )
      const after = Date.now()

      expect(created.nextRunAt!).toBeGreaterThanOrEqual(before)
      expect(created.nextRunAt!).toBeLessThanOrEqual(after)
      expect(created.startsAt).toBe(created.nextRunAt!)
      expect(created.location).toEqual({ directory: "/work/tree", workspaceID: "workspace-1" })
      expect(created.schedule).toEqual({ type: "interval", seconds: 60, timezone: "America/New_York" })
      expect(yield* loops.get(created.id)).toEqual(created)

      const claimed = yield* loops.claimDue({ owner: "worker" })
      expect(claimed).toHaveLength(1)
      expect(claimed[0]?.scheduledAt).toBe(created.startsAt)
    }),
  )

  it.effect("uses the TurenOS global directory when no location is selected", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const created = yield* loops.create(input("lop_global", { location: undefined }))

      expect(created.location).toEqual({ directory: Loop.DEFAULT_LOCATION_DIRECTORY })
      const [run] = yield* loops.claimDue({ owner: "worker" })
      expect(run?.execution?.location).toEqual({ directory: Loop.DEFAULT_LOCATION_DIRECTORY })
      expect((yield* loops.getRun({ id: run!.id })).execution?.location).toEqual({
        directory: Loop.DEFAULT_LOCATION_DIRECTORY,
      })
    }),
  )

  it.effect("preserves explicit locations and rejects an empty explicit directory", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const explicit = yield* loops.create(
        input("lop_explicit", { location: { directory: "/work/explicit", workspaceID: "ws-1" } }),
      )
      expect(explicit.location).toEqual({ directory: "/work/explicit", workspaceID: "ws-1" })

      const error = yield* loops.create(input("lop_empty", { location: { directory: "   " } })).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Loop.InvalidInputError)
    }),
  )

  it.effect("persists and clears agent, model, and skill execution choices", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const model = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("anthropic"),
        id: ModelV2.ID.make("claude"),
      })
      const created = yield* loops.create(
        input("lop_runtime", {
          agent: AgentV2.ID.make("build"),
          model,
          skill: "ci-sweeper",
          prompt: "Only report actionable failures",
        }),
      )

      expect(created).toMatchObject({ agent: "build", model, skill: "ci-sweeper" })
      const edited = yield* loops.edit({
        id: created.id,
        resetAgent: true,
        resetModel: true,
        resetSkill: true,
        prompt: "Use a custom prompt instead",
      })
      expect(edited.agent).toBeUndefined()
      expect(edited.model).toBeUndefined()
      expect(edited.skill).toBeUndefined()
    }),
  )

  it.effect("resolves typed outputs and artifacts into downstream step templates", () =>
    Effect.sync(() => {
      const context = {
        trigger: { type: "scheduled" as const, scheduledAt: 1234, payload: { repository: "turen/forge" } },
        steps: {
          research: {
            text: "fallback text",
            json: { repository: "turen/forge", failures: 2 },
            artifacts: [{ type: "changed" as const, path: "report.md" }],
          },
        },
      }
      expect(Loop.resolveBindings("Repo: {{ steps.research.output.repository }}", context)).toBe("Repo: turen/forge")
      expect(Loop.resolveBindings("Failures: {{ steps.research.output.failures }}", context)).toBe("Failures: 2")
      expect(Loop.resolveBindings("Files: {{ steps.research.artifacts }}", context)).toContain("report.md")
      expect(
        Loop.resolveBindings("Trigger: {{ trigger.payload.repository }} @ {{ trigger.scheduledAt }}", context),
      ).toBe("Trigger: turen/forge @ 1234")
      expect(() => Loop.resolveBindings("Missing: {{ steps.unknown.output }}", context)).toThrow()
    }),
  )

  it.effect("carries per-step agent, model, and effort into the claimed snapshot", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const workflow: Loop.Workflow = {
        version: 1,
        steps: [
          {
            id: "research",
            name: "Research",
            type: "agent",
            prompt: "Look for failures",
            agent: AgentV2.ID.make("plan"),
            model: ModelV2.Ref.make({
              providerID: ProviderV2.ID.make("anthropic"),
              id: ModelV2.ID.make("claude"),
              variant: ModelV2.VariantID.make("high"),
            }),
          },
          { id: "write", name: "Write", type: "agent", prompt: "Summarize {{ steps.research.output }}" },
        ],
        delivery: { type: "turen" },
      }
      yield* loops.create(input("lop_step_execution", { workflow }))
      const [run] = yield* loops.claimDue({ owner: "worker" })
      const steps = run?.execution?.workflow?.steps ?? []

      expect(steps[0]).toMatchObject({
        id: "research",
        agent: "plan",
        model: { providerID: "anthropic", id: "claude", variant: "high" },
      })
      // A step that selects nothing stays inherited rather than being materialized here.
      expect(steps[1]?.agent).toBeUndefined()
      expect(steps[1]?.model).toBeUndefined()
    }),
  )

  it.effect("snapshots execution choices when an occurrence is claimed", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const model = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("anthropic"), id: ModelV2.ID.make("claude") })
      const workflow: Loop.Workflow = {
        version: 1,
        steps: [
          { id: "inspect", name: "Inspect CI", type: "agent", prompt: "Find the first actionable failure" },
          { id: "summarize", name: "Summarize", type: "skill", skill: "ci-sweeper", instructions: "Be concise" },
        ],
        delivery: { type: "turen" },
      }
      const created = yield* loops.create(
        input("lop_snapshot", {
          name: "Original title",
          prompt: "Original instructions",
          location: { directory: "/work/original", workspaceID: "workspace-1" },
          agent: AgentV2.ID.make("build"),
          model,
          skill: "ci-sweeper",
          workflow,
        }),
      )
      const [run] = yield* loops.claimDue({ owner: "worker" })
      if (!run) return yield* Effect.die("Expected a claimed Loop run")

      yield* loops.edit({
        id: created.id,
        name: "Edited title",
        prompt: "Edited instructions",
        resetAgent: true,
        resetModel: true,
        resetSkill: true,
        workflow: {
          version: 1,
          steps: [{ id: "changed", name: "Changed", type: "agent", prompt: "Changed after claim" }],
          delivery: { type: "turen" },
        },
      })

      expect(run?.execution).toEqual({
        title: "Original title",
        prompt: "Original instructions",
        location: { directory: "/work/original", workspaceID: "workspace-1" },
        agent: AgentV2.ID.make("build"),
        model,
        skill: "ci-sweeper",
        workflow,
      })
      expect((yield* loops.getRun({ id: run.id })).execution).toEqual(run.execution)
    }),
  )

  it.effect("validates intervals and enforces the active loop cap", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* Effect.forEach([0, 59, 60.5, Number.NaN], (intervalSeconds) =>
        Effect.gen(function* () {
          const error = yield* loops
            .create(input(`lop_invalid_${String(intervalSeconds)}`, { intervalSeconds }))
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(Loop.InvalidInputError)
        }),
      )

      yield* Effect.forEach(
        Array.from({ length: Loop.MAX_ACTIVE }, (_, index) => index),
        (index) => loops.create(input(`lop_cap_${index}`, { startsAt: Date.now() + 60_000 })),
        { concurrency: 1 },
      )
      const error = yield* loops.create(input("lop_over_cap")).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Loop.ActiveLimitError)
      if (error instanceof Loop.ActiveLimitError) expect(error.limit).toBe(Loop.MAX_ACTIVE)
    }),
  )

  it.effect("claims each scheduled occurrence once", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_idempotent", { paused: true }))
      const scheduledAt = Date.now() - 1
      yield* makeDue("lop_idempotent", scheduledAt)

      expect(yield* loops.claimDue({ owner: "first" })).toHaveLength(1)
      yield* makeDue("lop_idempotent", scheduledAt)
      expect(yield* loops.claimDue({ owner: "second" })).toEqual([])
      expect(yield* loops.listRuns("lop_idempotent")).toHaveLength(1)
    }),
  )

  it.effect("records a skipped occurrence instead of overlapping an active run", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_overlap", { paused: true }))
      yield* makeDue("lop_overlap", Date.now() - 2)
      const first = (yield* loops.claimDue({ owner: "first" }))[0]!
      yield* makeDue("lop_overlap", first.scheduledAt + 1)
      const second = (yield* loops.claimDue({ owner: "second" }))[0]!

      expect(first.status).toBe("claimed")
      expect(second.status).toBe("skipped")
      expect(second.lease).toBeUndefined()
      expect(second.time.completed).toBeDefined()
    }),
  )

  it.effect("expires due loops without creating a run", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_expiry", { paused: true }))
      const database = yield* Database.Service
      yield* database.db
        .update(LoopTable)
        .set({ status: "active", next_run_at: Date.now() - 2, expires_at: Date.now() - 1 })
        .where(eq(LoopTable.id, "lop_expiry"))
        .run()
        .pipe(Effect.orDie)

      expect(yield* loops.claimDue({ owner: "worker" })).toEqual([])
      expect((yield* loops.get("lop_expiry")).status).toBe("expired")
      expect(yield* loops.listRuns("lop_expiry")).toEqual([])
    }),
  )

  it.effect("pauses and resumes with the next occurrence one interval later", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const created = yield* loops.create(input("lop_pause"))
      const paused = yield* loops.pause(created.id)
      expect(paused.status).toBe("paused")
      expect(paused.nextRunAt).toBeUndefined()

      const before = Date.now() + Loop.MIN_INTERVAL_SECONDS * 1_000
      const resumed = yield* loops.resume(created.id)
      const after = Date.now() + Loop.MIN_INTERVAL_SECONDS * 1_000
      expect(resumed.status).toBe("active")
      expect(resumed.nextRunAt).toBeGreaterThanOrEqual(before)
      expect(resumed.nextRunAt).toBeLessThanOrEqual(after)
    }),
  )

  it.effect("creates manual runs and skips a manual overlap", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_manual", { paused: true }))
      const first = yield* loops.runNow({ id: "lop_manual", owner: "manual-owner" })
      const second = yield* loops.runNow({ id: "lop_manual", owner: "other-owner" })

      expect(first.trigger).toBe("manual")
      expect(first.status).toBe("claimed")
      expect(first.lease?.owner).toBe("manual-owner")
      expect(second.trigger).toBe("manual")
      expect(second.status).toBe("skipped")
      expect(second.scheduledAt).toBeGreaterThan(first.scheduledAt)
    }),
  )

  it.effect("hands HTTP-admitted manual runs to the scheduler owner", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_manual_handoff", { paused: true }))
      const admitted = yield* loops.runNow({ id: "lop_manual_handoff", owner: "manual" })
      const claimed = yield* loops.claimDue({ owner: "scheduler" })

      expect(claimed.map((run) => run.id)).toEqual([admitted.id])
      expect(claimed[0]?.lease?.owner).toBe("scheduler")
    }),
  )

  it.effect("refuses to delete a loop while its child run is active", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_delete", { paused: true }))
      const run = yield* loops.runNow({ id: "lop_delete", owner: "owner" })

      expect(yield* loops.delete("lop_delete").pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      yield* loops.cancelRun({ id: run.id })
      expect(yield* loops.delete("lop_delete")).toBe(true)
    }),
  )

  it.effect("requires lease ownership to start, renew, and finish a run", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_lease", { paused: true }))
      const claimed = yield* loops.runNow({ id: "lop_lease", owner: "owner", leaseMs: 60_000 })

      expect(
        yield* loops.startRun({ id: claimed.id, owner: "intruder", sessionID: "session-1" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      yield* loops.recordRunSession({ id: claimed.id, owner: "owner", sessionID: "session-1" })
      const running = yield* loops.startRun({ id: claimed.id, owner: "owner", sessionID: "session-1" })
      expect(running.status).toBe("running")
      expect(running.sessionID).toBe("session-1")
      const renewed = yield* loops.renewRun({ id: claimed.id, owner: "owner", leaseMs: 120_000 })
      expect(renewed.lease!.expiresAt).toBeGreaterThan(running.lease!.expiresAt)
      expect(
        yield* loops.finishRun({ id: claimed.id, owner: "intruder", status: "succeeded" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      const finished = yield* loops.finishRun({ id: claimed.id, owner: "owner", status: "failed", error: "boom" })
      expect(finished.status).toBe("failed")
      expect(finished.error).toBe("boom")
      expect(finished.lease).toBeUndefined()
    }),
  )

  it.effect("recovers a completed step boundary and fences cancellation", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(
        input("lop_step_recovery", {
          paused: true,
          workflow: {
            version: 1,
            steps: [
              { id: "first", name: "First", type: "agent", prompt: "First task" },
              { id: "second", name: "Second", type: "agent", prompt: "Second task" },
            ],
            delivery: { type: "turen" },
          },
        }),
      )
      const claimed = yield* loops.runNow({ id: "lop_step_recovery", owner: "old-owner", leaseMs: 60_000 })
      yield* loops.recordRunSession({ id: claimed.id, owner: "old-owner", sessionID: "session-workflow" })
      yield* loops.startRun({ id: claimed.id, owner: "old-owner", sessionID: "session-workflow", currentStep: 0 })
      const boundary = yield* loops.completeRunStep({
        id: claimed.id,
        owner: "old-owner",
        currentStep: 0,
        stepID: "first",
        output: { text: "First output", json: { result: "ok" }, artifacts: [{ type: "changed", path: "result.md" }] },
      })
      expect(boundary).toMatchObject({
        status: "claimed",
        currentStep: 1,
        outputs: {
          first: { text: "First output", json: { result: "ok" }, artifacts: [{ type: "changed", path: "result.md" }] },
        },
      })

      const database = yield* Database.Service
      yield* database.db
        .update(LoopRunTable)
        .set({ lease_expires_at: Date.now() - 1 })
        .where(eq(LoopRunTable.id, claimed.id))
        .run()
        .pipe(Effect.orDie)

      const [recovered] = yield* loops.claimDue({ owner: "new-owner" })
      expect(recovered).toMatchObject({ id: claimed.id, status: "claimed", currentStep: 1 })
      expect(recovered?.lease?.owner).toBe("new-owner")
      yield* loops.cancelRun({ id: claimed.id })

      expect(
        yield* loops
          .startRun({ id: claimed.id, owner: "new-owner", sessionID: "session-workflow", currentStep: 1 })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
    }),
  )

  it.effect("marks an expired lease stale without replaying its occurrence", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_stale", { paused: true }))
      const claimed = yield* loops.runNow({ id: "lop_stale", owner: "old-owner" })
      yield* loops.recordRunSession({ id: claimed.id, owner: "old-owner", sessionID: "session-ambiguous" })
      yield* loops.startRun({ id: claimed.id, owner: "old-owner", sessionID: "session-ambiguous" })
      const database = yield* Database.Service
      yield* database.db
        .update(LoopRunTable)
        .set({ lease_expires_at: Date.now() - 1 })
        .where(eq(LoopRunTable.id, claimed.id))
        .run()
        .pipe(Effect.orDie)

      expect(yield* loops.claimDue({ owner: "new-owner" })).toEqual([])
      const stale = yield* loops.getRun({ id: claimed.id })
      expect(stale.status).toBe("stale")
      expect(stale.lease).toBeUndefined()
      expect(stale.time.completed).toBeDefined()
      expect(yield* loops.listRuns("lop_stale")).toHaveLength(1)
    }),
  )

  it.effect("reclaims a lease that expired before a child session was recorded", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_reclaim", { paused: true }))
      const claimed = yield* loops.runNow({ id: "lop_reclaim", owner: "old-owner" })
      const database = yield* Database.Service
      yield* database.db
        .update(LoopRunTable)
        .set({ lease_expires_at: Date.now() - 1 })
        .where(eq(LoopRunTable.id, claimed.id))
        .run()
        .pipe(Effect.orDie)

      const recovered = yield* loops.claimDue({ owner: "new-owner" })
      expect(recovered.map((run) => run.id)).toEqual([claimed.id])
      expect(recovered[0]?.lease?.owner).toBe("new-owner")
    }),
  )

  it.effect("cancels active runs and rejects repeated cancellation", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_cancel", { paused: true }))
      const run = yield* loops.runNow({ id: "lop_cancel", owner: "owner" })
      const cancelled = yield* loops.cancelRun({ id: run.id, loopID: "lop_cancel" })

      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.lease).toBeUndefined()
      expect(cancelled.time.completed).toBeDefined()
      expect(yield* loops.cancelRun({ id: run.id }).pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
    }),
  )

  it.effect("accepts /loop command parameters: interval + prompt + agent + model", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const model = ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("anthropic"),
        id: ModelV2.ID.make("claude-sonnet"),
      })
      // Simulate /loop 5m run tests with agent and model
      const loopParams = {
        name: "Loop: run tests",
        prompt: "run tests",
        intervalSeconds: 300, // 5 minutes
        location: { directory: "/work/test" },
        agent: AgentV2.ID.make("build"),
        model,
      }
      const created = yield* loops.create({ id: "lop_slash_cmd", ...loopParams })

      expect(created.name).toBe("Loop: run tests")
      expect(created.prompt).toBe("run tests")
      expect(created.schedule.seconds).toBe(300)
      expect(created.agent).toBe(AgentV2.ID.make("build"))
      expect(created.model).toEqual(model)
      expect(created.location).toEqual({ directory: "/work/test" })
    }),
  )
})
