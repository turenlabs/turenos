/**
 * Subagent fleet test harness: fixtures, task drivers, fleet invariants, and a
 * seeded fuzzer over the real durable task service and an in-memory database.
 *
 * Drivers act the way production does: `spawnFrom` records the tool call a spawn
 * must trace back to, and `finish` consumes the child's prompt before settling,
 * exactly as the execution drain would.
 */
import { expect } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AgentV2 } from "@turenlabs/core/agent"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { Location } from "@turenlabs/core/location"
import { ModelV2 } from "@turenlabs/core/model"
import { PermissionV2 } from "@turenlabs/core/permission"
import { PermissionChecks } from "@turenlabs/core/permission-checks"
import { PermissionSaved } from "@turenlabs/core/permission/saved"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProjectTable } from "@turenlabs/core/project/sql"
import { ProviderV2 } from "@turenlabs/core/provider"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionInput } from "@turenlabs/core/session/input"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { SessionProjector } from "@turenlabs/core/session/projector"
import { SessionSchema } from "@turenlabs/core/session/schema"
import { SessionTable } from "@turenlabs/core/session/sql"
import { SessionStore } from "@turenlabs/core/session/store"
import { SessionTaskV2 } from "@turenlabs/core/session/task"
import { SessionTaskOperationTable } from "@turenlabs/core/session/task.sql"
import { Storage } from "@turenlabs/core/storage"
import { TeamBoard } from "@turenlabs/core/team/board"
import { location } from "../fixture/location"

// Fixtures

export const directory = AbsolutePath.make("/project")

export const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("model"),
})

/**
 * The real task service with real permission evaluation over a fresh in-memory
 * database. Each `Effect.provide` builds a new database, so a fuzz seed provided
 * with it cannot see another seed's tasks.
 */
export const fleetLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Storage.node,
    EventV2.node,
    SessionProjector.node,
    SessionStore.node,
    SessionCreation.node,
    SessionTaskV2.node,
    TeamBoard.node,
    AgentV2.node,
    PermissionChecks.node,
    PermissionSaved.node,
    PermissionV2.node,
  ]),
  [
    [
      ProjectV2.node,
      Layer.succeed(
        ProjectV2.Service,
        ProjectV2.Service.of({
          resolve: (input) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
          directories: () => Effect.succeed([]),
          remember: () => Effect.void,
        }),
      ),
    ],
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
  ],
)

/** Read-only authority for a direct child of the root; spread it to grant more. */
export const authority = SessionTaskV2.Authority.make({
  parentPermissions: [{ action: "*", resource: "*", effect: "allow" }],
  ancestorPermissionSets: [],
  childPermissions: [{ action: "edit", resource: "*", effect: "allow" }],
  hardPermissions: [{ action: "edit", resource: "*", effect: "deny" }],
  writeRoots: [directory],
  commands: ["bun test"],
})

export const orchestrating = SessionTaskV2.Authority.make({ ...authority, orchestrate: true })

/** Creates a root Session and returns its ID. */
export const setup = Effect.fnUntraced(function* (suffix: string) {
  const { db } = yield* Database.Service
  const rootSessionID = SessionSchema.ID.make(`ses_fleet_${suffix}`)
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: rootSessionID,
      project_id: ProjectV2.ID.global,
      slug: suffix,
      directory,
      title: suffix,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return rootSessionID
})

/** Records the tool call a task operation must trace back to, and returns its actor. */
export const actor = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  suffix: string,
  tool: "spawn_agent" | "spawn_agents" | "send_agent" | "interrupt_agent" = "spawn_agent",
) {
  const assistantMessageID = SessionMessage.ID.make(`msg_fleet_${suffix}`)
  const callID = `call_${suffix}`
  const events = yield* EventV2.Service
  const timestamp = yield* DateTime.now
  yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp, agent: "build", model })
  yield* events.publish(SessionEvent.Tool.Input.Started, {
    sessionID,
    assistantMessageID,
    callID,
    timestamp,
    name: tool,
  })
  yield* events.publish(SessionEvent.Tool.Input.Ended, { sessionID, assistantMessageID, callID, timestamp, text: "{}" })
  yield* events.publish(SessionEvent.Tool.Called, {
    sessionID,
    assistantMessageID,
    callID,
    timestamp,
    tool,
    input: {},
    provider: { executed: false },
  })
  return SessionTaskV2.Actor.make({ sessionID, assistantMessageID, toolCallID: callID })
})

