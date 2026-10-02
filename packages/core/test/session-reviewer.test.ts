import { describe, expect, test } from "bun:test"
import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import { AgentV2 } from "@turenlabs/core/agent"
import { Config } from "@turenlabs/core/config"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { EventV2 } from "@turenlabs/core/event"
import { Global } from "@turenlabs/core/global"
import { Location } from "@turenlabs/core/location"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationServices } from "@turenlabs/core/location-services"
import { ProjectV2 } from "@turenlabs/core/project"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionCreation } from "@turenlabs/core/session/creation"
import { SessionHarness } from "@turenlabs/core/session/harness"
import {
  harnessSelfModificationEnabled,
  harnessSelfModificationGloballyEnabled,
  parseReviewerReply,
  SessionReviewer,
} from "@turenlabs/core/session/reviewer"
import { DateTime, Deferred, Duration, Effect, Fiber, Layer, LayerMap, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SessionEvent } from "@turenlabs/core/session/event"
import { SessionV1 } from "@turenlabs/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

describe("automatic Harness reviewer replies", () => {
  test("keeps automatic self-modification disabled unless explicitly enabled", () => {
    const document = (value: unknown) => {
      const decoded = Config.decodeDocument(JSON.stringify(value))
      if (!decoded) throw new Error("expected a valid config document")
      return decoded
    }
    const directory = new Config.Directory({ type: "directory", path: AbsolutePath.make("/project") })

    expect(harnessSelfModificationEnabled([])).toBe(false)
    expect(harnessSelfModificationEnabled([document({})])).toBe(false)
    expect(
      harnessSelfModificationEnabled([document({ agent: {}, experimental: { harness_self_modification: true } })]),
    ).toBe(true)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        document({ experimental: { policies: [] } }),
      ]),
    ).toBe(true)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        document({ experimental: { harness_self_modification: false } }),
      ]),
    ).toBe(false)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: false } }),
        document({ experimental: { harness_self_modification: true } }),
      ]),
    ).toBe(false)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        directory,
        document({ experimental: { harness_self_modification: false } }),
      ]),
    ).toBe(false)
    expect(
      harnessSelfModificationEnabled([
        document({ experimental: { harness_self_modification: true } }),
        directory,
        document({ experimental: { harness_self_modification: true } }),
      ]),
    ).toBe(true)
    expect(
      harnessSelfModificationGloballyEnabled([
        document({ experimental: { harness_self_modification: false } }),
        document({ experimental: { harness_self_modification: true } }),
      ]),
    ).toBe(true)
    expect(
      harnessSelfModificationGloballyEnabled([
        document({ experimental: { harness_self_modification: true } }),
        directory,
        document({ experimental: {} }),
      ]),
    ).toBe(true)
  })

  test("skips historical and location scans until globally enabled", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "forge.json")
    await fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: false } }))

    let sessionScans = 0
    const scans = () => sessionScans
    let locationAcquisitions = 0
    const startupOrder: string[] = []
    const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
    const session = SessionV2.Info.make({
      id: SessionV2.ID.make("ses_reviewer_startup"),
      projectID: ProjectV2.ID.global,
      agent: AgentV2.ID.make("build"),
      title: "Reviewer startup test",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(Date.now()) },
      location,
    })
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(() => {
        locationAcquisitions++
        return Layer.mock(Config.Service, {
          entries: () =>
            Effect.succeed([
              Config.decodeDocument(JSON.stringify({ experimental: { harness_self_modification: true } }))!,
            ]),
        }) as Layer.Layer<LocationServices>
      }),
    )
    const events = Layer.mock(EventV2.Service, {
      subscribe: () => Stream.empty,
      listen: () =>
        Effect.sync(() => {
          startupOrder.push("listen")
          return Effect.void
        }),
    })
    const unused = () => Effect.die("unused SessionV2 test method")
    const sessions = Layer.mock(SessionV2.Service, {
      list: () =>
        Effect.sync(() => {
          startupOrder.push("list")
          sessionScans++
          return [session]
        }),
      get: () => Effect.succeed(session),
      goal: { get: unused, set: unused, edit: unused, status: unused, clear: unused },
      revert: { stage: unused, clear: unused, commit: unused },
    })
    const layer = AppNodeBuilder.build(SessionReviewer.node, [
      [EventV2.node, events],
      [LocationServiceMap.node, locations],
      [SessionCreation.node, Layer.mock(SessionCreation.Service, {})],
      [SessionV2.node, sessions],
      [SessionHarness.node, Layer.mock(SessionHarness.Service, {})],
      [Global.node, Global.layerWith({ config: tmp.path })],
    ])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reviewer = yield* SessionReviewer.Service
          expect(sessionScans).toBe(0)
          expect(locationAcquisitions).toBe(0)
          expect(startupOrder).toEqual(["listen"])

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: true } })),
          )
          yield* reviewer.refresh()
          expect(sessionScans).toBe(1)
          // The scan only adopts existing reviewer children; it never starts a review for the
          // recent-session backlog, so no Location graph is acquired.
          expect(locationAcquisitions).toBe(0)
          expect(startupOrder).toEqual(["listen", "list"])

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: false } })),
          )
          yield* reviewer.refresh()
          expect(sessionScans).toBe(1)

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: true } })),
          )
          yield* reviewer.refresh()
          expect(sessionScans).toBe(2)
          expect(locationAcquisitions).toBe(0)

          yield* Effect.promise(() =>
            fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: false } })),
          )
          yield* reviewer.refresh()
          const persisted = yield* Deferred.make<void>()
          const blocked = yield* Deferred.make<void>()
          const enabling = yield* reviewer
            .withConfigTransition(
              Effect.gen(function* () {
                yield* Effect.promise(() =>
                  fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: true } })),
                )
                yield* Deferred.succeed(persisted, undefined)
                yield* Deferred.await(blocked)
              }),
              { invalidate: true },
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(persisted)
          yield* Fiber.interrupt(enabling)
          for (let attempt = 0; attempt < 100 && scans() < 3; attempt++) yield* Effect.yieldNow
          expect(sessionScans).toBe(3)
          expect(locationAcquisitions).toBe(0)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("preserves the complete guidance replacement list", () => {
    const guidance = Array.from({ length: 18 }, (_, index) => ({
      appliesTo: `src/file-${index}.ts`,
      directive: `Keep directive ${index} short and concrete.`,
    }))
    const result = parseReviewerReply(
      JSON.stringify({
        decision: "proposal",
        baseVersion: 16,
        summary: "Keep the next turn aligned with the confirmed defect.",
        guidance,
      }),
    )

    expect(result.kind).toBe("proposal")
    if (result.kind !== "proposal") throw new Error("expected a proposal")
    expect(result.proposal.changes).toEqual([])
    expect(result.proposal.guidance).toHaveLength(18)
    expect(result.proposal.guidance?.[0]?.appliesTo).toBe("src/file-0.ts")
    expect(result.proposal.guidance?.at(-1)?.appliesTo).toBe("src/file-17.ts")
  })

  test("accepts a guidance-only proposal without changes", () => {
    const result = parseReviewerReply(
      JSON.stringify({
        decision: "proposal",
        baseVersion: 1,
        summary: "Reuse the established baseline.",
        guidance: [{ appliesTo: "src/mem.rs", directive: "Diff against the baseline before editing." }],
      }),
    )

    expect(result.kind).toBe("proposal")
    if (result.kind !== "proposal") throw new Error("expected a proposal")
    expect(result.proposal.changes).toEqual([])
  })

  test("recognizes an explicit no-op reply", () => {
    expect(parseReviewerReply('{"decision":"none"}')).toEqual({ kind: "declined" })
  })
})

