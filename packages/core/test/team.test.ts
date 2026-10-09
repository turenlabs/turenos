import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { Loop } from "@turenlabs/core/loop"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { TeamDutyTable, TeamDutyRunTable, TeamTaskTable } from "@turenlabs/core/team/workspace.sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node, TeamWorkspace.node])))

function claimDuty(owner: string, workflow?: Loop.Workflow) {
  return Effect.gen(function* () {
    const team = yield* TeamWorkspace.Service
    const loop = yield* Loop.Service
    const mate = yield* team.createTeammate({ name: "Moss", handle: "moss", role: "Analyst", mission: "Review" })
    const duty = yield* loop.create({
      teammateID: mate.id,
      name: "Review",
      prompt: "Review",
      intervalSeconds: 3600,
      paused: true,
      workflow,
    })
    const run = yield* loop.runNow({ id: duty.id, owner })
    const start = { id: run.id, owner, sessionID: `ses_duty_${run.id}` }
    yield* loop.recordRunSession(start)
    const snapshot = yield* team.recordDutyRun({ runID: run.id, loopID: duty.id })
    return { team, loop, mate, duty, run, start, snapshot }
  })
}

describe("TeamWorkspace", () => {
  it.effect("gates scheduled factory tasks on the linked Loop lease", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const loops = yield* Loop.Service
      const room = yield* team.createRoom({ name: "factory-loop" })
      const coordinator = yield* team.createTeammate({
        roomID: room.id,
        name: "Lead",
        handle: "lead",
        role: "Lead",
        mission: "Coordinate",
      })
      yield* team.configureFactory({
        roomID: room.id,
        config: {
          outcome: "Build",
          parameters: {},
          constraints: "Safe",
          acceptanceCriteria: "Pass",
          directory: "/tmp/factory",
          coordinatorTeammateID: coordinator.id,
          teammateIDs: [coordinator.id],
        },
      })
      const loop = yield* loops.create({
        factoryRoomID: room.id,
        name: "Scheduled factory",
        prompt: "Factory trigger",
        intervalSeconds: Loop.MIN_INTERVAL_SECONDS,
      })
      expect((yield* team.teammateForDuty(loop.id))?.id).toBe(coordinator.id)
      const loopRun = yield* loops.runNow({ id: loop.id, owner: "manual" })
      const factoryRun = yield* team.startFactoryRun({
        id: `frun_${loopRun.id}`,
        roomID: room.id,
        sourceLoopRunID: loopRun.id,
      })
      expect(
        (yield* team.startFactoryRun({ id: factoryRun.id, roomID: room.id, sourceLoopRunID: loopRun.id })).id,
      ).toBe(factoryRun.id)
      expect(
        yield* team
          .startFactoryRun({ id: factoryRun.id, roomID: room.id, sourceLoopRunID: "different" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.ConflictError)
      yield* team.syncFactoryRuns()
      expect((yield* team.getFactoryRun(factoryRun.id)).status).toBe("running")
      const [claimed] = yield* team.claimTasks({ owner: "before-loop-start" })
      expect((yield* team.startTask({ id: claimed!.id, owner: "before-loop-start" })).status).toBe("queued")
      const task = yield* team.getTask(claimed!.id)
      yield* loops.recordRunSession({ id: loopRun.id, owner: "manual", sessionID: task.sessionID })
      yield* loops.startRun({ id: loopRun.id, owner: "manual", sessionID: task.sessionID })
      const [reclaimed] = yield* team.claimTasks({ owner: "after-loop-start" })
      expect((yield* team.startTask({ id: reclaimed!.id, owner: "after-loop-start" })).status).toBe("running")
    }),
  )

  it.effect("advances a factory plan through work and an accepted check", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "factory-stages" })
      const coordinator = yield* team.createTeammate({
        roomID: room.id,
        name: "Lead",
        handle: "lead",
        role: "Lead",
        mission: "Coordinate",
      })
      const worker = yield* team.createTeammate({
        roomID: room.id,
        name: "Worker",
        handle: "worker",
        role: "Builder",
        mission: "Build",
      })
      yield* team.configureFactory({
        roomID: room.id,
        config: {
          outcome: "Build feature",
          parameters: {},
          constraints: "Keep permissions",
          acceptanceCriteria: "Tests pass",
          directory: "/tmp/factory",
          coordinatorTeammateID: coordinator.id,
          teammateIDs: [coordinator.id, worker.id],
        },
      })
      const run = yield* team.startFactoryRun({ id: "frun_stages", roomID: room.id })
      const [planTask] = yield* team.claimTasks({ owner: "factory-plan" })
      yield* team.startTask({ id: planTask!.id, owner: "factory-plan" })
      yield* team.finishTask({
        id: planTask!.id,
        owner: "factory-plan",
        status: "succeeded",
        text: JSON.stringify({ assignments: [{ teammateID: worker.id, prompt: "Build it" }] }),
      })
      yield* team.syncFactoryRuns()
      expect((yield* team.getFactoryRun(run.id)).phase).toBe("work")
      const [workTask] = yield* team.claimTasks({ owner: "factory-work" })
      yield* team.startTask({ id: workTask!.id, owner: "factory-work" })
      yield* team.finishTask({ id: workTask!.id, owner: "factory-work", status: "succeeded", text: "Feature built" })
      yield* team.syncFactoryRuns()
      expect((yield* team.getFactoryRun(run.id)).phase).toBe("check")
      const [checkTask] = yield* team.claimTasks({ owner: "factory-check" })
      yield* team.startTask({ id: checkTask!.id, owner: "factory-check" })
      yield* team.finishTask({
        id: checkTask!.id,
        owner: "factory-check",
        status: "succeeded",
        text: JSON.stringify({ status: "accepted", summary: "All criteria pass" }),
      })
      yield* team.syncFactoryRuns()
      expect(yield* team.getFactoryRun(run.id)).toMatchObject({
        status: "succeeded",
        phase: "done",
        result: "All criteria pass",
      })
    }),
  )

  it.effect("persists large valid factory plan output before parsing", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "factory-large-plan" })
      const members = yield* Effect.forEach(["lead", "alpha", "bravo", "charlie"], (handle) =>
        team.createTeammate({ roomID: room.id, name: handle, handle, role: "Builder", mission: "Build" }),
      )
      yield* team.configureFactory({
        roomID: room.id,
        config: {
          outcome: "Build",
          parameters: {},
          constraints: "Safe",
          acceptanceCriteria: "Pass",
          directory: "/tmp/factory",
          coordinatorTeammateID: members[0]!.id,
          teammateIDs: members.map((member) => member.id),
        },
      })
      const run = yield* team.startFactoryRun({ id: "frun_large_plan", roomID: room.id })
      const [plan] = yield* team.claimTasks({ owner: "large-plan-owner" })
      yield* team.startTask({ id: plan!.id, owner: "large-plan-owner" })
      const text = JSON.stringify({
        assignments: members.slice(1).map((member) => ({ teammateID: member.id, prompt: "\u0000".repeat(7000) })),
      })
      expect(text.length).toBeGreaterThan(20000)
      yield* team.finishTask({ id: plan!.id, owner: "large-plan-owner", status: "succeeded", text })
      yield* team.syncFactoryRuns()
      expect((yield* team.getFactoryRun(run.id)).phase).toBe("work")
      expect((yield* team.state({ roomID: room.id })).tasks.find((task) => task.id === run.taskIDs[0])?.status).toBe(
        "succeeded",
      )
    }),
  )

  it.effect("cancels linked factory work when one worker fails", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "factory-failure" })
      const coordinator = yield* team.createTeammate({
        roomID: room.id,
        name: "Lead",
        handle: "lead",
        role: "Lead",
        mission: "Coordinate",
      })
      const left = yield* team.createTeammate({
        roomID: room.id,
        name: "Left",
        handle: "left",
        role: "Builder",
        mission: "Build",
      })
      const right = yield* team.createTeammate({
        roomID: room.id,
        name: "Right",
        handle: "right",
        role: "Builder",
        mission: "Build",
      })
      yield* team.configureFactory({
        roomID: room.id,
        config: {
          outcome: "Build",
          parameters: {},
          constraints: "Safe",
          acceptanceCriteria: "Pass",
          directory: "/tmp/factory",
          coordinatorTeammateID: coordinator.id,
          teammateIDs: [coordinator.id, left.id, right.id],
        },
      })
      const run = yield* team.startFactoryRun({ id: "frun_worker_failure", roomID: room.id })
      const [plan] = yield* team.claimTasks({ owner: "plan-owner" })
      yield* team.startTask({ id: plan!.id, owner: "plan-owner" })
      yield* team.finishTask({
        id: plan!.id,
        owner: "plan-owner",
        status: "succeeded",
        text: JSON.stringify({
          assignments: [
            { teammateID: left.id, prompt: "Left" },
            { teammateID: right.id, prompt: "Right" },
          ],
        }),
      })
      yield* team.syncFactoryRuns()
      const work = yield* team.claimTasks({ owner: "work-owner", limit: 2 })
      yield* Effect.forEach(work, (task) => team.startTask({ id: task.id, owner: "work-owner" }), { discard: true })
      yield* team.finishTask({ id: work[0]!.id, owner: "work-owner", status: "failed", error: "Worker failed" })
      yield* team.syncFactoryRuns()
      expect((yield* team.getFactoryRun(run.id)).status).toBe("failed")
      expect((yield* team.getTask(work[1]!.id)).status).toBe("cancelled")
      expect(yield* team.startTask({ id: work[1]!.id, owner: "work-owner" }).pipe(Effect.flip)).toBeInstanceOf(
        TeamWorkspace.ConflictError,
      )
    }),
  )

  it.effect("configures a factory and admits an idempotent planning task", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "factory" })
      const coordinator = yield* team.createTeammate({
        roomID: room.id,
        name: "Lead",
        handle: "lead",
        role: "Lead",
        mission: "Coordinate",
      })
      const worker = yield* team.createTeammate({
        roomID: room.id,
        name: "Worker",
        handle: "worker",
        role: "Builder",
        mission: "Build",
      })
      const config = {
        outcome: "Build the feature",
        parameters: { target: "core" },
        constraints: "Keep permissions unchanged",
        acceptanceCriteria: "Tests pass",
        directory: "/tmp/factory",
        coordinatorTeammateID: coordinator.id,
        teammateIDs: [coordinator.id, worker.id],
      }
      expect((yield* team.configureFactory({ roomID: room.id, config })).factory?.config).toEqual(config)
      const run = yield* team.startFactoryRun({ id: "frun_test", roomID: room.id, request: "Implement" })
      expect(run).toMatchObject({ id: "frun_test", status: "running", phase: "plan" })
      expect(run.taskIDs).toHaveLength(1)
      expect(yield* team.startFactoryRun({ id: "frun_test", roomID: room.id, request: "Implement" })).toEqual(run)
      expect((yield* team.getTask(run.taskIDs[0]!)).factoryRunID).toBe(run.id)
      expect((yield* team.state({ roomID: room.id })).factoryRuns?.[0]).toEqual(run)
      expect(
        yield* team.startFactoryRun({ id: "frun_test", roomID: room.id, request: "Different" }).pipe(Effect.flip),
      ).toBeInstanceOf(TeamWorkspace.ConflictError)
    }),
  )

  it.effect("admits case-insensitive mentions without redirecting trailing-hyphen handles", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const rae = yield* team.createTeammate({ name: "Rae", handle: "rae", role: "Analyst", mission: "Review" })
      const dashed = yield* team.createTeammate({
        name: "Rae Dash",
        handle: "rae-",
        role: "Analyst",
        mission: "Review",
      })
      const upper = yield* team.postMessage({ id: "case-mention", text: "Please help @RAE and @rae" })
      expect(upper.tasks.map((task) => task.teammateID)).toEqual([rae.id])
      const dash = yield* team.postMessage({ id: "dash-mention", text: "Please help (@RAE-)" })
      expect(dash.tasks.map((task) => task.teammateID)).toEqual([dashed.id])
      expect((yield* team.postMessage({ id: "unknown-dash-mention", text: "@rae-unknown-" })).tasks).toHaveLength(0)
    }),
  )

  it.effect("cancels a claimed duty when its teammate pauses before first start", () =>
    Effect.gen(function* () {
      const fixture = yield* claimDuty("pause-owner")
      expect(fixture.snapshot?.status).toBe("active")
      yield* fixture.team.editTeammate({ id: fixture.mate.id, status: "paused" })
      expect(yield* fixture.loop.startRun(fixture.start).pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      const stopped = yield* fixture.loop.getRun({ id: fixture.run.id })
      expect(stopped.status).toBe("cancelled")
      expect(stopped.time.started).toBeUndefined()
      expect(stopped.time.completed).toBeNumber()
    }),
  )

  it.effect("lets an already-started workflow continue after its teammate pauses", () =>
    Effect.gen(function* () {
      const fixture = yield* claimDuty("running-owner", {
        version: 1,
        steps: [
          { id: "first", name: "Review", type: "agent", prompt: "Review" },
          { id: "second", name: "Report", type: "agent", prompt: "Report" },
        ],
        delivery: { type: "turen" },
      })
      yield* fixture.loop.startRun({ ...fixture.start, currentStep: 0 })
      yield* fixture.team.editTeammate({ id: fixture.mate.id, status: "paused" })
      yield* fixture.loop.completeRunStep({
        id: fixture.run.id,
        owner: fixture.start.owner,
        currentStep: 0,
        stepID: "first",
        output: { text: "Reviewed", artifacts: [] },
      })
      expect((yield* fixture.loop.startRun({ ...fixture.start, currentStep: 1 })).status).toBe("running")
      yield* fixture.loop.completeRunStep({
        id: fixture.run.id,
        owner: fixture.start.owner,
        currentStep: 1,
        stepID: "second",
        output: { text: "Reported", artifacts: [] },
      })
      expect(
        (yield* fixture.loop.finishRun({ id: fixture.run.id, owner: fixture.start.owner, status: "succeeded" })).status,
      ).toBe("succeeded")
    }),
  )

  it.effect("checks the admitted duty owner after reassignment", () =>
    Effect.gen(function* () {
      const fixture = yield* claimDuty("moved-owner")
      const replacement = yield* fixture.team.createTeammate({
        name: "Rae",
        handle: "rae",
        role: "Analyst",
        mission: "Review",
      })
      yield* fixture.team.attachDuty({ teammateID: replacement.id, loopID: fixture.duty.id })
      yield* fixture.team.editTeammate({ id: fixture.mate.id, status: "paused" })
      expect(yield* fixture.loop.startRun(fixture.start).pipe(Effect.flip)).toBeInstanceOf(Loop.InvalidStateError)
      expect((yield* fixture.loop.getRun({ id: fixture.run.id })).status).toBe("cancelled")
    }),
  )

  it.effect("creates multiple duties atomically without importing extra teammates", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const loop = yield* Loop.Service
      const mate = yield* team.createTeammate({ name: "Moss", handle: "moss", role: "Analyst", mission: "Review" })
      const first = yield* loop.create({
        teammateID: mate.id,
        name: "Dependencies",
        prompt: "Review",
        intervalSeconds: 3600,
      })
      yield* loop.create({ teammateID: mate.id, name: "Changes", prompt: "Review", intervalSeconds: 3600 })
      const state = yield* team.state()
      expect(state.teammates).toHaveLength(1)
      expect(state.duties).toHaveLength(2)
      expect(state.duties.every((duty) => duty.teammateID === mate.id)).toBe(true)
      expect((yield* team.teammateForDuty(first.id))?.id).toBe(mate.id)
      yield* team.editTeammate({ id: mate.id, status: "paused" })
      expect(
        (yield* loop.create({ teammateID: mate.id, name: "Paused", prompt: "Review", intervalSeconds: 3600 })).status,
      ).toBe("paused")
      const before = (yield* loop.list()).length
      expect(
        yield* loop
          .create({ teammateID: "missing", name: "Invalid", prompt: "Review", intervalSeconds: 3600 })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Loop.InvalidInputError)
      expect((yield* loop.list()).length).toBe(before)
    }),
  )

  it.effect("creates a teammate and appends mention tasks once per message retry", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const mate = yield* team.createTeammate({
        name: "Rae",
        handle: "rae",
        role: "Builder",
        mission: "Review changes",
      })
      const post = { id: "msg_team_retry", text: "Please help @rae and @rae" }
      const first = yield* team.postMessage(post)
      const retry = yield* team.postMessage(post)
      expect(first.tasks).toHaveLength(1)
      expect(retry.tasks).toEqual(first.tasks)
      expect((yield* team.state()).messages.map((message) => message.seq)).toEqual([1])
      expect((yield* team.getTeammate(mate.id)).handle).toBe("rae")
    }),
  )

  it.effect("pages messages by sequence and rejects conflicting message retries", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const room = yield* team.createRoom({ name: "paging-room" })
      yield* team.createTeammate({
        roomID: room.id,
        name: "Reader",
        handle: "reader",
        role: "Reader",
        mission: "Read messages",
      })
      for (const id of ["msg_page_1", "msg_page_2", "msg_page_3"])
        yield* team.postMessage({ id, roomID: room.id, text: `message ${id}` })
      const latest = yield* team.state({ roomID: room.id, limit: 2 })
      expect(latest.messages.map((message) => message.seq)).toEqual([2, 3])
      expect(latest.hasMore).toBe(true)
      const earlier = yield* team.state({ roomID: room.id, before: 3, limit: 2 })
      expect(earlier.messages.map((message) => message.seq)).toEqual([1, 2])
      const conflict = yield* team
        .postMessage({ id: "msg_page_2", roomID: room.id, text: "different content" })
        .pipe(Effect.flip)
      expect(conflict).toBeInstanceOf(TeamWorkspace.ConflictError)
    }),
  )

  it.effect("serializes concurrent posts, deduplicates retries, and skips paused teammates", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const mate = yield* team.createTeammate({ name: "Paused", handle: "paused", role: "Reviewer", mission: "Review" })
      yield* team.editTeammate({ id: mate.id, status: "paused" })
      const results = yield* Effect.all(
        [
          team.postMessage({ id: "msg_parallel", text: "@paused please review" }),
          team.postMessage({ id: "msg_parallel", text: "@paused please review" }),
          team.postMessage({ id: "msg_parallel_second", text: "plain room note" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0]?.message.seq).toBe(results[1]?.message.seq)
      expect(results[2]?.message.seq).not.toBe(results[0]?.message.seq)
      expect(results[0]?.tasks).toHaveLength(0)
      expect(
        (yield* team.state()).messages.some((message) => message.kind === "system" && message.text.includes("@paused")),
      ).toBe(true)
    }),
  )

  it.effect("claims at most one active task per teammate across concurrent claimers", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      yield* team.createTeammate({ name: "Serial", handle: "serial", role: "Worker", mission: "Work" })
      yield* team.postMessage({ id: "msg_serial_1", text: "@serial first" })
      yield* team.postMessage({ id: "msg_serial_2", text: "@serial second" })
      const [left, right] = yield* Effect.all(
        [team.claimTasks({ owner: "worker-a" }), team.claimTasks({ owner: "worker-b" })],
        { concurrency: "unbounded" },
      )
      expect(left.length + right.length).toBe(1)
    }),
  )

  it.effect("returns a paused claimed task to the queue and starts it after resume", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const mate = yield* team.createTeammate({
        name: "Pause after claim",
        handle: "pauseclaim",
        role: "Worker",
        mission: "Wait",
      })
      const [{ id }] = (yield* team.postMessage({ id: "msg_pause_claim", text: "@pauseclaim wait" })).tasks
      yield* team.claimTasks({ owner: "worker" })
      yield* team.editTeammate({ id: mate.id, status: "paused" })
      expect((yield* team.startTask({ id, owner: "worker" })).status).toBe("queued")
      yield* team.editTeammate({ id: mate.id, status: "active" })
      yield* team.claimTasks({ owner: "worker-2" })
      expect((yield* team.startTask({ id, owner: "worker-2" })).status).toBe("running")
    }),
  )

  it.effect("does not let a busy teammate's queue starve an idle teammate", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      yield* team.createTeammate({ name: "Busy", handle: "busy", role: "Worker", mission: "Work" })
      yield* team.createTeammate({ name: "Idle", handle: "idle", role: "Worker", mission: "Work" })
      const [{ id: activeID }] = (yield* team.postMessage({ id: "msg_busy_active", text: "@busy active" })).tasks
      yield* team.claimTasks({ owner: "busy-owner" })
      yield* team.startTask({ id: activeID, owner: "busy-owner" })
      for (let index = 0; index < 31; index++)
        yield* team.postMessage({ id: `msg_busy_queue_${index}`, text: `@busy queued ${index}` })
      const [{ id: idleID }] = (yield* team.postMessage({ id: "msg_idle_task", text: "@idle available" })).tasks
      const claimed = yield* team.claimTasks({ owner: "idle-owner", limit: 31 })
      expect(claimed.map((task) => task.id)).toContain(idleID)
    }),
  )

  it.effect("reclaims expired claims and marks expired running tasks stale", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const mate = yield* team.createTeammate({ name: "Lease", handle: "lease", role: "Worker", mission: "Work" })
      const [{ id }] = (yield* team.postMessage({ id: "msg_lease", text: "@lease run" })).tasks
      const [claimed] = yield* team.claimTasks({ owner: "owner-a", leaseMs: 2000 })
      yield* Database.Service.use(({ db }) =>
        db.update(TeamTaskTable).set({ lease_expires_at: 0 }).where(eq(TeamTaskTable.id, id)).run().pipe(Effect.orDie),
      )
      const [reclaimed] = yield* team.claimTasks({ owner: "owner-b", leaseMs: 2000 })
      expect(reclaimed?.id).toBe(claimed?.id)
      yield* team.startTask({ id, owner: "owner-b" })
      yield* Database.Service.use(({ db }) =>
        db.update(TeamTaskTable).set({ lease_expires_at: 0 }).where(eq(TeamTaskTable.id, id)).run().pipe(Effect.orDie),
      )
      expect(yield* team.claimTasks({ owner: "owner-c" })).toHaveLength(0)
      expect((yield* team.getTask(id)).status).toBe("stale")
      expect(yield* team.tasksForTeammate(mate.id)).toHaveLength(0)
      expect((yield* team.state()).messages.some((message) => message.text.includes("was not replayed"))).toBe(true)
    }),
  )

  it.effect("finishes an owned claimed failure once and persists idle cancellation", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const mate = yield* team.createTeammate({ name: "Finish", handle: "finish", role: "Worker", mission: "Work" })
      const [{ id }] = (yield* team.postMessage({ id: "msg_finish", text: "@finish fail safely" })).tasks
      yield* team.claimTasks({ owner: "owner", leaseMs: 60_000 })
      const failed = yield* team.finishTask({ id, owner: "owner", status: "failed", error: "No agent configured" })
      const retry = yield* team.finishTask({ id, owner: "owner", status: "failed", error: "No agent configured" })
      expect(retry).toEqual(failed)
      expect((yield* team.state()).messages.filter((message) => message.replyTo === "msg_finish")).toHaveLength(1)
      const [{ id: queuedID }] = (yield* team.postMessage({ id: "msg_cancel", text: "@finish cancel" })).tasks
      expect((yield* team.cancelTask(queuedID)).status).toBe("cancelled")
      expect(yield* team.tasksForTeammate(mate.id)).toHaveLength(0)
    }),
  )

  it.effect("keeps an older running task visible beyond the recent task page", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      yield* team.createTeammate({ name: "Visible", handle: "visible", role: "Worker", mission: "Work" })
      const [{ id: activeID }] = (yield* team.postMessage({ id: "msg_old_active", text: "@visible keep working" }))
        .tasks
      yield* team.claimTasks({ owner: "active-owner" })
      yield* team.startTask({ id: activeID, owner: "active-owner" })
      for (let index = 0; index < 101; index++) {
        const [{ id }] = (yield* team.postMessage({ id: `msg_recent_${index}`, text: `@visible task ${index}` })).tasks
        yield* team.cancelTask(id)
      }
      expect((yield* team.state()).tasks.some((task) => task.id === activeID && task.status === "running")).toBe(true)
    }),
  )

  it.effect("keeps duty run attribution after a duty moves to another teammate", () =>
    Effect.gen(function* () {
      const team = yield* TeamWorkspace.Service
      const loops = yield* Loop.Service
      const original = yield* team.createTeammate({
        name: "Original",
        handle: "original",
        role: "Owner",
        mission: "Initial mission",
      })
      const replacement = yield* team.createTeammate({
        name: "Replacement",
        handle: "replacement",
        role: "Owner",
        mission: "New mission",
      })
      const loop = yield* loops.create({
        name: "Duty",
        prompt: "Do the duty",
        intervalSeconds: Loop.MIN_INTERVAL_SECONDS,
      })
      yield* team.attachDuty({ teammateID: original.id, loopID: loop.id })
      const run = yield* loops.runNow({ id: loop.id, owner: "manual" })
      const snapshot = yield* team.recordDutyRun({ runID: run.id, loopID: loop.id })
      yield* team.attachDuty({ teammateID: replacement.id, loopID: loop.id })
      const retry = yield* team.recordDutyRun({ runID: run.id, loopID: loop.id })
      expect(snapshot).toMatchObject({ id: original.id, mission: "Initial mission" })
      expect(retry).toEqual(snapshot)
      const persisted = yield* Database.Service.use(({ db }) =>
        db.select().from(TeamDutyTable).all().pipe(Effect.orDie),
      )
      const recorded = yield* Database.Service.use(({ db }) =>
        db.select().from(TeamDutyRunTable).all().pipe(Effect.orDie),
      )
      expect(persisted.find((duty) => duty.loop_id === loop.id)?.teammate_id).toBe(replacement.id)
      expect(recorded.find((entry) => entry.run_id === run.id)?.teammate_id).toBe(original.id)
    }),
  )
})