export const spawnInput = (
  actor: SessionTaskV2.Actor,
  suffix: string,
  activeLimit?: number,
): SessionTaskV2.SpawnInput => ({
  actor,
  agent: AgentV2.ID.make("explore"),
  model,
  prompt: Prompt.make({ text: `Inspect ${suffix}` }),
  description: `Task ${suffix}`,
  authority,
  ...(activeLimit === undefined ? {} : { activeLimit }),
})

// Drivers

/**
 * Spawns from any Session: the root for direct children, an orchestrator's child
 * Session for its workers. The test clock is frozen, so each spawn advances it
 * and queue order follows creation time rather than SQLite's tie-breaking.
 */
export const spawnFrom = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  suffix: string,
  activeLimit: number,
  overrides: Partial<SessionTaskV2.SpawnInput> = {},
) {
  const tasks = yield* SessionTaskV2.Service
  yield* TestClock.adjust("1 millis")
  return yield* tasks.spawn({ ...spawnInput(yield* actor(sessionID, suffix), suffix, activeLimit), ...overrides })
})

/** Ends a task's run the way the execution drain does: consume its prompt, then settle. */
export const finish = Effect.fnUntraced(function* (
  task: SessionTaskV2.Info,
  status: "completed" | "failed" = "completed",
) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const tasks = yield* SessionTaskV2.Service
  yield* SessionInput.promoteSteers(db, events, task.childSessionID, Number.MAX_SAFE_INTEGER)
  return yield* tasks.settleRun({ sessionID: task.childSessionID, status })
})

/** Cancels a task on behalf of its root; no execution is running to stop. */
export const cancel = (task: SessionTaskV2.Info) =>
  SessionTaskV2.Service.use((tasks) =>
    tasks.cancelWithInterrupt({ sessionID: task.rootSessionID, taskID: task.id, interrupt: () => Effect.void }),
  )

// Invariants

const contains = (root: string, target: string) => target === root || target.startsWith(`${root}/`)

/**
 * Checks what must hold for every fleet state at rest, whatever sequence
 * produced it, and returns each violation as `<invariant>: <detail>`.
 * "At rest" means promotion has run since the last change, as the driver would.
 */