// Test doubles implement only the service methods the reviewer calls.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- partial service doubles.
const partial = (value: unknown): never => value as never

const REVIEWER_ID = SessionV2.ID.make("ses_reviewer_child")
const PARENT_ID = SessionV2.ID.make("ses_reviewer_parent")
const DEBOUNCE = "3 minutes"

// Drives the real reviewer against mocked session, event and harness services. The listener the
// reviewer registers is captured so a test can publish events and advance the TestClock.
const setup = (options: { readonly archived?: boolean } = {}) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "reviewer-test-"))),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    )
    const configPath = path.join(dir, "forge.json")
    const writeGate = (enabled: boolean) =>
      Effect.promise(() =>
        fs.writeFile(configPath, JSON.stringify({ experimental: { harness_self_modification: enabled } })),
      )
    yield* writeGate(true)

    const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
    const info = (id: string, extra: Partial<SessionV2.Info> = {}) =>
      SessionV2.Info.make({
        id: SessionV2.ID.make(id),
        projectID: ProjectV2.ID.global,
        agent: AgentV2.ID.make("build"),
        title: "Reviewer test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(Date.now()) },
        location,
        ...extra,
      })
    const state = {
      parent: info(
        PARENT_ID,
        options.archived
          ? {
              time: {
                created: DateTime.makeUnsafe(0),
                updated: DateTime.makeUnsafe(Date.now()),
                archived: DateTime.makeUnsafe(1),
              },
            }
          : {},
      ),
      child: info("ses_not_a_root", { parentID: PARENT_ID }),
      prompts: [] as string[],
      runs: [] as string[],
      creates: 0,
      busy: false,
      queued: false,
      failPrompts: false,
      // While set, a prompt blocks until the gate opens, so a test can overlap a review with new activity.
      hold: undefined as undefined | Deferred.Deferred<void>,
      started: 0,
      transcript: [] as ReadonlyArray<unknown>,
      listener: undefined as undefined | ((event: never) => Effect.Effect<void>),
    }
    const reviewerInfo = info(REVIEWER_ID, {
      parentID: PARENT_ID,
      title: "Automatic Harness reviewer",
      agent: AgentV2.ID.make("harness-reviewer"),
    })
    const unused = () => Effect.die("unused SessionV2 test method")
    const sessions = Layer.mock(
      SessionV2.Service,
      partial({
        list: () => Effect.succeed([]),
        get: (id: string) =>
          id.startsWith("ses_other_")
            ? Effect.succeed(info(id))
            : id === state.parent.id
              ? Effect.succeed(state.parent)
              : id === state.child.id
                ? Effect.succeed(state.child)
                : id === REVIEWER_ID
                  ? Effect.succeed(reviewerInfo)
                  : Effect.die(`unexpected session ${id}`),
        context: () => Effect.succeed(partial(state.transcript)),
        active: Effect.sync(() => new Set(state.busy ? [state.parent.id] : [])),
        pendingInputs: () => Effect.succeed(state.queued ? [{}] : []),
        prompt: (input: { readonly prompt: { readonly text: string } }) =>
          Effect.gen(function* () {
            const hold = state.hold
            if (hold) {
              state.started++
              yield* Deferred.await(hold)
            }
            if (state.failPrompts) {
              yield* Effect.die(new Error("provider unavailable"))
            }
            state.prompts.push(input.prompt.text)
          }),
        resumePending: () => Effect.void,
        messages: () => Effect.succeed([]),
        interrupt: () => Effect.void,
        goal: { get: unused, set: unused, edit: unused, status: unused, clear: unused },
        revert: { stage: unused, clear: unused, commit: unused },
      }),
    )
    const events = Layer.mock(
      EventV2.Service,
      partial({
        subscribe: () => Stream.empty,
        listen: (listener: (event: never) => Effect.Effect<void>) =>
          Effect.sync(() => {
            state.listener = listener
            return Effect.void
          }),
      }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          Layer.mock(Config.Service, {
            entries: () =>
              Effect.succeed([
                Config.decodeDocument(JSON.stringify({ experimental: { harness_self_modification: true } }))!,
              ]),
          }) as Layer.Layer<LocationServices>,
      ),
    )
    const creation = Layer.mock(
      SessionCreation.Service,
      partial({
        create: () =>
          Effect.sync(() => {
            state.creates++
            return reviewerInfo
          }),
      }),
    )
    const harness = Layer.mock(
      SessionHarness.Service,
      partial({
        get: () => Effect.succeed(partial({ snapshot: null, proposals: [], reviewerRequests: [], reviewerRuns: [] })),
        recordRun: (input: { readonly outcome: string }) =>
          Effect.sync(() => {
            state.runs.push(input.outcome)
          }),
      }),
    )
    const layer = AppNodeBuilder.build(SessionReviewer.node, [
      [EventV2.node, events],
      [LocationServiceMap.node, locations],
      [SessionCreation.node, creation],
      [SessionV2.node, sessions],
      [SessionHarness.node, harness],
      [Global.node, Global.layerWith({ config: dir })],
    ])
    const built = yield* Layer.build(layer)
    const reviewer = yield* Effect.gen(function* () {
      return yield* SessionReviewer.Service
    }).pipe(Effect.provide(built))
    const listener = state.listener
    if (!listener) throw new Error("the reviewer did not register an event listener")

    // Let forked fibers and mock effects run to completion after the clock moves.
    const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })
    const advance = (duration: Duration.Input) => TestClock.adjust(duration).pipe(Effect.andThen(settle))
    const emit = (type: string, data: Record<string, unknown>) =>
      listener(partial({ type, data })).pipe(Effect.andThen(settle))
    const stepEnded = (sessionID: string = PARENT_ID) => emit(SessionEvent.Step.Ended.type, { sessionID })
    const stepStarted = (sessionID: string = PARENT_ID) => emit(SessionEvent.Step.Started.type, { sessionID })
    return { state, reviewer, writeGate, advance, emit, stepEnded, stepStarted, info }
  })

