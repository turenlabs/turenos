/**
 * Simulator suite: run-coordinator races on one Session, and isolation between Sessions.
 *
 * `SessionRunCoordinator` (src/session/run-coordinator.ts) is the whole concurrency story for a
 * Session: one `Entry` per key, an owner fiber, and a single `pendingWake` boolean. The three
 * behaviours these scenarios pin are the ones that are easy to get wrong and impossible to see
 * from a unit test of the runner:
 *
 *   - `claim` while an entry exists returns `Deferred.await(entry.done)` instead of starting a
 *     second drain, so N concurrent `resume()` callers join ONE provider turn and all settle;
 *   - `wake` while an entry exists sets `pendingWake = true` — a boolean, so a storm of wakes
 *     coalesces — and `settle` starts exactly one successor drain for it, with `force = false`;
 *   - a `force = false` drain that finds no pending steer/queue/goal/continuation returns without
 *     a provider request (runner/llm.ts, the `!input.force && ...` guard), which is why a
 *     coalesced wake is cheap rather than an extra turn.
 *
 * The dangerous window is `wake` racing `settle`: the wake either lands on the live entry (and is
 * carried by the successor branch) or lands after `active.delete(key)` (and starts a fresh
 * entry). Both are asserted through the same observable — the docked input is drained exactly
 * once — so the scenario is deterministic whichever side of the race it falls on.
 *
 * Determinism: every "act while the turn is live" window is held open by a `sim_slow` tool call
 * (hundreds of milliseconds of real, interruptible work) rather than by stream timing, so forking
 * callers can never lose the race to a fast provider. Where admission *order* is genuinely
 * nondeterministic (a storm fired with `concurrency: "unbounded"`), the assertions are over set
 * membership and per-text multiplicity instead of order.
 *
 * Overlap note: `lifecycle.test.ts` asserts three concurrent resumes share one request and that
 * two roots interrupt independently; `extreme.test.ts` covers two roots queueing while one is
 * interrupted. This suite adds the caller-outcome half (every joined caller must *succeed*, not
 * merely share a request), the wake-storm and wake-versus-settle races, and two roots that both
 * run to completion concurrently.
 */
import { describe } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionMessage } from "@turenlabs/core/session/message"
import { Prompt } from "@turenlabs/core/session/prompt"
import { reply, replyWithTool, requestUserTexts, simulate, type RequestRecord, type ScenarioContext } from "./harness"

const expectRequestCount = (records: ReadonlyArray<RequestRecord>, expected: number, label: string) => {
  if (records.length !== expected)
    throw new Error(
      `[${label}] expected ${expected} provider request(s), saw ${records.length}: ` +
        JSON.stringify(records.map((record) => record.label ?? "unlabeled")),
    )
}