export const violations = Effect.fnUntraced(function* (rootSessionID: SessionSchema.ID, activeLimit: number) {
  const tasks = yield* SessionTaskV2.Service
  const { db } = yield* Database.Service
  const all = yield* tasks.list({ rootSessionID })
  const byID = new Map(all.map((task) => [task.id, task]))
  const active = all.filter((task) => task.status === "starting" || task.status === "running")
  const queued = all.filter((task) => task.status === "queued")
  const quota = SessionTaskV2.orchestratorLimit(activeLimit)
  const orchestrators = active.filter((task) => task.authority.orchestrate === true).length
  const found: string[] = []

  if (active.length > activeLimit) found.push(`active-limit: ${active.length} active, limit ${activeLimit}`)
  if (orchestrators > quota) found.push(`orchestrator-quota: ${orchestrators} orchestrators active, quota ${quota}`)
  if (
    active.length < activeLimit &&
    queued.some((task) => task.authority.orchestrate !== true || orchestrators < quota)
  )
    found.push(`promotion: ${active.length} of ${activeLimit} slots used while eligible work is queued`)

  // Only a queued task may still owe its spawn; anything else settled or started it.
  const pending = yield* db
    .select({ taskID: SessionTaskOperationTable.task_id })
    .from(SessionTaskOperationTable)
    .where(
      and(
        eq(SessionTaskOperationTable.root_session_id, rootSessionID),
        eq(SessionTaskOperationTable.kind, "spawn"),
        eq(SessionTaskOperationTable.status, "pending"),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  found.push(
    ...pending
      .filter((row) => byID.get(row.taskID)?.status !== "queued")
      .map((row) => `pending-spawn: ${row.taskID} is ${byID.get(row.taskID)?.status} with its spawn still pending`),
  )

  const sessions = new Set(
    all.length === 0
      ? []
      : (yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(
            inArray(
              SessionTable.id,
              all.map((task) => task.childSessionID),
            ),
          )
          .all()
          .pipe(Effect.orDie)).map((row) => row.id),
  )
  all.forEach((task) => {
    if (task.status === "starting") found.push(`starting: ${task.id} is still starting at rest`)
    const session = sessions.has(task.childSessionID)
    if (task.status === "running" && !session) found.push(`child-session: ${task.id} runs without a Session`)
    if (task.status === "queued" && session) found.push(`child-session: ${task.id} is queued with a Session`)
    const parent = task.parentTaskID ? byID.get(task.parentTaskID) : undefined
    if (task.depth === 1 ? task.parentTaskID !== undefined : parent?.authority.orchestrate !== true)
      found.push(`depth: ${task.id} at depth ${task.depth} has parent task ${task.parentTaskID}`)
    if (!parent) return
    found.push(
      ...task.authority.commands
        .filter((command) => !parent.authority.commands.includes(command))
        .map((command) => `grant: ${task.id} widens its orchestrator's commands with "${command}"`),
      ...task.authority.writeRoots
        .filter((root) => !parent.authority.writeRoots.some((allowed) => contains(allowed, root)))
        .map((root) => `grant: ${task.id} widens its orchestrator's write roots with ${root}`),
    )
  })

  const counts = yield* tasks.counts({ rootSessionID })
  const expected = {
    queued: queued.length,
    active: active.length,
    terminal: all.length - queued.length - active.length,
  }
  if (counts.queued !== expected.queued || counts.active !== expected.active || counts.terminal !== expected.terminal)
    found.push(`counts: ${JSON.stringify(counts)} but tasks show ${JSON.stringify(expected)}`)
  return found
})

export const expectInvariants = (rootSessionID: SessionSchema.ID, activeLimit: number) =>
  violations(rootSessionID, activeLimit).pipe(Effect.map((found) => expect(found).toEqual([])))

// Fuzzer

export type FuzzFailure = {
  readonly seed: number
  readonly limit: number
  readonly step: number
  readonly problems: ReadonlyArray<string>
  readonly trail: ReadonlyArray<string>
}

type Operation = {
  readonly name: string
  readonly run: Effect.Effect<string, unknown, Database.Service | EventV2.Service | SessionTaskV2.Service>
  /** Typed failure tags this operation may legitimately return, by prefix. */
  readonly allowed?: ReadonlyArray<string>
}

const writeRoots = ["/project", "/project/src", "/project/src/lib", "/project/docs"].map((root) =>
  AbsolutePath.make(root),
)
const commands = ["bun test", "bun run lint", "git status"]

/**
 * Applies one seeded random operation per step to one root, the way tool calls,
 * settles, cancellation, and restarts interleave in production. After each step
 * it promotes as the driver would, then checks every invariant. Stops at the
 * first problem and returns it with the recent operations; undefined when clean.
 */
const fuzzSeed = Effect.fnUntraced(function* (seed: number, steps: number) {
  let state = seed
  // mulberry32: small, fast, and reproducible from the seed alone.
  const random = () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: ReadonlyArray<T>) => items[Math.floor(random() * items.length)]
  const subset = <T>(items: ReadonlyArray<T>) => items.filter(() => random() < 0.5)
  const limit = pick([2, 3, 4, 6])
  const rootSessionID = yield* setup(`fuzz_${seed}`)
  const tasks = yield* SessionTaskV2.Service
  const spawned: Array<{ readonly input: SessionTaskV2.SpawnInput; readonly taskID: SessionTaskV2.ID }> = []
  const trail: string[] = []
  const isActive = (task: SessionTaskV2.Info) => task.status === "starting" || task.status === "running"
  const isTerminal = (task: SessionTaskV2.Info) => !isActive(task) && task.status !== "queued"

  for (let step = 0; step < steps; step++) {
    yield* TestClock.adjust("1 millis")
    const all = yield* tasks.list({ rootSessionID })
    const byID = new Map(all.map((task) => [task.id, task]))
    const running = all.filter((task) => task.status === "running")
    const orchestrators = running.filter((task) => task.authority.orchestrate === true)
    const suffix = `fuzz_${seed}_${step}`
    const spawn = (input: SessionTaskV2.SpawnInput, label: string) =>
      tasks.spawn(input).pipe(
        Effect.tap((prepared) => Effect.sync(() => spawned.push({ input, taskID: prepared.task.id }))),
        Effect.map((prepared) => `${label} ${prepared.task.id} -> ${prepared.task.status}`),
      )
    const roll = random()

    const operation: Operation = yield* Effect.gen(function* () {
      if (roll < 0.2) {
        const orchestrate = random() < 0.4 && SessionTaskV2.orchestratorLimit(limit) > 0
        const input = spawnInput(yield* actor(rootSessionID, suffix), suffix, limit)
        if (!orchestrate) return { name: "spawn task", run: spawn(input, "task") }
        return {
          name: "spawn orchestrator",
          run: spawn(
            {
              ...input,
              authority: SessionTaskV2.Authority.make({
                ...orchestrating,
                writeRoots: subset(writeRoots),
                commands: subset(commands),
              }),
            },
            "orchestrator",
          ),
        }
      }
      if (roll < 0.45 && orchestrators.length > 0) {
        const parent = pick(orchestrators)
        const widen = random() < 0.3
        const input = spawnInput(yield* actor(parent.childSessionID, suffix), suffix, limit)
        return {
          name: widen ? "spawn widened worker" : "spawn worker",
          run: spawn(
            {
              ...input,
              wave: `wave_${parent.id}`,
              authority: SessionTaskV2.Authority.make({
                ...authority,
                writeRoots: widen
                  ? [pick(writeRoots)]
                  : subset(
                      writeRoots.filter((root) =>
                        parent.authority.writeRoots.some((allowed) => contains(allowed, root)),
                      ),
                    ),
                commands: widen ? [pick(commands)] : subset(parent.authority.commands),
              }),
            },
            `worker of ${parent.id}`,
          ),
          // Admission rejects widening with a typed error.
          ...(widen ? { allowed: ["SessionTask."] } : {}),
        }
      }
      if (roll < 0.7 && running.length > 0) {
        const task = pick(running)
        const status = random() < 0.8 ? "completed" : "failed"
        return {
          name: `finish ${status}`,
          run: finish(task, status).pipe(Effect.map((settled) => `${task.id} -> ${settled?.task.status}`)),
        }
      }
      const open = all.filter((task) => !isTerminal(task))
      if (roll < 0.78 && open.length > 0) {
        const task = pick(open)
        return {
          name: "cancel",
          run: cancel(task).pipe(Effect.map((result) => `${task.id} (${task.status}) -> ${result.task.status}`)),
        }
      }
      const resumable = all.filter(
        (task) =>
          isTerminal(task) &&
          task.status !== "cancelled" &&
          (task.depth === 1 || byID.get(task.parentTaskID!)?.status === "running"),
      )
      if (roll < 0.86 && resumable.length > 0) {
        const task = pick(resumable)
        const sender = yield* actor(task.parentSessionID, suffix, "send_agent")
        return {
          name: "resume",
          run: tasks
            .send({ actor: sender, taskID: task.id, prompt: Prompt.make({ text: "Continue" }), activeLimit: limit })
            .pipe(Effect.map((prepared) => `${task.id} (${task.status}) -> ${prepared.task.status}`)),
          // Terminal orchestrators are quota-gated and never-started tasks are
          // rejected outright; both rejections are typed.
          allowed: [
            "SessionTask.ActiveLimitError",
            "SessionTask.OrchestrateError",
            "SessionTask.InvalidStateError",
          ],
        }
      }
      if (roll < 0.94 && spawned.length > 0) {
        const item = pick(spawned)
        return {
          name: "retry spawn",
          run: tasks
            .spawn(item.input)
            .pipe(
              Effect.flatMap((prepared) =>
                prepared.task.id === item.taskID
                  ? Effect.succeed(`${item.taskID} -> ${prepared.task.status}`)
                  : Effect.die(new Error(`retry of ${item.taskID} returned ${prepared.task.id}`)),
              ),
            ),
        }
      }
      return { name: "restart", run: tasks.reconcile().pipe(Effect.as("recovered")) }
    })

    const exit = yield* operation.run.pipe(Effect.exit)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    const outcome = Exit.isSuccess(exit) ? exit.value : `${Cause.hasDies(exit.cause) ? "defect " : ""}${String(error)}`
    trail.push(`${step} ${operation.name}: ${outcome}`)
    const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : ""
    const problems =
      Exit.isFailure(exit) &&
      (Cause.hasDies(exit.cause) || !operation.allowed?.some((prefix) => tag.startsWith(prefix)))
        ? [`${operation.name} failed: ${outcome}`]
        : []
    yield* tasks.promote(rootSessionID, limit)
    problems.push(...(yield* violations(rootSessionID, limit)))
    if (problems.length > 0) return { seed, limit, step, problems, trail: trail.slice(-8) } satisfies FuzzFailure
  }
  return undefined
})

/**
 * Runs each seed against its own database and returns every failure. Providing
 * `fleetLayer` again would reuse the test's memoized build, and restarts recover
 * every root in the database, so each seed builds the layer from a new MemoMap.
 */
export const fuzz = (input: { readonly seeds: ReadonlyArray<number>; readonly steps: number }) =>
  Effect.forEach(input.seeds, (seed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.buildWithMemoMap(fleetLayer, yield* Layer.makeMemoMap, yield* Effect.scope)
        return yield* fuzzSeed(seed, input.steps).pipe(Effect.provide(context))
      }),
    ),
  ).pipe(Effect.map((results) => results.filter((result) => result !== undefined)))
