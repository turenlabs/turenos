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

  it.effect("rejects invalid creation inputs", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const agentStep = (id: string, prompt = "Do work"): Loop.WorkflowStep => ({
        id,
        name: id,
        type: "agent",
        prompt,
      })
      const workflowWith = (steps: ReadonlyArray<Loop.WorkflowStep>): Loop.Workflow => ({
        version: 1,
        steps,
        delivery: { type: "turen" },
      })
      const manySteps: Array<Loop.WorkflowStep> = Array.from({ length: 13 }, (_, index) =>
        agentStep(`step_${index}`),
      )
      const cases: ReadonlyArray<Partial<Loop.CreateInput>> = [
        { name: "   " },
        { expiresAt: Date.now() - 1_000 },
        { expiresAt: Date.now() + Loop.DEFAULT_EXPIRY_MS + 1_000 },
        { startsAt: Date.now() + 60_000, expiresAt: Date.now() + 30_000 },
        { prompt: "   " },
        { workflow: workflowWith([]) },
        { workflow: workflowWith(manySteps) },
        { workflow: workflowWith([agentStep("dup"), agentStep("dup")]) },
        { workflow: workflowWith([agentStep("broken", "Needs {{oops}}")]) },
        { workflow: workflowWith([agentStep("ghost", "Needs {{ steps.missing.output }}")]) },
        { workflow: workflowWith([agentStep("weird", "Needs {{ inventory.count }}")]) },
        { workflow: workflowWith([agentStep("triggered", "At {{ trigger.executedAt }}")]) },
        {
          workflow: workflowWith([
            agentStep("first", "Needs {{ steps.first.output }}"),
            agentStep("second", "Runs later"),
          ]),
        },
        { workflow: workflowWith([{ id: "skill", name: "skill", type: "skill", skill: "  ", instructions: "" }]) },
        { workflow: workflowWith([agentStep("empty", "   ")]) },
      ]
      yield* Effect.forEach(cases, (overrides, index) =>
        Effect.gen(function* () {
          const error = yield* loops.create(input(`lop_bad_${index}`, overrides)).pipe(Effect.flip)
          expect(error).toBeInstanceOf(Loop.InvalidInputError)
        }),
      )
    }),
  )

  it.effect("enforces the per-location active cap independently of other directories", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* Effect.forEach(
        Array.from({ length: Loop.MAX_ACTIVE_PER_LOCATION }, (_, index) => index),
        (index) => loops.create(input(`lop_loc_${index}`, { location: { directory: "/work/lop-capped" } })),
        { concurrency: 1 },
      )
      const crowded = yield* loops
        .create(input("lop_loc_over", { location: { directory: "/work/lop-capped" } }))
        .pipe(Effect.flip)
      expect(crowded).toBeInstanceOf(Loop.ActiveLimitError)

      const elsewhere = yield* loops.create(
        input("lop_loc_elsewhere", { location: { directory: "/work/lop-roomy" } }),
      )
      expect(elsewhere.status).toBe("active")
    }),
  )

  it.effect("fails lookups for unknown loops and runs", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      expect(yield* loops.get("lop_missing").pipe(Effect.flip)).toBeInstanceOf(Loop.NotFoundError)
      expect(yield* loops.getRun({ id: "lrn_missing" }).pipe(Effect.flip)).toBeInstanceOf(Loop.RunNotFoundError)
      expect(yield* loops.listRuns("lop_missing").pipe(Effect.flip)).toBeInstanceOf(Loop.NotFoundError)
      expect(
        yield* loops.recordRunSession({ id: "lrn_missing", owner: "owner", sessionID: "session" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.RunNotFoundError)
      expect(
        yield* loops.finishRun({ id: "lrn_missing", owner: "owner", status: "succeeded" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.RunNotFoundError)
      expect(yield* loops.runNow({ id: "lop_missing", owner: "owner" }).pipe(Effect.flip)).toBeInstanceOf(
        Loop.NotFoundError,
      )
      expect(yield* loops.delete("lop_missing")).toBe(false)
    }),
  )

  it.effect("refuses operations in the wrong state", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const database = yield* Database.Service
      yield* loops.create(input("lop_paused_state", { paused: true }))
      const created = yield* loops.create(input("lop_active_state"))

      expect(yield* loops.pause("lop_paused_state").pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      expect(yield* loops.resume(created.id).pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      expect(yield* loops.claimDue({ owner: "worker", limit: 0 }).pipe(Effect.flip)).toBeInstanceOf(
        Loop.InvalidInputError,
      )
      expect(yield* loops.claimDue({ owner: "worker", limit: 51 }).pipe(Effect.flip)).toBeInstanceOf(
        Loop.InvalidInputError,
      )
      expect(
        yield* loops.runNow({ id: created.id, owner: "owner", leaseMs: 0 }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops.renewRun({ id: "lrn_missing", owner: "owner", leaseMs: -1 }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)

      yield* database.db
        .update(LoopTable)
        .set({ expires_at: Date.now() - 1 })
        .where(eq(LoopTable.id, "lop_paused_state"))
        .run()
        .pipe(Effect.orDie)
      expect(yield* loops.resume("lop_paused_state").pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      expect(yield* loops.runNow({ id: "lop_paused_state", owner: "owner" }).pipe(Effect.flip)).toBeInstanceOf(
        Loop.InvalidStateError,
      )
      expect(yield* loops.edit({ id: "lop_paused_state" }).pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
    }),
  )

  it.effect("fences every run mutation by lease owner and run phase", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      yield* loops.create(input("lop_fence", { paused: true }))
      const claimed = yield* loops.runNow({ id: "lop_fence", owner: "owner" })

      expect(
        yield* loops.recordRunSession({ id: claimed.id, owner: "intruder", sessionID: "session-1" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      expect(
        yield* loops.completeRunStep({
          id: claimed.id,
          owner: "owner",
          currentStep: 0,
          stepID: "first",
          output: { text: "early", artifacts: [] },
        }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      yield* loops.recordRunSession({ id: claimed.id, owner: "owner", sessionID: "session-1" })
      expect(
        yield* loops.startRun({ id: claimed.id, owner: "owner", sessionID: "session-2" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      yield* loops.startRun({ id: claimed.id, owner: "owner", sessionID: "session-1" })
      expect(
        yield* loops.startRun({ id: claimed.id, owner: "owner", sessionID: "session-1" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      expect(
        yield* loops.completeRunStep({
          id: claimed.id,
          owner: "owner",
          currentStep: 1,
          stepID: "second",
          output: { text: "skipped ahead", artifacts: [] },
        }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      expect(
        yield* loops.renewRun({ id: claimed.id, owner: "intruder" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      yield* loops.finishRun({ id: claimed.id, owner: "owner", status: "succeeded" })
      expect(
        yield* loops.finishRun({ id: claimed.id, owner: "owner", status: "succeeded" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      expect(
        yield* loops.completeRunStep({
          id: claimed.id,
          owner: "owner",
          currentStep: 0,
          stepID: "first",
          output: { text: "too late", artifacts: [] },
        }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
    }),
  )

  it.effect("lists loops and runs newest-first", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const first = yield* loops.create(input("lop_order_first"))
      const second = yield* loops.create(input("lop_order_second"))

      expect((yield* loops.list()).map((info) => info.id).slice(0, 2)).toEqual([second.id, first.id])

      yield* loops.create(input("lop_order_runs", { paused: true }))
      const runFirst = yield* loops.runNow({ id: "lop_order_runs", owner: "owner" })
      yield* loops.cancelRun({ id: runFirst.id })
      const runSecond = yield* loops.runNow({ id: "lop_order_runs", owner: "owner" })
      yield* loops.cancelRun({ id: runSecond.id })

      expect((yield* loops.listRuns("lop_order_runs")).map((run) => run.id)).toEqual([runSecond.id, runFirst.id])
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

  it.effect("validates cron expressions and computes the next firing", () =>
    Effect.sync(() => {
      expect(Loop.validateCronExpression("*/5 * * * *")).toBeUndefined()
      expect(Loop.validateCronExpression("0 9 * * mon")).toBeUndefined()
      for (const expression of [
        "",
        "   ",
        "*/5 * *",
        "* * * * * *",
        "60 * * * *",
        "*/0 * * * *",
        "5-2 * * * *",
        "nope * * * *",
        "0 0 * * 8",
        "x".repeat(121),
      ]) {
        expect(Loop.validateCronExpression(expression)).toBeInstanceOf(Loop.InvalidInputError)
      }

      expect(Loop.computeCronNext("* * * * *", "UTC", Date.parse("2026-01-01T00:00:30.000Z"))).toBe(
        Date.parse("2026-01-01T00:01:00.000Z"),
      )
      expect(Loop.computeCronNext("0 12 * * *", "UTC", Date.parse("2026-01-01T00:00:00.000Z"))).toBe(
        Date.parse("2026-01-01T12:00:00.000Z"),
      )
      // The lower bound is exclusive: exactly noon fires the next day.
      expect(Loop.computeCronNext("0 12 * * *", "UTC", Date.parse("2026-01-01T12:00:00.000Z"))).toBe(
        Date.parse("2026-01-02T12:00:00.000Z"),
      )
      // dom/dow is OR: after Tue Sep 8 the next 1st-or-Sunday is Sun Sep 13.
      expect(Loop.computeCronNext("0 0 1 * 0", "UTC", Date.parse("2026-09-08T12:00:00.000Z"))).toBe(
        Date.parse("2026-09-13T00:00:00.000Z"),
      )
      // Weekday and month names resolve: after Sun Sep 6 the next Monday 09:00 follows.
      expect(Loop.computeCronNext("0 9 * * mon", "UTC", Date.parse("2026-09-06T00:00:00.000Z"))).toBe(
        Date.parse("2026-09-07T09:00:00.000Z"),
      )
      expect(
        Loop.computeCronNext("*/15 9-17 * * mon-fri", "UTC", Date.parse("2026-09-07T09:07:00.000Z")),
      ).toBe(Date.parse("2026-09-07T09:15:00.000Z"))
      // Noon in New York is 17:00 UTC in January (EST, no DST).
      expect(
        Loop.computeCronNext("0 12 * * *", "America/New_York", Date.parse("2026-01-01T00:00:00.000Z")),
      ).toBe(Date.parse("2026-01-01T17:00:00.000Z"))
      expect(Loop.computeCronNext("0 0 30 2 *", "UTC", Date.parse("2026-01-01T00:00:00.000Z"))).toBeInstanceOf(
        Loop.InvalidInputError,
      )
      expect(
        Loop.computeCronNext("0 12 * * *", "Nope/Zone", Date.parse("2026-01-01T00:00:00.000Z")),
      ).toBeInstanceOf(Loop.InvalidInputError)
    }),
  )

  it.effect("creates cron loops and advances the next run on claim", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const created = yield* loops.create(
        input("lop_cron_math", {
          intervalSeconds: undefined,
          cronExpression: "0 12 * * *",
          timezone: "UTC",
        }),
      )
      expect(created.schedule).toEqual({ type: "cron", seconds: 60, expression: "0 12 * * *", timezone: "UTC" })
      const expectedFirst = Loop.computeCronNext("0 12 * * *", "UTC", created.startsAt - 1)
      if (expectedFirst instanceof Loop.InvalidInputError) return yield* Effect.die("Expected a cron firing")
      expect(created.nextRunAt).toBe(expectedFirst)
      const first = new Date(created.nextRunAt!)
      expect(first.getUTCHours()).toBe(12)
      expect(first.getUTCMinutes()).toBe(0)

      expect(
        yield* loops
          .create(input("lop_cron_both", { intervalSeconds: 120, cronExpression: "0 12 * * *" }))
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops
          .create(input("lop_cron_bad", { intervalSeconds: undefined, cronExpression: "not a cron" }))
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops
          .create(input("lop_cron_tz", { intervalSeconds: undefined, cronExpression: "0 12 * * *", timezone: "Nope/Zone" }))
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops.edit({ id: created.id, intervalSeconds: 120, cronExpression: "0 9 * * *" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)

      yield* makeDue("lop_cron_math", Date.parse("2026-01-01T00:00:00.000Z"))
      const [run] = yield* loops.claimDue({ owner: "worker" })
      if (!run) return yield* Effect.die("Expected a claimed cron run")
      expect(run.trigger).toBe("scheduled")
      expect(run.status).toBe("claimed")
      expect(run.scheduledAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"))
      expect((yield* loops.get("lop_cron_math")).nextRunAt).toBe(Date.parse("2026-01-01T12:00:00.000Z"))

      const edited = yield* loops.edit({ id: created.id, cronExpression: "0 9 * * *" })
      expect(edited.schedule).toMatchObject({ type: "cron", expression: "0 9 * * *" })
    }),
  )

  it.effect("evaluates step when conditions and records skipped steps", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const context = {
        trigger: { type: "scheduled" as const, scheduledAt: 7, payload: { repository: "turen/forge" } },
        steps: {
          fetch: { text: "", json: { ok: false }, artifacts: [] },
          loud: { text: "found 3", json: { failures: 3 }, artifacts: [] },
        },
      }
      expect(Loop.evaluateWhen(undefined, context)).toBe(true)
      expect(Loop.evaluateWhen("   ", context)).toBe(true)
      for (const gate of ["false", "FALSE", "0", "no", "off", "skip", "null", "undefined"]) {
        expect(Loop.evaluateWhen(gate, context)).toBe(false)
      }
      for (const gate of ["true", "yes", "1", "run it"]) {
        expect(Loop.evaluateWhen(gate, context)).toBe(true)
      }
      expect(Loop.evaluateWhen("{{ steps.loud.output.failures }}", context)).toBe(true)
      expect(Loop.evaluateWhen("{{ steps.fetch.output.ok }}", context)).toBe(false)
      expect(Loop.evaluateWhen("{{ trigger.payload.repository }}", context)).toBe(true)
      expect(() => Loop.evaluateWhen("{{ steps.missing.output }}", context)).toThrow()
      expect(
        Loop.shouldContinueOnFailure({ id: "a", name: "A", type: "agent", prompt: "p", onFailure: "continue" }),
      ).toBe(true)
      expect(Loop.shouldContinueOnFailure({ id: "a", name: "A", type: "agent", prompt: "p" })).toBe(false)
      expect(
        Loop.shouldContinueOnFailure({ id: "a", name: "A", type: "agent", prompt: "p", onFailure: "stop" }),
      ).toBe(false)

      const workflow: Loop.Workflow = {
        version: 1,
        steps: [
          { id: "fetch", name: "Fetch", type: "agent", prompt: "Collect status" },
          {
            id: "notify",
            name: "Notify",
            type: "agent",
            prompt: "Report {{ steps.fetch.output }}",
            when: "{{ steps.fetch.output }}",
          },
        ],
        delivery: { type: "turen" },
      }
      const created = yield* loops.create(input("lop_when_ok", { paused: true, workflow }))
      expect(created.workflow?.steps[1]?.when).toBe("{{ steps.fetch.output }}")
      expect(
        yield* loops
          .create(
            input("lop_when_forward", {
              workflow: {
                version: 1,
                steps: [
                  { id: "first", name: "First", type: "agent", prompt: "Early", when: "{{ steps.second.output }}" },
                  { id: "second", name: "Second", type: "agent", prompt: "Later" },
                ],
                delivery: { type: "turen" },
              },
            }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops
          .create(
            input("lop_when_long", {
              workflow: {
                version: 1,
                steps: [{ id: "first", name: "First", type: "agent", prompt: "Early", when: "x".repeat(2001) }],
                delivery: { type: "turen" },
              },
            }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops
          .create(
            input("lop_onfailure_bad", {
              workflow: {
                version: 1,
                steps: [
                  {
                    id: "flaky",
                    name: "Flaky",
                    type: "agent",
                    prompt: "Work",
                    onFailure: "retry",
                  } as unknown as Loop.WorkflowStep,
                ],
                delivery: { type: "turen" },
              },
            }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)

      // An empty fetch output makes the notify gate falsy, so the scheduler
      // records the skip as an empty step output and advances the cursor.
      const skipContext = {
        trigger: { type: "manual" as const, scheduledAt: 9, payload: {} },
        steps: { fetch: { text: "", artifacts: [] } },
      }
      expect(Loop.evaluateWhen("{{ steps.fetch.output }}", skipContext)).toBe(false)
      const claimed = yield* loops.runNow({ id: "lop_when_ok", owner: "owner" })
      yield* loops.recordRunSession({ id: claimed.id, owner: "owner", sessionID: "session-when" })
      yield* loops.startRun({ id: claimed.id, owner: "owner", sessionID: "session-when", currentStep: 0 })
      const afterFetch = yield* loops.completeRunStep({
        id: claimed.id,
        owner: "owner",
        currentStep: 0,
        stepID: "fetch",
        output: { text: "", artifacts: [] },
      })
      expect(afterFetch.currentStep).toBe(1)
      yield* loops.startRun({ id: claimed.id, owner: "owner", sessionID: "session-when", currentStep: 1 })
      const afterSkip = yield* loops.completeRunStep({
        id: claimed.id,
        owner: "owner",
        currentStep: 1,
        stepID: "notify",
        output: { text: "", artifacts: [] },
      })
      expect(afterSkip.currentStep).toBe(2)
      expect(afterSkip.outputs["notify"]).toEqual({ text: "", artifacts: [] })
      expect((yield* loops.getRun({ id: claimed.id })).outputs["notify"]).toEqual({ text: "", artifacts: [] })
    }),
  )

  it.effect("fires event triggers with scoping, filters, and overlap skips", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const fileLoop = yield* loops.create(
        input("lop_evt_file", {
          intervalSeconds: undefined,
          eventTrigger: { type: "file-change", paths: ["src/**", "*.md"] },
        }),
      )
      expect(fileLoop.status).toBe("active")
      expect(fileLoop.nextRunAt).toBeUndefined()
      expect(fileLoop.eventTrigger).toEqual({ type: "file-change", paths: ["src/**", "*.md"] })
      const trigger = fileLoop.eventTrigger
      if (trigger?.type !== "file-change") return yield* Effect.die("Expected a file-change trigger")
      expect(Loop.matchesFileTrigger(trigger, "src/a/b.ts")).toBe(true)
      expect(Loop.matchesFileTrigger(trigger, "README.md")).toBe(true)
      expect(Loop.matchesFileTrigger(trigger, "other/a.ts")).toBe(false)
      expect(Loop.matchesFilePattern("src/*.ts", "src/a/b.ts")).toBe(false)
      expect(Loop.matchesFilePattern("**/*.ts", "a/b/c.ts")).toBe(true)

      const fired = yield* loops.fireEvent({
        id: "lop_evt_file",
        owner: "worker",
        trigger: "file-change",
        payload: { file: "src/a.ts", event: "change" },
      })
      expect(fired.status).toBe("claimed")
      expect(fired.trigger).toBe("file-change")
      expect(fired.triggerPayload).toMatchObject({ file: "src/a.ts", event: "change" })
      expect(fired.lease?.owner).toBe("worker")

      const overlapped = yield* loops.fireEvent({
        id: "lop_evt_file",
        owner: "other",
        trigger: "file-change",
        payload: { file: "src/b.ts", event: "change" },
      })
      expect(overlapped.status).toBe("skipped")
      expect(overlapped.lease).toBeUndefined()
      expect(overlapped.time.completed).toBeDefined()
      expect(overlapped.scheduledAt).toBeGreaterThan(fired.scheduledAt)

      expect(
        yield* loops
          .fireEvent({ id: "lop_evt_file", owner: "worker", trigger: "session-end", payload: { outcome: "success" } })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops
          .fireEvent({ id: "lop_evt_file", owner: "worker", trigger: "file-change", payload: { "bad key!": 1 } })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)

      yield* loops.create(
        input("lop_evt_paused", {
          paused: true,
          intervalSeconds: undefined,
          eventTrigger: { type: "session-end", outcomes: ["failure"] },
        }),
      )
      expect(
        yield* loops
          .fireEvent({
            id: "lop_evt_paused",
            owner: "worker",
            trigger: "session-end",
            payload: { sessionID: "ses_1", outcome: "failure" },
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      const resumed = yield* loops.resume("lop_evt_paused")
      expect(resumed.status).toBe("active")
      expect(resumed.nextRunAt).toBeUndefined()

      yield* loops.create(
        input("lop_evt_ses", {
          intervalSeconds: undefined,
          eventTrigger: { type: "session-end", outcomes: ["failure"], agent: "build" },
        }),
      )
      const matched = yield* loops.fireEvent({
        id: "lop_evt_ses",
        owner: "worker",
        trigger: "session-end",
        payload: { sessionID: "ses_1", outcome: "failure", agent: "build" },
      })
      expect(matched.status).toBe("claimed")
      expect(matched.triggerPayload).toMatchObject({ outcome: "failure", agent: "build" })
      expect(
        yield* loops
          .fireEvent({
            id: "lop_evt_ses",
            owner: "worker",
            trigger: "session-end",
            payload: { sessionID: "ses_2", outcome: "success", agent: "build" },
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)

      expect(
        yield* loops
          .create(
            input("lop_evt_combo", {
              intervalSeconds: 120,
              eventTrigger: { type: "file-change", paths: ["*.md"] },
            }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops
          .create(
            input("lop_evt_debounce", {
              intervalSeconds: undefined,
              eventTrigger: { type: "file-change", paths: ["*.md"], debounceMs: 60_001 },
            }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      const zeroDebounce = yield* loops.create(
        input("lop_evt_zero", {
          intervalSeconds: undefined,
          eventTrigger: { type: "file-change", paths: ["*.md"], debounceMs: 0 },
        }),
      )
      expect(zeroDebounce.eventTrigger).toMatchObject({ debounceMs: 0 })
      expect(
        yield* loops
          .create(
            input("lop_evt_glob", { intervalSeconds: undefined, eventTrigger: { type: "file-change", paths: [] } }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect(
        yield* loops
          .create(
            input("lop_evt_abs", {
              intervalSeconds: undefined,
              eventTrigger: { type: "file-change", paths: ["/abs/path"] },
            }),
          )
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
    }),
  )

  it.effect("fences event runs by lease and reclaims after expiry", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const database = yield* Database.Service
      yield* loops.create(
        input("lop_evt_lease", { intervalSeconds: undefined, eventTrigger: { type: "file-change", paths: ["*.md"] } }),
      )
      const claimed = yield* loops.fireEvent({
        id: "lop_evt_lease",
        owner: "owner",
        trigger: "file-change",
        payload: { file: "notes.md" },
      })
      expect(claimed.status).toBe("claimed")
      expect(
        yield* loops.finishRun({ id: claimed.id, owner: "intruder", status: "succeeded" }).pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidStateError)
      const overlapped = yield* loops.fireEvent({
        id: "lop_evt_lease",
        owner: "other",
        trigger: "file-change",
        payload: { file: "other.md" },
      })
      expect(overlapped.status).toBe("skipped")

      yield* database.db
        .update(LoopRunTable)
        .set({ lease_expires_at: Date.now() - 1 })
        .where(eq(LoopRunTable.id, claimed.id))
        .run()
        .pipe(Effect.orDie)
      const reclaimed = yield* loops.fireEvent({
        id: "lop_evt_lease",
        owner: "owner",
        trigger: "file-change",
        payload: { file: "fresh.md" },
      })
      expect(reclaimed.status).toBe("claimed")
      expect(reclaimed.lease?.owner).toBe("owner")
      expect(reclaimed.scheduledAt).toBeGreaterThan(claimed.scheduledAt)
    }),
  )

  it.effect("drives a cron and event automation end to end with a skipped step", () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const workflow: Loop.Workflow = {
        version: 1,
        steps: [
          { id: "fetch", name: "Fetch", type: "agent", prompt: "Collect status" },
          {
            id: "notify",
            name: "Notify",
            type: "agent",
            prompt: "Report {{ steps.fetch.output }}",
            when: "{{ steps.fetch.output }}",
          },
          {
            id: "summarize",
            name: "Summarize",
            type: "agent",
            prompt: "Summarize {{ steps.fetch.output }}",
            onFailure: "continue",
          },
        ],
        delivery: { type: "turen" },
      }

      yield* loops.create(
        input("lop_e2e_cron", { intervalSeconds: undefined, cronExpression: "*/5 * * * *", timezone: "UTC", workflow }),
      )
      yield* makeDue("lop_e2e_cron", Date.now() - 1)
      const [due] = yield* loops.claimDue({ owner: "e2e" })
      if (!due) return yield* Effect.die("Expected a claimed cron run")
      expect(due.trigger).toBe("scheduled")
      expect(due.status).toBe("claimed")
      expect(due.execution?.workflow?.steps.map((step) => step.id)).toEqual(["fetch", "notify", "summarize"])

      yield* loops.create(
        input("lop_e2e_evt", {
          intervalSeconds: undefined,
          eventTrigger: { type: "file-change", paths: ["status/**"] },
          workflow,
        }),
      )
      const fired = yield* loops.fireEvent({
        id: "lop_e2e_evt",
        owner: "e2e",
        trigger: "file-change",
        payload: { file: "status/now.md", event: "change" },
      })
      expect(fired.trigger).toBe("file-change")
      expect(fired.status).toBe("claimed")

      yield* loops.recordRunSession({ id: fired.id, owner: "e2e", sessionID: "ses_e2e" })
      yield* loops.startRun({ id: fired.id, owner: "e2e", sessionID: "ses_e2e", currentStep: 0 })
      const afterFetch = yield* loops.completeRunStep({
        id: fired.id,
        owner: "e2e",
        currentStep: 0,
        stepID: "fetch",
        output: { text: "", artifacts: [] },
      })
      expect(afterFetch.currentStep).toBe(1)

      const skipContext = {
        trigger: { type: fired.trigger, scheduledAt: fired.scheduledAt, payload: fired.triggerPayload ?? {} },
        steps: afterFetch.outputs,
      }
      expect(Loop.evaluateWhen("{{ steps.fetch.output }}", skipContext)).toBe(false)
      yield* loops.startRun({ id: fired.id, owner: "e2e", sessionID: "ses_e2e", currentStep: 1 })
      const afterSkip = yield* loops.completeRunStep({
        id: fired.id,
        owner: "e2e",
        currentStep: 1,
        stepID: "notify",
        output: { text: "", artifacts: [] },
      })
      expect(afterSkip.currentStep).toBe(2)
      expect(afterSkip.outputs["notify"]).toEqual({ text: "", artifacts: [] })

      expect(() => Loop.evaluateWhen("{{ steps.missing.output }}", skipContext)).toThrow()
      expect(Loop.shouldContinueOnFailure(workflow.steps[2]!)).toBe(true)
      yield* loops.startRun({ id: fired.id, owner: "e2e", sessionID: "ses_e2e", currentStep: 2 })
      const afterFailure = yield* loops.completeRunStep({
        id: fired.id,
        owner: "e2e",
        currentStep: 2,
        stepID: "summarize",
        output: { text: "Step failed but continuing: boom", artifacts: [] },
      })
      expect(afterFailure.currentStep).toBe(3)

      const finished = yield* loops.finishRun({ id: fired.id, owner: "e2e", status: "succeeded" })
      expect(finished.status).toBe("succeeded")
      expect(finished.lease).toBeUndefined()
      expect(finished.outputs["fetch"]).toEqual({ text: "", artifacts: [] })
      expect(finished.outputs["notify"]).toEqual({ text: "", artifacts: [] })
      expect(finished.outputs["summarize"]).toEqual({ text: "Step failed but continuing: boom", artifacts: [] })
    }),
  )
})