const expectUserTexts = (label: string, record: RequestRecord | undefined, expected: ReadonlyArray<string>) => {
  if (!record) throw new Error(`[${label}] request was never issued`)
  const actual = requestUserTexts(record.request)
  if (actual.length !== expected.length || actual.some((text, index) => text !== expected[index]))
    throw new Error(`[${label}] user texts ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

const contextUsers = (ctx: ScenarioContext, sessionID = ctx.sessionID) =>
  ctx.services.store.context(sessionID).pipe(
    Effect.orDie,
    Effect.map((messages) => messages.filter((message): message is SessionMessage.User => message.type === "user")),
  )

describe("coordinator: concurrent callers on one Session", () => {
  // Four resumes are fired at a drain the prompt's own wake already started, while `sim_slow`
  // guarantees the entry is still live. Every one of them must take the join branch of `claim`
  // (`Deferred.await(entry.done)`), so: no extra provider request, and — the part a request count
  // alone does not prove — every caller returns successfully rather than one winning and three
  // failing or hanging.
  simulate("concurrent resumes of a live drain all join it and all settle", (ctx) =>
    Effect.gen(function* () {
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 600 }, { label: "opening" }),
        reply("One drain served every caller.", { label: "continuation" }),
      )
      yield* ctx.user.prompt("Start a drain the resumes must join.")
      yield* ctx.phase.whenToolRunning("sim_slow")

      yield* ctx.step("fork(4 concurrent resumes)")
      // Forked from *this* fiber, one after another. Forking is non-blocking, so the four resumes
      // still race each other for the entry — but under `concurrency: "unbounded"` each fork would
      // attach to the short-lived fiber `forEach` spawned for it, and every caller would be
      // interrupted before it ever reached `claim`.
      const callers = yield* Effect.forEach(
        [1, 2, 3, 4],
        () => ctx.services.session.resume(ctx.sessionID).pipe(Effect.exit, Effect.forkChild),
        { concurrency: 1 },
      )
      const exits = yield* Effect.forEach(callers, (caller) => Fiber.join(caller), { concurrency: "unbounded" })
      const failed = exits.filter(Exit.isFailure)
      if (failed.length > 0)
        throw new Error(`expected every joined resume caller to settle, ${failed.length} of 4 failed`)

      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      // The tool turn and its continuation, and nothing else: a caller that force-claimed its own
      // drain instead of joining would have added a third request.
      expectRequestCount(ctx.provider.requests(), 2, "concurrent resumes")
      const users = yield* contextUsers(ctx)
      if (users.length !== 1) throw new Error(`expected one user message, saw ${users.length}`)
    }),
  )

  // A storm of steers admitted concurrently while the turn is live. Each admission registers a
  // wake, and `pendingWake` is a boolean, so they coalesce; what must NOT coalesce is the input
  // itself. Admission order under `concurrency: "unbounded"` is decided by the per-session
  // operation lock, so the assertions are order-free: every storm text reaches the model exactly
  // once, none of them leaks into the request that was already in flight, and `invariants.settled`
  // proves no admitted row was left unpromoted.
  simulate("a prompt wake storm during a running turn coalesces without dropping input", (ctx) =>
    Effect.gen(function* () {
      const opening = "Start the storm."
      const storm = ["Storm one.", "Storm two.", "Storm three.", "Storm four."] as const
      ctx.provider.enqueue(
        replyWithTool("sim_slow", { ms: 600 }, { label: "opening" }),
        reply("Handled every steer.", { label: "continuation" }),
      )
      yield* ctx.user.prompt(opening)
      yield* ctx.phase.whenToolRunning("sim_slow")

      yield* ctx.step("fire(4 concurrent steers)")
      yield* Effect.forEach(storm, (text) => ctx.user.prompt(text, { delivery: "steer" }), {
        concurrency: "unbounded",
        discard: true,
      })
      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })

      const records = ctx.provider.requests()
      // Two requests, not five: the whole storm was admitted while `sim_slow` still held the turn
      // open, so every steer precedes the drain's next inbox cutoff and `promoteSteers` carries
      // all four into the one continuation step. The coalesced wakes then find nothing pending.
      expectRequestCount(records, 2, "prompt wake storm")
      expectUserTexts("opening request", records[0], [opening])
      // Admission order among the four is decided by the per-session lock, so assert multiplicity
      // rather than sequence; history accumulates, so the last request carries all of them.
      const delivered = requestUserTexts(records.at(-1)!.request)
      for (const text of storm) {
        const seen = delivered.filter((candidate) => candidate === text).length
        if (seen !== 1) throw new Error(`expected ${JSON.stringify(text)} to reach the model exactly once, saw ${seen}`)
      }
      const users = yield* contextUsers(ctx)
      if (users.length !== storm.length + 1)
        throw new Error(`expected ${storm.length + 1} user messages, saw ${users.length}`)
    }),
  )

  // The wake/settle race, staged deliberately: the input is docked with `resume: false` (no wake
  // of its own) at the instant the opening stream ends, then a bare `wake` is fired. Whether it
  // lands on the still-live entry (`pendingWake` -> successor drain) or after `active.delete`
  // (fresh entry), the docked queue row must be drained exactly once — and the successor drain
  // that finds nothing left must not issue a request of its own, which is what pins the count at
  // two rather than three.
  simulate("a wake racing drain settlement still drains the docked input exactly once", (ctx) =>
    Effect.gen(function* () {
      const late = "Handle me after the wake race."
      ctx.provider.enqueue(
        reply("Opening answer.", { chunks: 3, label: "opening" }),
        reply("Drained what the late wake found.", { label: "successor" }),
      )
      yield* ctx.user.prompt("Start the turn.")
      yield* ctx.phase.afterProviderEnd(0)
      yield* ctx.user.prompt(late, { delivery: "queue", resume: false })
      yield* ctx.step("wake(racing settlement)")
      yield* ctx.services.session.wake(ctx.sessionID).pipe(Effect.orDie)

      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 2 })
      const records = ctx.provider.requests()
      expectRequestCount(records, 2, "wake racing settlement")
      expectUserTexts("opening request", records[0], ["Start the turn."])
      expectUserTexts("successor request", records[1], ["Start the turn.", late])
    }),
  )
})

describe("coordinator: independent Sessions", () => {
  // Different keys are different entries, so nothing in the coordinator serializes two roots.
  // Both are held open by their own `sim_slow` call, both are observed active at the same
  // instant, and both run to completion — the head-of-line check that `lifecycle.test.ts` makes
  // for interruption, made here for ordinary progress. Every behavior is matched on its own
  // root's user text because the two sessions' requests race for the shared behavior queue.
  simulate("two independent root Sessions run to completion concurrently", (ctx) =>
    Effect.gen(function* () {
      const secondID = SessionV2.ID.make("ses_sim_concurrent_second_root")
      const firstText = "First root does its own work."
      const secondText = "Second root does its own work."
      const location = (yield* ctx.services.session.get(ctx.sessionID)).location
      yield* ctx.services.session.create({ id: secondID, title: "simulator: concurrent second root", location })

      ctx.provider.enqueue(
        replyWithTool(
          "sim_slow",
          { ms: 400 },
          {
            label: "first-tool",
            match: (request) => requestUserTexts(request).includes(firstText),
          },
        ),
        reply("First root finished.", {
          label: "first-done",
          match: (request) => requestUserTexts(request).includes(firstText),
        }),
        replyWithTool(
          "sim_slow",
          { ms: 400 },
          {
            label: "second-tool",
            match: (request) => requestUserTexts(request).includes(secondText),
          },
        ),
        reply("Second root finished.", {
          label: "second-done",
          match: (request) => requestUserTexts(request).includes(secondText),
        }),
      )

      yield* ctx.user.prompt(firstText)
      yield* ctx.services.session
        .prompt({ sessionID: secondID, prompt: Prompt.make({ text: secondText }) })
        .pipe(Effect.orDie)

      // Both entries exist at once: `wake` registers its entry synchronously, and each root's
      // opening tool call is still sleeping, so neither could have drained already.
      const active = yield* ctx.services.session.active
      if (!active.has(ctx.sessionID) || !active.has(secondID))
        throw new Error(`expected both roots active at once, saw ${JSON.stringify([...active])}`)

      yield* ctx.invariants.settled(ctx.sessionID, { expect: "idle", minRequests: 4 })
      yield* ctx.invariants.settled(secondID, { expect: "idle", minRequests: 4 })
      expectRequestCount(ctx.provider.requests(), 4, "independent roots")

      // Neither transcript leaked into the other.
      const firstUsers = (yield* contextUsers(ctx)).map((message) => message.text)
      const secondUsers = (yield* contextUsers(ctx, secondID)).map((message) => message.text)
      if (firstUsers.length !== 1 || firstUsers[0] !== firstText)
        throw new Error(`first root transcript is ${JSON.stringify(firstUsers)}`)
      if (secondUsers.length !== 1 || secondUsers[0] !== secondText)
        throw new Error(`second root transcript is ${JSON.stringify(secondUsers)}`)
    }),
  )
})

/**
 * GAP — caller cancellation, deliberately not covered in this pass.
 *
 * What exists today: `lifecycle.test.ts` covers the one caller-cancellation shape the harness can
 * already express — interrupting a fiber that is merely *joining* a drain
 * (`Effect.forkChild` + `Fiber.interrupt`), which must not cancel the process-owned drain.
 *
 * What is still uncovered, and why it needs harness work rather than another scenario:
 *
 *   1. Cancelling an admission in flight. `V2Session.prompt` is `Effect.uninterruptible` under a
 *      per-session lock, so a cancelled caller cannot observe a half-written admission from
 *      inside the process. The failure mode that matters is the *transport* one: the client goes
 *      away after `SessionEvent.PromptAdmitted` is durable but before the response is written, so
 *      it retries the same ID (see idempotency.test.ts) or gives up and leaves a docked row. The
 *      harness has no way to abort a request between those two points; it would need an injection
 *      seam inside `SessionInput.admit`.
 *   2. Cancelling a streaming reader. Real callers disconnect from `session.events(...)`, not
 *      from `resume`. The simulator drives sessions through the service API and never opens an
 *      event stream, so "a subscriber vanished mid-turn" has no representation at all — this
 *      needs a `ctx.user.watch()` primitive that opens, and can drop, a real event subscription.
 *   3. Server-side request cancellation. The behaviour a user actually hits (closing the desktop
 *      tab mid-turn) is owned by the HTTP layer above `SessionV2`, which is outside this
 *      harness's graph entirely.
 *
 * Adding scenarios for these before the primitives exist would either assert nothing (1) or
 * assert the harness's own shortcuts rather than the system (2, 3).
 */