describe("automatic Harness reviewer cadence", () => {
  it.effect("does not start a review on session creation or prompt admission", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      yield* t.emit(SessionV1.Event.Created.type, { sessionID: PARENT_ID, info: {} })
      yield* t.emit(SessionEvent.PromptAdmitted.type, { sessionID: PARENT_ID })
      yield* t.advance("10 minutes")
      expect(t.state.prompts).toHaveLength(0)
    }),
  )

  it.effect("reviews once after the debounce when the session goes quiet", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      yield* t.stepEnded()
      yield* t.advance("2 minutes")
      expect(t.state.prompts).toHaveLength(0)
      yield* t.advance("1 minute")
      expect(t.state.prompts).toHaveLength(1)
      yield* t.advance("2 hours")
      expect(t.state.prompts).toHaveLength(1)
      expect(t.state.runs).toEqual(["unparseable"])
    }),
  )

  it.effect("a new step within the debounce window cancels the review", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      yield* t.stepEnded()
      yield* t.advance("179 seconds")
      yield* t.stepStarted()
      yield* t.advance("10 minutes")
      expect(t.state.prompts).toHaveLength(0)
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(1)
    }),
  )

  it.effect("restarts the debounce on every terminal event", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      yield* t.stepEnded()
      yield* t.advance("2 minutes")
      yield* t.stepEnded()
      yield* t.advance("2 minutes")
      expect(t.state.prompts).toHaveLength(0)
      yield* t.advance("1 minute")
      expect(t.state.prompts).toHaveLength(1)
    }),
  )

  const settledTypes = [
    SessionEvent.Step.Ended.type,
    SessionEvent.Step.Failed.type,
    SessionEvent.Shell.Ended.type,
    SessionEvent.Compaction.Ended.type,
    SessionEvent.Compaction.Failed.type,
  ]
  const workingTypes = [
    SessionEvent.Step.Started.type,
    SessionEvent.Shell.Started.type,
    SessionEvent.Compaction.Started.type,
    SessionEvent.PromptAdmitted.type,
    SessionEvent.Retried.type,
  ]

  for (const type of settledTypes) {
    it.effect(`${type} arms the debounce`, () =>
      Effect.gen(function* () {
        const t = yield* setup()
        yield* t.emit(type, { sessionID: PARENT_ID })
        yield* t.advance("2 minutes")
        expect(t.state.prompts).toHaveLength(0)
        yield* t.advance("1 minute")
        expect(t.state.prompts).toHaveLength(1)
      }),
    )
  }

  for (const type of workingTypes) {
    it.effect(`${type} cancels a pending debounce`, () =>
      Effect.gen(function* () {
        const t = yield* setup()
        yield* t.stepEnded()
        yield* t.advance("2 minutes")
        yield* t.emit(type, { sessionID: PARENT_ID })
        yield* t.advance("10 minutes")
        expect(t.state.prompts).toHaveLength(0)
      }),
    )
  }

  it.effect("never reviews while the session is busy", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      t.state.busy = true
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(0)
      t.state.busy = false
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(1)
    }),
  )

  it.effect("skips an unchanged transcript and reviews a changed one", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(1)
      t.state.transcript = [{ type: "user", text: "a new request" }]
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(2)
    }),
  )

  it.effect("ignores child sessions", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      yield* t.stepEnded("ses_not_a_root")
      yield* t.advance("1 hour")
      expect(t.state.prompts).toHaveLength(0)
    }),
  )

  it.effect("archiving an unreviewed session reviews it immediately, once per digest", () =>
    Effect.gen(function* () {
      const t = yield* setup({ archived: true })
      const archive = { sessionID: PARENT_ID, info: { time: { archived: 1 } } }
      yield* t.emit(SessionV1.Event.Updated.type, archive)
      expect(t.state.prompts).toHaveLength(1)
      yield* t.emit(SessionV1.Event.Updated.type, archive)
      expect(t.state.prompts).toHaveLength(1)
      yield* t.emit(SessionV1.Event.Updated.type, { sessionID: PARENT_ID, info: { time: {} } })
      expect(t.state.prompts).toHaveLength(1)
      // An archived session is never reviewed through the debounce path.
      yield* t.stepEnded()
      yield* t.advance("1 hour")
      expect(t.state.prompts).toHaveLength(1)
    }),
  )

  it.effect("a failed review retries once after the backoff, not on every interval", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      t.state.failPrompts = true
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.runs).toEqual(["failed"])
      yield* t.advance("19 minutes")
      expect(t.state.runs).toEqual(["failed"])
      yield* t.advance("1 minute")
      expect(t.state.runs).toEqual(["failed", "failed"])
      yield* t.advance("3 hours")
      expect(t.state.runs).toEqual(["failed", "failed"])
    }),
  )

  it.effect("fresh activity cancels a pending retry", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      t.state.failPrompts = true
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      yield* t.stepStarted()
      yield* t.advance("1 hour")
      expect(t.state.runs).toEqual(["failed"])
    }),
  )

  it.effect("coalesces boundaries that arrive during a review into one follow-up", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      const hold = yield* Deferred.make<void>()
      t.state.hold = hold
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.started).toBe(1)
      t.state.transcript = [{ type: "user", text: "work done during the review" }]
      yield* t.stepStarted()
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.started).toBe(1)
      t.state.hold = undefined
      yield* Deferred.succeed(hold, undefined)
      yield* t.advance("1 second")
      expect(t.state.prompts).toHaveLength(2)
      expect(t.state.started).toBe(1)
    }),
  )

  it.effect("does not retry a review that fails after fresh activity", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      const hold = yield* Deferred.make<void>()
      t.state.hold = hold
      t.state.failPrompts = true
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      yield* t.stepStarted()
      yield* Deferred.succeed(hold, undefined)
      yield* t.advance("1 hour")
      expect(t.state.runs).toEqual(["failed"])
      expect(t.state.started).toBe(1)
    }),
  )

  it.effect("does not retry a review that fails after a config refresh", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      const hold = yield* Deferred.make<void>()
      t.state.hold = hold
      t.state.failPrompts = true
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      yield* t.reviewer.refresh()
      yield* Deferred.succeed(hold, undefined)
      yield* t.advance("1 hour")
      expect(t.state.runs).toEqual(["failed"])
      expect(t.state.started).toBe(1)
    }),
  )

  it.effect("no review while the Session has queued input", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      t.state.queued = true
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(0)
      t.state.queued = false
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(1)
    }),
  )

  it.effect("fresh activity invalidates a coalesced follow-up", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      const hold = yield* Deferred.make<void>()
      t.state.hold = hold
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      t.state.transcript = [{ type: "user", text: "more work" }]
      yield* t.stepStarted()
      yield* t.stepEnded()
      t.state.hold = undefined
      yield* Deferred.succeed(hold, undefined)
      yield* t.advance("1 second")
      expect(t.state.prompts).toHaveLength(1)
      yield* t.advance(DEBOUNCE)
      expect(t.state.prompts).toHaveLength(2)
    }),
  )

  it.effect("a retry waiting for a review permit is dropped by fresh activity", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      t.state.failPrompts = true
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.runs).toEqual(["failed"])
      yield* t.advance("10 minutes")
      // Ten other sessions hold every review permit, so the retry fires at 23 minutes but cannot start.
      const hold = yield* Deferred.make<void>()
      t.state.hold = hold
      t.state.failPrompts = false
      for (let index = 0; index < 10; index++) yield* t.stepEnded(`ses_other_${index}`)
      yield* t.advance(DEBOUNCE)
      expect(t.state.started).toBe(10)
      yield* t.advance("8 minutes")
      yield* t.stepStarted()
      t.state.hold = undefined
      yield* Deferred.succeed(hold, undefined)
      yield* t.advance("1 second")
      expect(t.state.prompts.filter((prompt) => prompt.includes(PARENT_ID))).toHaveLength(0)
      expect(t.state.runs.filter((run) => run === "failed")).toEqual(["failed"])
    }),
  )

  it.effect("a debounced review waiting for a review permit is dropped by fresh activity", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      const hold = yield* Deferred.make<void>()
      t.state.hold = hold
      for (let index = 0; index < 10; index++) yield* t.stepEnded(`ses_other_${index}`)
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.started).toBe(10)
      yield* t.stepStarted()
      t.state.hold = undefined
      yield* Deferred.succeed(hold, undefined)
      yield* t.advance("1 second")
      expect(t.state.prompts.filter((prompt) => prompt.includes(PARENT_ID))).toHaveLength(0)
    }),
  )

  it.effect("a debounced review waiting for a review permit is dropped by a config refresh", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      const hold = yield* Deferred.make<void>()
      t.state.hold = hold
      for (let index = 0; index < 10; index++) yield* t.stepEnded(`ses_other_${index}`)
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      expect(t.state.started).toBe(10)
      yield* t.reviewer.refresh()
      t.state.hold = undefined
      yield* Deferred.succeed(hold, undefined)
      yield* t.advance("1 second")
      expect(t.state.prompts.filter((prompt) => prompt.includes(PARENT_ID))).toHaveLength(0)
    }),
  )

  it.effect("disabling the global gate cancels pending debounced reviews", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      yield* t.stepEnded()
      yield* t.advance("1 minute")
      yield* t.writeGate(false)
      yield* t.reviewer.refresh()
      yield* t.advance("1 hour")
      expect(t.state.prompts).toHaveLength(0)
    }),
  )

  it.effect("keeps the review prompt bounded for a long transcript and keeps the last user prompt", () =>
    Effect.gen(function* () {
      const t = yield* setup()
      const stamp = DateTime.makeUnsafe(0)
      t.state.transcript = Array.from({ length: 200 }, (_, index) => ({
        type: index % 2 === 0 ? "user" : "system",
        id: `msg_${index}`,
        text: index === 198 ? `final request ${"x".repeat(5_000)}` : "y".repeat(500),
        time: { created: stamp },
      }))
      yield* t.stepEnded()
      yield* t.advance(DEBOUNCE)
      const prompt = t.state.prompts[0] ?? ""
      expect(prompt).toContain("Last user prompt: final request")
      expect(prompt.length).toBeLessThan(10_000)
    }),
  )
})
