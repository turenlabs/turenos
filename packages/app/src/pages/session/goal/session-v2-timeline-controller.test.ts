import { describe, expect, test } from "bun:test"
import { createStore, reconcile } from "solid-js/store"
import type {
  Part,
  SessionMessage,
  SessionNextToolCalled,
  SessionNextToolFailed,
  SessionNextToolInputEnded,
  SessionNextToolProgress,
  SessionNextToolSuccess,
  ToolPart,
} from "@turenlabs/sdk/v2/client"
import { presentTool } from "./session-v2-presentation"
import {
  applySessionV2ToolEvent,
  expandSessionV2ToolBody,
  collectSessionV2Messages,
  commitSessionIdleAfterRefresh,
  createSessionPromptOutboxStore,
  createSessionPromptPendingStore,
  createSessionPromptStartupStore,
  createSessionSnapshotQueue,
  createSessionTurnActivityStore,
  createSessionV2DeltaGate,
  emptyTurnActivity,
  loadSessionV2Window,
  mergeSessionV2LiveText,
  nextSessionEventRetry,
  nextSessionV2WindowMinimum,
  parseDurableEvent,
  reduceTurnActivity,
  sessionActiveSnapshotStatus,
  shouldPollSessionUntilIdle,
  sessionEventCommitsRevert,
  sessionEventPromptPending,
  sessionUnprojectedInputIDs,
  sessionTurnStatus,
  sessionEventRetryStatus,
  sessionEventStatusTransition,
  sessionEventNeedsTranscriptSnapshot,
  sessionSnapshotOutcome,
  sessionV2DeltasForProjection,
  sessionV2MessageWindowHasContinuity,
  SESSION_V2_MESSAGE_PAGE_LIMIT,
  SESSION_V2_SNAPSHOT_RESTAKE_LIMIT,
  SESSION_V2_WINDOW_PAGE_LIMIT,
  type SessionV2ToolEvent,
} from "./session-v2-timeline-controller"

describe("nextSessionV2WindowMinimum", () => {
  test("loads one page for manual scrolling and doubles distant hash seeking", () => {
    expect(nextSessionV2WindowMinimum(200, "page")).toBe(250)
    expect(nextSessionV2WindowMinimum(200, "seek")).toBe(400)
    expect(nextSessionV2WindowMinimum(0, "seek")).toBe(50)
  })
})

const event = {
  id: "evt_1",
  type: "session.next.step.started" as const,
  durable: { aggregateID: "ses_1", seq: 4, version: 1 },
  data: {
    timestamp: 1,
    sessionID: "ses_1",
    assistantMessageID: "msg_assistant",
    agent: "build",
    model: { providerID: "provider", id: "model" },
  },
}

describe("sessionActiveSnapshotStatus", () => {
  test("clears an unchanged optimistic busy status when the session already finished", () => {
    expect(sessionActiveSnapshotStatus({ requestedVersion: 2, currentVersion: 2, active: false })).toEqual({
      type: "idle",
    })
  })

  test("marks an unchanged status busy while the server reports an active drain", () => {
    expect(sessionActiveSnapshotStatus({ requestedVersion: 0, currentVersion: 0, active: true })).toEqual({
      type: "busy",
    })
  })

  test("does not overwrite a same-valued newer status event with an older snapshot", () => {
    expect(
      sessionActiveSnapshotStatus({
        requestedVersion: 3,
        currentVersion: 4,
        active: true,
      }),
    ).toBeUndefined()
  })
})

describe("shouldPollSessionUntilIdle", () => {
  test("does not refresh an already inactive cold-open session", () => {
    expect(shouldPollSessionUntilIdle({ type: "idle" })).toBe(false)
    expect(shouldPollSessionUntilIdle(undefined)).toBe(false)
  })

  test("keeps refresh-before-idle for a session the server reports active", () => {
    expect(shouldPollSessionUntilIdle({ type: "busy" })).toBe(true)
  })
})

describe("commitSessionIdleAfterRefresh", () => {
  test("keeps stale terminal failures suppressed until the transcript refresh commits", async () => {
    let release = () => {}
    const state: { status: "busy" | "idle" } = { status: "busy" }
    const refresh = new Promise<void>((resolve) => {
      release = resolve
    })
    const settling = commitSessionIdleAfterRefresh({
      refresh: () => refresh,
      current: () => true,
      commit: () => {
        state.status = "idle"
      },
    })

    await Promise.resolve()
    expect(state.status).toBe("busy")

    release()
    expect(await settling).toBe(true)
    expect(state.status).toBe("idle")
  })

  test("does not publish idle when ownership or status changes during refresh", async () => {
    let release = () => {}
    let current = true
    let committed = false
    const refresh = new Promise<void>((resolve) => {
      release = resolve
    })
    const settling = commitSessionIdleAfterRefresh({
      refresh: () => refresh,
      current: () => current,
      commit: () => {
        committed = true
      },
    })

    current = false
    release()

    expect(await settling).toBe(false)
    expect(committed).toBe(false)
  })
})

describe("parseDurableEvent", () => {
  test("accepts direct and SSE-encoded durable events", () => {
    expect(parseDurableEvent(event)).toEqual(event)
    expect(parseDurableEvent({ data: JSON.stringify(event) })).toEqual(event)
  })

  test("rejects malformed and non-session payloads", () => {
    expect(parseDurableEvent({ data: "not-json" })).toBeUndefined()
    expect(
      parseDurableEvent({ data: JSON.stringify({ type: "hidden.reminder", data: { text: "secret" } }) }),
    ).toBeUndefined()
  })
})

describe("sessionEventCommitsRevert", () => {
  test("recognizes explicit and admission-folded revert commits", () => {
    const make = (type: string, data: Record<string, unknown>) =>
      ({ type, data }) as unknown as Parameters<typeof sessionEventCommitsRevert>[0]

    expect(sessionEventCommitsRevert(make("session.next.revert.committed", {}))).toBe(true)
    expect(
      sessionEventCommitsRevert(make("session.next.prompt.admitted", { revert: { messageID: "msg_boundary" } })),
    ).toBe(true)
    expect(
      sessionEventCommitsRevert(
        make("session.next.goal.updated", { admission: { revert: { messageID: "msg_boundary" } } }),
      ),
    ).toBe(true)
    expect(sessionEventCommitsRevert(make("session.next.prompt.admitted", {}))).toBe(false)
  })
})

describe("sessionEventStatusTransition", () => {
  // The event type strings below were transcribed from a real compaction, not written from the
  // schema: `SessionCompaction.compact` was driven against a stub LLM and its published events
  // dumped. A successful run published, in order:
  //   session.next.compaction.started  { sessionID, messageID, timestamp, reason: "manual" }
  //   session.next.compaction.delta    { ..., text: "## Objective" }
  //   session.next.compaction.delta    { ..., text: "\n- ship it" }
  //   session.next.compaction.ended    { ..., reason: "manual", text, recent }
  // A provider failure terminates with `session.next.compaction.failed` instead of `ended`.
  test("marks a session busy when the server says compaction started", () => {
    expect(sessionEventStatusTransition("session.next.compaction.started")).toEqual({ busy: true, poll: false })
  })

  // The indicator must never be taken down by a poll against an endpoint that cannot see
  // compaction. `v2.session.active()` reports agent execution and shells only, so arming a poll
  // here would answer "idle" within 250ms and erase the indicator mid-summarisation.
  test("does not poll while compaction runs, because active() cannot see compaction", () => {
    expect(sessionEventStatusTransition("session.next.compaction.started")?.poll).toBe(false)
  })

  // Polling rather than forcing idle is what keeps automatic compaction correct: it runs inside a
  // turn, so `active()` still reports the session and the indicator stays up until the turn ends.
  test("settles via the server when compaction ends or fails", () => {
    expect(sessionEventStatusTransition("session.next.compaction.ended")).toEqual({ busy: false, poll: true })
    expect(sessionEventStatusTransition("session.next.compaction.failed")).toEqual({ busy: false, poll: true })
  })

  // A compaction delta is live-only and carries no phase meaning; treating it as a start would
  // resurrect the indicator after a decline had already settled it.
  test("ignores compaction deltas", () => {
    expect(sessionEventStatusTransition("session.next.compaction.delta")).toBeUndefined()
  })

  test("leaves the pre-existing turn and shell transitions unchanged", () => {
    expect(sessionEventStatusTransition("session.next.step.started")).toEqual({ busy: true, poll: true })
    expect(sessionEventStatusTransition("session.next.shell.started")).toEqual({ busy: true, poll: false })
    expect(sessionEventStatusTransition("session.next.step.ended")).toEqual({ busy: false, poll: true })
    expect(sessionEventStatusTransition("session.next.step.failed")).toEqual({ busy: false, poll: true })
    expect(sessionEventStatusTransition("session.next.shell.ended")).toEqual({ busy: false, poll: true })
  })

  test("ignores events that carry no status meaning", () => {
    expect(sessionEventStatusTransition("session.next.text.delta")).toBeUndefined()
    expect(sessionEventStatusTransition("session.next.compaction.pruned")).toBeUndefined()
    expect(sessionEventStatusTransition("session.next.revert.committed")).toBeUndefined()
  })
})

describe("createSessionSnapshotQueue", () => {
  test("serializes context reads and lets an authoritative full refresh supersede queued context", async () => {
    const releases: Array<() => void> = []
    const calls: string[] = []
    let active = 0
    let maxActive = 0
    const queue = createSessionSnapshotQueue(
      (sessionID, mode) =>
        new Promise<void>((resolve) => {
          calls.push(`${sessionID}:${mode}`)
          active++
          maxActive = Math.max(maxActive, active)
          releases.push(() => {
            active--
            resolve()
          })
        }),
    )

    const first = queue.request("ses_1", "context")
    const second = queue.request("ses_1", "context")
    const full = queue.request("ses_1", "full")
    expect(calls).toEqual(["ses_1:context"])
    expect(maxActive).toBe(1)

    releases.shift()?.()
    await Promise.resolve()
    expect(calls).toEqual(["ses_1:context", "ses_1:full"])
    expect(maxActive).toBe(1)

    releases.shift()?.()
    await Promise.all([first, second, full])
    expect(active).toBe(0)
  })

  test("re-stakes a snapshot requested from inside a run without deadlocking its caller", async () => {
    // When the session key moves mid-flight the runner discards the stale result
    // and re-requests. `request` hands back the drain promise the runner is
    // already inside, so the re-request must only queue work — and the original
    // caller must still be waiting when the follow-up pass lands.
    const calls: string[] = []
    let stale = true
    const queue = createSessionSnapshotQueue(async (sessionID, mode) => {
      calls.push(`${sessionID}:${mode}`)
      if (!stale) return
      stale = false
      void queue.request(sessionID, mode)
    })

    await queue.request("ses_1", "full")

    expect(calls).toEqual(["ses_1:full", "ses_1:full"])
  })

  test("keeps an authoritative reset queued ahead of a transient context refresh", async () => {
    const releases: Array<() => void> = []
    const calls: Array<[string, string, boolean]> = []
    const queue = createSessionSnapshotQueue(
      (sessionID, mode, authoritative) =>
        new Promise<void>((resolve) => {
          calls.push([sessionID, mode, authoritative])
          releases.push(resolve)
        }),
    )

    const context = queue.request("ses_1", "context")
    const reset = queue.request("ses_1", "full", { authoritative: true })
    releases.shift()?.()
    await Promise.resolve()
    expect(calls).toEqual([
      ["ses_1", "context", false],
      ["ses_1", "full", true],
    ])

    releases.shift()?.()
    await Promise.all([context, reset])
  })

  test("keeps a queued full caller attached when the running context snapshot fails", async () => {
    let rejectContext!: (error: Error) => void
    let resolveFull!: () => void
    const calls: string[] = []
    const queue = createSessionSnapshotQueue(
      (_sessionID, mode) =>
        new Promise<void>((resolve, reject) => {
          calls.push(mode)
          if (mode === "context") rejectContext = reject
          else resolveFull = resolve
        }),
    )

    const context = queue.request("ses_1", "context")
    const full = queue.request("ses_1", "full")
    rejectContext(new Error("context failed"))
    await expect(context).rejects.toThrow("context failed")
    await Promise.resolve()
    expect(calls).toEqual(["context", "full"])

    resolveFull()
    await full
  })

  test("starts a fresh drain for a request submitted immediately after settlement", async () => {
    const calls: string[] = []
    const queue = createSessionSnapshotQueue(async (_sessionID, mode) => {
      calls.push(mode)
    })

    await queue.request("ses_1", "full")
    await queue.request("ses_1", "full")
    expect(calls).toEqual(["full", "full"])
  })
})

describe("V2 timeline pagination", () => {
  test("uses the legal endpoint limit and collects every message page in order", async () => {
    const cursors: Array<string | undefined> = []
    const messages = await collectSessionV2Messages(async (cursor) => {
      cursors.push(cursor)
      if (!cursor) return { data: ["first", "second"], cursor: { next: "page-2" } }
      return { data: ["third"], cursor: {} }
    })

    expect(SESSION_V2_MESSAGE_PAGE_LIMIT).toBe(50)
    expect(cursors).toEqual([undefined, "page-2"])
    expect(messages).toEqual(["first", "second", "third"])
  })

  // A window request needs message shapes, not strings: the loader has to recognise which
  // messages open a turn. `user` and `assistant` below are the minimum the loader inspects.
  const user = (id: string) => ({ id, type: "user" as const, text: "go", time: { created: 1 } })
  const assistant = (id: string) => ({
    id,
    type: "assistant" as const,
    agent: "build",
    model: { providerID: "p", id: "m" },
    content: [],
    time: { created: 1 },
  })

  // The window opens at the newest message, so the first request asks for `desc`; every request
  // after it carries only the cursor, because the server rejects the two together ("Cursor cannot
  // be combined with order", packages/server/src/handlers/message.ts) and the cursor already
  // encodes the order it was minted under.
  test("omits order from cursor requests accepted by the real message handler contract", async () => {
    const requests: Array<Record<string, unknown>> = []
    const window = await loadSessionV2Window({
      sessionID: "ses_pages",
      signal: new AbortController().signal,
      request: async (payload) => {
        requests.push(payload)
        if (!payload.cursor) return { data: { data: [assistant("msg_c")], cursor: { next: "page-2" } } }
        return { data: { data: [user("msg_b"), assistant("msg_a")], cursor: {} } }
      },
      minimum: 2,
    })

    expect(requests).toEqual([
      { sessionID: "ses_pages", limit: SESSION_V2_MESSAGE_PAGE_LIMIT, order: "desc", lean: "true" },
      { sessionID: "ses_pages", limit: SESSION_V2_MESSAGE_PAGE_LIMIT, cursor: "page-2", lean: "true" },
    ])
    // Restored to ascending order, which is the order the timeline projects.
    expect(window.messages.map((message) => message.id)).toEqual(["msg_a", "msg_b", "msg_c"])
    expect(window.complete).toBe(true)
    expect(window.older).toBeUndefined()
  })

  // The whole point of the change: a session with more history than the window does not get
  // drained. One page is one request, and the rest stays reachable behind an `older` cursor.
  test("stops after one page when the newest page already contains a turn", async () => {
    let requests = 0
    const window = await loadSessionV2Window({
      sessionID: "ses_big",
      signal: new AbortController().signal,
      request: async () => {
        requests += 1
        return {
          data: { data: [assistant("msg_z"), user("msg_y"), assistant("msg_x")], cursor: { next: "older-page" } },
        }
      },
      minimum: 2,
    })

    expect(requests).toBe(1)
    expect(window.messages.map((message) => message.id)).toEqual(["msg_x", "msg_y", "msg_z"])
    expect(window.complete).toBe(false)
    expect(window.older).toBe("older-page")
  })

  // A window with no turn boundary anywhere in it projects to an empty transcript, because
  // `presentSessionV2Messages` drops assistant messages that have no parent user message. Keep
  // reading until one appears rather than showing a blank timeline.
  test("keeps paging while the window contains no turn boundary", async () => {
    const pages = [
      { data: [assistant("msg_e"), assistant("msg_d")], cursor: { next: "p2" } },
      { data: [assistant("msg_c"), assistant("msg_b")], cursor: { next: "p3" } },
      { data: [user("msg_a")], cursor: { next: "p4" } },
    ]
    let index = 0
    const window = await loadSessionV2Window({
      sessionID: "ses_headless",
      signal: new AbortController().signal,
      request: async () => ({ data: pages[index++]! }),
      minimum: 1,
    })

    expect(index).toBe(3)
    expect(window.messages.map((message) => message.id)).toEqual(["msg_a", "msg_b", "msg_c", "msg_d", "msg_e"])
  })

  // Bounded overshoot: a transcript that never yields a turn boundary must not walk the whole
  // session and reintroduce the stall the window exists to remove.
  test("gives up looking for a turn boundary after the page cap", async () => {
    let requests = 0
    const window = await loadSessionV2Window({
      sessionID: "ses_corrupt",
      signal: new AbortController().signal,
      request: async () => {
        requests += 1
        return { data: { data: [assistant(`msg_${requests}`)], cursor: { next: `p${requests}` } } }
      },
      minimum: 1,
    })

    expect(requests).toBe(SESSION_V2_WINDOW_PAGE_LIMIT)
    expect(window.older).toBe(`p${SESSION_V2_WINDOW_PAGE_LIMIT}`)
    expect(window.complete).toBe(false)
  })

  // Widening for "load older" must not slide the window forward. The refresh keeps reading until
  // the message that was already at the top is back inside it, so a session that grew while the
  // user was reading does not push history off the far end.
  test("pages until the previous oldest message is inside the window again", async () => {
    const pages = [
      { data: [user("msg_new")], cursor: { next: "p2" } },
      { data: [user("msg_anchor")], cursor: { next: "p3" } },
    ]
    let index = 0
    const window = await loadSessionV2Window({
      sessionID: "ses_widen",
      signal: new AbortController().signal,
      request: async () => ({ data: pages[index++]! }),
      minimum: 1,
      until: "msg_anchor",
    })

    expect(index).toBe(2)
    expect(window.messages.map((message) => message.id)).toEqual(["msg_anchor", "msg_new"])
  })
})

describe("V2 timeline live reconciliation", () => {
  test("keeps deltas until a snapshot covers their streamed text", () => {
    const deltas = [
      { sequence: 1, messageID: "msg", partID: "part", field: "text" as const, delta: "Hel" },
      { sequence: 2, messageID: "msg", partID: "part", field: "text" as const, delta: "lo" },
      { sequence: 3, messageID: "msg", partID: "part", field: "text" as const, delta: "!" },
    ]

    expect(
      sessionV2DeltasForProjection({
        deltas,
        through: 2,
        snapshotText: new Map([["msg\0part", "Hello"]]),
        deltaBases: new Map([["msg\0part", ""]]),
      }).map((delta) => delta.sequence),
    ).toEqual([3])
    expect(
      sessionV2DeltasForProjection({
        deltas,
        through: 2,
        snapshotText: new Map([["msg\0part", "Hel"]]),
        deltaBases: new Map([["msg\0part", ""]]),
      }).map((delta) => delta.sequence),
    ).toEqual([1, 2, 3])
    expect(
      sessionV2DeltasForProjection({
        deltas: [{ ...deltas[0]!, delta: "foo" }],
        through: 1,
        snapshotText: new Map([["msg\0part", "foo"]]),
        deltaBases: new Map([["msg\0part", "foo"]]),
      }).map((delta) => delta.sequence),
    ).toEqual([1])
  })

  test("reconciles interleaved parts independently and keeps deltas past the snapshot", () => {
    const deltas = [
      { sequence: 1, messageID: "msg", partID: "text", field: "text" as const, delta: "Hel" },
      { sequence: 2, messageID: "msg", partID: "reasoning", field: "text" as const, delta: "A" },
      { sequence: 3, messageID: "msg", partID: "text", field: "text" as const, delta: "lo" },
      { sequence: 4, messageID: "msg", partID: "reasoning", field: "text" as const, delta: "B" },
      { sequence: 5, messageID: "msg", partID: "text", field: "text" as const, delta: "!" },
    ]

    expect(
      sessionV2DeltasForProjection({
        deltas,
        through: 4,
        snapshotText: new Map([
          ["msg\0text", "Hello"],
          ["msg\0reasoning", "A"],
        ]),
        deltaBases: new Map([
          ["msg\0text", ""],
          ["msg\0reasoning", ""],
        ]),
      }).map((delta) => delta.sequence),
    ).toEqual([2, 4, 5])
  })

  test("does not reload context for high-frequency stream fragments", () => {
    expect(sessionEventNeedsTranscriptSnapshot("session.next.text.delta")).toBe(false)
    expect(sessionEventNeedsTranscriptSnapshot("session.next.reasoning.delta")).toBe(false)
    expect(sessionEventNeedsTranscriptSnapshot("session.next.tool.input.delta")).toBe(false)
    expect(sessionEventNeedsTranscriptSnapshot("session.next.compaction.delta")).toBe(false)
    expect(sessionEventNeedsTranscriptSnapshot("session.next.text.ended")).toBe(true)
    expect(sessionEventNeedsTranscriptSnapshot("session.next.step.failed")).toBe(true)
  })

  test("does not advance a window through an empty or partial snapshot", () => {
    const current = { oldest: "msg_old", count: 3 }

    expect(sessionV2MessageWindowHasContinuity({ current, messages: [], complete: true })).toBe(false)
    expect(sessionV2MessageWindowHasContinuity({ current, messages: [{ id: "msg_new" }], complete: false })).toBe(false)
    expect(
      sessionV2MessageWindowHasContinuity({
        current,
        messages: [{ id: "msg_old" }, { id: "msg_new" }],
        complete: false,
      }),
    ).toBe(false)
    expect(
      sessionV2MessageWindowHasContinuity({
        current,
        messages: [{ id: "msg_old" }, { id: "msg_mid" }, { id: "msg_new" }],
        complete: false,
      }),
    ).toBe(true)
  })

  test("does not duplicate or regress text across a snapshot race", () => {
    expect(mergeSessionV2LiveText("Hel", "Hello", "lo")).toBe("Hello")
    expect(mergeSessionV2LiveText("Hello", "Hel", "lo")).toBe("Hello")
    expect(mergeSessionV2LiveText("Hello", "Hello", "lo")).toBe("Hello")
    expect(mergeSessionV2LiveText("Hel", undefined, "lo")).toBe("Hello")
  })

  test("caps reconnect backoff at five seconds", () => {
    expect(nextSessionEventRetry(250)).toBe(500)
    expect(nextSessionEventRetry(4_000)).toBe(5_000)
    expect(nextSessionEventRetry(5_000)).toBe(5_000)
  })

  test("ignores legacy deltas but accepts the first V2 delta after a durable start event", () => {
    const gate = createSessionV2DeltaGate()
    expect(gate.accepts("ses_empty_v2")).toBeFalse()

    gate.observe("ses_empty_v2")

    expect(gate.accepts("ses_empty_v2")).toBeTrue()
    expect(gate.accepts("ses_legacy")).toBeFalse()
  })

  test("accepts a brand-new session's first live delta after an empty successful snapshot", () => {
    const gate = createSessionV2DeltaGate()
    expect(gate.accepts("ses_brand_new")).toBeFalse()

    // The snapshot can legitimately contain no messages before the first provider delta arrives.
    gate.observeSnapshot("ses_brand_new")

    expect(gate.accepts("ses_brand_new")).toBeTrue()
    expect(gate.accepts("ses_unrelated_legacy")).toBeFalse()
  })
})

// Reproduction of the blank-transcript regression: a session whose ownership key keeps
// moving during cold open (scope and directory both resolve after mount) had its snapshot
// dropped, and the drop budget was cumulative over the session's whole lifetime rather
// than consecutive. Once spent, every later snapshot returned silently, so `data.message`
// stayed undefined, the timeline stayed gated off, and the session rendered blank forever
// beside a perfectly healthy event stream.
describe("sessionSnapshotOutcome", () => {
  test("projects when the session still owns the result", () => {
    expect(sessionSnapshotOutcome({ sessionMatches: true, owned: true, attempts: 0 })).toEqual({ type: "project" })
  })

  test("abandons a result for a session that is no longer on screen", () => {
    expect(sessionSnapshotOutcome({ sessionMatches: false, owned: false, attempts: 0 })).toEqual({ type: "abandon" })
  })

  test("re-stakes rather than dropping when ownership moved", () => {
    expect(sessionSnapshotOutcome({ sessionMatches: true, owned: false, attempts: 0 })).toEqual({
      type: "restake",
      attempts: 1,
    })
  })

  test("survives more consecutive ownership moves than a cold open produces", () => {
    // Scope and directory each resolve after mount, and several tabs hydrating at once
    // can move the key repeatedly. Three attempts was under that ceiling.
    for (let attempts = 0; attempts < SESSION_V2_SNAPSHOT_RESTAKE_LIMIT; attempts++) {
      expect(sessionSnapshotOutcome({ sessionMatches: true, owned: false, attempts })).toEqual({
        type: "restake",
        attempts: attempts + 1,
      })
    }
  })

  test("reports exhaustion instead of silently giving up", () => {
    expect(
      sessionSnapshotOutcome({
        sessionMatches: true,
        owned: false,
        attempts: SESSION_V2_SNAPSHOT_RESTAKE_LIMIT,
      }),
    ).toEqual({ type: "exhausted" })
  })

  test("spends the budget on consecutive failures only", () => {
    // A success resets the counter, so transient key churn spread across a long-lived
    // session can never accumulate into a permanent refusal to hydrate.
    let attempts = 0
    for (const owned of [false, false, true, false, false]) {
      const outcome = sessionSnapshotOutcome({ sessionMatches: true, owned, attempts, limit: 2 })
      if (outcome.type === "restake") attempts = outcome.attempts
      if (outcome.type === "project") attempts = 0
      expect(outcome.type).not.toBe("exhausted")
    }
  })
})

describe("sessionEventRetryStatus", () => {
  const retried = (data: Record<string, unknown>) =>
    ({
      id: "evt_retry",
      type: "session.next.retried" as const,
      durable: { aggregateID: "ses_1", seq: 9, version: 1 },
      data: { timestamp: 1_000, sessionID: "ses_1", ...data },
    }) as never

  test("renders a rate limit as a countdown the timeline can show", () => {
    expect(
      sessionEventRetryStatus(
        retried({
          attempt: 2,
          delay: 60_000,
          error: { message: "Provider request failed with HTTP 429", isRetryable: true, statusCode: 429 },
        }),
      ),
    ).toEqual({
      type: "retry",
      attempt: 2,
      message: "Provider request failed with HTTP 429",
      // Absolute, because that is what the retry card counts down from; the event carries a
      // delay relative to its own timestamp.
      next: 61_000,
    })
  })

  test("carries the provider call to action through", () => {
    const action = {
      reason: "rate_limit",
      provider: "anthropic",
      title: "Rate limit reached",
      message: "Your workspace has hit its per-minute token limit.",
      label: "View limits",
    }
    expect(
      sessionEventRetryStatus(retried({ attempt: 1, delay: 0, error: { message: "limited" }, action })),
    ).toMatchObject({ action })
  })

  test("ignores everything that is not a retry notice", () => {
    expect(sessionEventRetryStatus(event as never)).toBeUndefined()
  })
})

describe("sessionPromptPending", () => {
  const durableEvent = (type: string, data: Record<string, unknown>) =>
    ({
      id: "evt_pending",
      type,
      durable: { aggregateID: "ses_1", seq: 11, version: 1 },
      data: { timestamp: 1_000, sessionID: "ses_1", ...data },
    }) as never

  test("admitted event marks the message pending with its delivery kind, prompted event clears it", () => {
    const store = createSessionPromptPendingStore()

    const admitted = sessionEventPromptPending(
      durableEvent("session.next.prompt.admitted", { messageID: "msg_user", prompt: [], delivery: "queue" }),
    )
    expect(admitted).toEqual({ type: "set", messageID: "msg_user", delivery: "queue" })
    store.apply(admitted!)
    expect(store.has("msg_user")).toBe(true)
    expect(store.delivery("msg_user")).toBe("queue")

    const prompted = sessionEventPromptPending(
      durableEvent("session.next.prompted", { messageID: "msg_user", prompt: [], delivery: "queue" }),
    )
    expect(prompted).toEqual({ type: "clear", messageID: "msg_user" })
    store.apply(prompted!)
    expect(store.has("msg_user")).toBe(false)
    expect(store.delivery("msg_user")).toBeUndefined()
  })

  test("ignores events that neither admit nor promote a prompt", () => {
    expect(sessionEventPromptPending(event as never)).toBeUndefined()
  })

  test("an optimistic mark behaves exactly like an admitted event", () => {
    // The sender marks a steer before the admitted event round-trips; the admitted event
    // then re-confirms the same value and the prompted event still clears it.
    const store = createSessionPromptPendingStore()
    store.mark("msg_optimistic", "steer")
    expect(store.delivery("msg_optimistic")).toBe("steer")
    store.apply({ type: "set", messageID: "msg_optimistic", delivery: "steer" })
    expect(store.delivery("msg_optimistic")).toBe("steer")
    store.clear("msg_optimistic")
    expect(store.delivery("msg_optimistic")).toBeUndefined()
  })

  test("tracks a pending prompt even when its delivery label is suppressed", () => {
    const store = createSessionPromptPendingStore()
    store.mark("msg_hidden", "steer", { label: false })
    expect(store.has("msg_hidden")).toBe(true)
    expect(store.delivery("msg_hidden")).toBeUndefined()
    store.clear("msg_hidden")
    expect(store.has("msg_hidden")).toBe(false)
  })

  test("admission and snapshot confirmation preserve an idle send's suppressed label", () => {
    const store = createSessionPromptPendingStore()
    store.mark("msg_idle", "steer", { label: false })
    store.apply({ type: "set", messageID: "msg_idle", delivery: "steer" })
    expect(store.has("msg_idle")).toBe(true)
    expect(store.delivery("msg_idle")).toBeUndefined()
    store.mark("msg_idle", "steer", { through: store.revision() })
    expect(store.delivery("msg_idle")).toBeUndefined()
  })

  test("a stale pending snapshot cannot resurrect a promoted prompt", () => {
    const store = createSessionPromptPendingStore()
    store.mark("msg_queue", "queue")
    const through = store.revision()
    store.apply({ type: "clear", messageID: "msg_queue" })
    store.mark("msg_queue", "queue", { through })
    expect(store.has("msg_queue")).toBe(false)
    expect(store.ids()).toEqual([])
    expect(store.delivery("msg_queue")).toBeUndefined()
    store.mark("msg_other", "queue", { through })
    expect(store.delivery("msg_other")).toBe("queue")
  })

  test("treats an authoritative user message as stronger than a stale pending-input snapshot", () => {
    expect([
      ...sessionUnprojectedInputIDs(new Set(["msg_projected"]), [{ id: "msg_projected" }, { id: "msg_waiting" }]),
    ]).toEqual(["msg_waiting"])
  })

  test("clears startup feedback only for the session whose lifecycle started", () => {
    const store = createSessionPromptStartupStore()
    store.mark("ses_a", "msg_a")
    store.mark("ses_b", "msg_b")
    store.clearSession("ses_a")
    expect(store.has("msg_a")).toBe(false)
    expect(store.has("msg_b")).toBe(true)
    store.clear("msg_b")
    expect(store.has("msg_b")).toBe(false)
  })

  test("clears startup feedback when an authoritative assistant responds to that prompt", () => {
    const store = createSessionPromptStartupStore()
    store.mark("ses_a", "msg_a")
    store.mark("ses_a", "msg_b")
    store.clearResponded([{ role: "assistant", parentID: "msg_a" } as never])
    expect(store.has("msg_a")).toBe(false)
    expect(store.has("msg_b")).toBe(true)
  })

  test("keeps an outbox row until its exact user message is authoritative", () => {
    const store = createSessionPromptOutboxStore()
    store.put({
      sessionID: "ses_a",
      message: {
        id: "msg_pending",
        sessionID: "ses_a",
        role: "user",
        time: { created: 2 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude" },
      },
      parts: [],
    })

    expect(store.presentation("ses_a").messages.map((message) => message.id)).toEqual(["msg_pending"])
    store.reconcile("ses_a", [
      {
        id: "msg_other",
        type: "user",
        time: { created: 1 },
        text: "older",
      },
    ])
    expect(store.presentation("ses_a").messages.map((message) => message.id)).toEqual(["msg_pending"])
    store.reconcile("ses_a", [
      {
        id: "msg_pending",
        type: "user",
        time: { created: 2 },
        text: "do not disappear",
      },
    ])
    expect(store.presentation("ses_a").messages).toEqual([])
  })

  test("keeps admitted and promoted rows but clears cancelled status", () => {
    const store = createSessionPromptOutboxStore()
    store.put({
      sessionID: "ses_a",
      message: {
        id: "msg_status",
        sessionID: "ses_a",
        role: "user",
        time: { created: 2 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude" },
      },
      parts: [],
    })

    store.applyStatus("msg_status", "admitted")
    store.applyStatus("msg_status", "promoted")
    expect(store.presentation("ses_a").messages).toHaveLength(1)
    store.applyStatus("msg_status", "cancelled")
    expect(store.presentation("ses_a").messages).toEqual([])
  })
})

describe("turn status", () => {
  const durable = (type: string, data: Record<string, unknown>) =>
    ({
      id: "evt_turn",
      type,
      durable: { aggregateID: "ses_1", seq: 21, version: 1 },
      data: { timestamp: 1_000, sessionID: "ses_1", assistantMessageID: "msg_a", ...data },
    }) as never

  const status = (
    activity: ReturnType<typeof reduceTurnActivity>,
    input?: { questionPending?: boolean; agentsActive?: number },
  ) =>
    sessionTurnStatus({
      questionPending: input?.questionPending ?? false,
      agentsActive: input?.agentsActive ?? 0,
      activity,
    })

  test("statuses transition correctly across a synthetic event sequence", () => {
    let activity = emptyTurnActivity
    const reduce = (type: string, data: Record<string, unknown> = {}) => {
      activity = reduceTurnActivity(activity, durable(type, data))
    }

    reduce("session.next.step.started")
    expect(status(activity)).toEqual({ kind: "working" })

    reduce("session.next.reasoning.started", { reasoningID: "r1" })
    expect(status(activity)).toEqual({ kind: "thinking" })

    reduce("session.next.reasoning.ended", { reasoningID: "r1" })
    reduce("session.next.text.started", { textID: "t1" })
    expect(status(activity)).toEqual({ kind: "writing" })

    // A running tool outranks the streaming text that announced it.
    reduce("session.next.tool.input.started", { callID: "c1", name: "bash" })
    expect(status(activity)).toEqual({ kind: "tool", tool: "bash" })

    // wait_agents outranks the plain tool; with the panel not yet caught up, the
    // running orchestration calls stand in for the count.
    reduce("session.next.tool.called", { callID: "c2", tool: "wait_agents", input: {} })
    expect(status(activity)).toEqual({ kind: "agents", count: 1 })

    // The panel's active count wins once it reports.
    expect(status(activity, { agentsActive: 3 })).toEqual({ kind: "agents", count: 3 })

    // A pending question wins over everything.
    expect(status(activity, { questionPending: true, agentsActive: 3 })).toEqual({ kind: "question" })

    reduce("session.next.tool.success", { callID: "c2" })
    expect(status(activity)).toEqual({ kind: "tool", tool: "bash" })

    reduce("session.next.tool.success", { callID: "c1" })
    expect(status(activity)).toEqual({ kind: "writing" })

    // The step boundary clears everything stream-scoped.
    reduce("session.next.step.ended", { finish: "stop" })
    expect(status(activity)).toEqual({ kind: "working" })
  })

  test("compaction and retry map to their own statuses and resolve on their own events", () => {
    let activity = emptyTurnActivity
    activity = reduceTurnActivity(activity, durable("session.next.compaction.started", { messageID: "m1" }))
    expect(status(activity)).toEqual({ kind: "compacting" })
    activity = reduceTurnActivity(activity, durable("session.next.compaction.ended", { messageID: "m1" }))
    expect(status(activity)).toEqual({ kind: "working" })
    activity = reduceTurnActivity(activity, durable("session.next.compaction.started", { messageID: "m2" }))
    expect(status(activity)).toEqual({ kind: "compacting" })
    activity = reduceTurnActivity(activity, durable("session.next.compaction.failed", { messageID: "m2" }))
    expect(status(activity)).toEqual({ kind: "working" })

    activity = reduceTurnActivity(activity, durable("session.next.retried", { attempt: 1, delay: 0 }))
    expect(status(activity)).toEqual({ kind: "retrying" })
    // retrying holds until the next provider call actually starts.
    activity = reduceTurnActivity(activity, durable("session.next.text.ended", { textID: "t9" }))
    expect(status(activity)).toEqual({ kind: "retrying" })
    activity = reduceTurnActivity(activity, durable("session.next.step.started", {}))
    expect(status(activity)).toEqual({ kind: "working" })
  })

  test("a failed compaction is remembered so the transcript can say why", () => {
    // The bug this exists for: compaction failure was a toast and a log line. A user whose session
    // could not be compacted -- the state that makes a session unusable -- had nothing in the
    // transcript to read, and no way to tell a refusal from a click that never registered.
    let activity = reduceTurnActivity(
      emptyTurnActivity,
      durable("session.next.compaction.started", { messageID: "m1" }),
    )
    expect(activity.compacting).toBe(true)

    activity = reduceTurnActivity(
      activity,
      durable("session.next.compaction.failed", {
        messageID: "m1",
        mode: "manual",
        reason: "providerFailed",
        detail: "string too long. Expected a string with maximum length 1048576",
      }),
    )
    expect(activity.compacting).toBe(false)
    expect(activity.compactionFailure).toEqual({
      reason: "providerFailed",
      detail: "string too long. Expected a string with maximum length 1048576",
    })

    // A later attempt owns the transcript: the old verdict must not outlive it.
    activity = reduceTurnActivity(activity, durable("session.next.compaction.started", { messageID: "m2" }))
    expect(activity.compactionFailure).toBeUndefined()
    activity = reduceTurnActivity(activity, durable("session.next.compaction.ended", { messageID: "m2" }))
    expect(activity).toMatchObject({ compacting: false, compactionFailure: undefined })
  })

  test("an interrupted compaction leaves no notice, and a new turn clears a stale one", () => {
    let activity = reduceTurnActivity(
      emptyTurnActivity,
      durable("session.next.compaction.started", { messageID: "m1" }),
    )
    activity = reduceTurnActivity(
      activity,
      durable("session.next.compaction.failed", { messageID: "m1", mode: "manual", reason: "interrupted" }),
    )
    // The user stopped it themselves; nothing to explain.
    expect(activity).toMatchObject({ compacting: false, compactionFailure: undefined })

    activity = reduceTurnActivity(activity, durable("session.next.compaction.started", { messageID: "m2" }))
    activity = reduceTurnActivity(
      activity,
      durable("session.next.compaction.failed", { messageID: "m2", mode: "auto", reason: "providerFailed" }),
    )
    expect(activity.compactionFailure).toEqual({ reason: "providerFailed" })
    activity = reduceTurnActivity(activity, durable("session.next.step.started", {}))
    expect(activity.compactionFailure).toBeUndefined()
  })

  test("a manual compaction can drive the indicator without any durable event", () => {
    // Manual compaction runs outside a turn and can decline before publishing anything, so the
    // command itself has to be able to open and close the indicator.
    const store = createSessionTurnActivityStore()
    expect(store.get("ses_1").compacting).toBe(false)

    store.setCompacting("ses_1", true)
    expect(sessionTurnStatus({ questionPending: false, agentsActive: 0, activity: store.get("ses_1") })).toEqual({
      kind: "compacting",
    })

    store.setCompactionFailure("ses_1", { reason: "sessionBusy" })
    store.setCompacting("ses_1", false)
    expect(store.get("ses_1")).toMatchObject({ compacting: false, compactionFailure: { reason: "sessionBusy" } })
  })

  test("a spawn tool event bumps the reconcile signal the Subagents panel refetches on", () => {
    const store = createSessionTurnActivityStore()
    expect(store.get("ses_1").agentToolEvents).toBe(0)

    store.reduce("ses_1", durable("session.next.tool.called", { callID: "c1", tool: "spawn_agent", input: {} }))
    expect(store.get("ses_1").agentToolEvents).toBe(1)

    // A non-subagent tool does not touch the signal.
    store.reduce("ses_1", durable("session.next.tool.called", { callID: "c2", tool: "bash", input: {} }))
    expect(store.get("ses_1").agentToolEvents).toBe(1)

    // Settlement bumps again, so the panel sees the task reach its terminal state too.
    store.reduce("ses_1", durable("session.next.tool.success", { callID: "c1" }))
    expect(store.get("ses_1").agentToolEvents).toBe(2)
  })
})

// Tool events settle a call straight from their payload — the same fields the server folds into
// its message model — so a tool-heavy turn no longer pays a full-window transcript refetch per
// call. `fallback` stands in for the controller's snapshot/hydrate request; a settlement that
// resolves locally must leave it uncalled.
describe("applySessionV2ToolEvent", () => {
  const toolPart = (state: ToolPart["state"], metadata?: Record<string, unknown>): ToolPart => ({
    id: "call_1",
    sessionID: "ses_1",
    messageID: "msg_a",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state,
    ...(metadata ? { metadata } : {}),
  })

  const running = (metadata?: { structured?: Record<string, unknown>; output?: string }) =>
    toolPart(
      {
        status: "running",
        input: { command: "ls" },
        metadata: { structured: {}, output: "", ...metadata },
        time: { start: 100 },
      },
      { providerExecuted: true },
    )

  const pending = () => toolPart({ status: "pending", input: {}, raw: "" })

  const harness = (parts: Part[] | undefined) => {
    const [data, set] = createStore<{ part: Record<string, Part[] | undefined> }>({ part: { msg_a: parts } })
    const counts = { writes: 0, fallbacks: 0 }
    const apply = (event: SessionV2ToolEvent) =>
      applySessionV2ToolEvent({
        sessionID: "ses_1",
        parts: data.part.msg_a,
        event,
        write: (index, part) => {
          counts.writes += 1
          set("part", "msg_a", index, reconcile(part))
        },
        fallback: () => {
          counts.fallbacks += 1
        },
      })
    return { data, apply, counts }
  }

  const success = (over: Partial<SessionNextToolSuccess["data"]> = {}): SessionNextToolSuccess => ({
    id: "evt_success",
    type: "session.next.tool.success",
    data: {
      timestamp: 200,
      sessionID: "ses_1",
      assistantMessageID: "msg_a",
      callID: "call_1",
      structured: { exit: 0 },
      content: [{ type: "text", text: "total 4" }],
      outputPaths: ["/tmp/out"],
      result: { ok: true },
      provider: { executed: true, metadata: { anthropic: { duration: 5 } } },
      ...over,
    },
  })

  const failed = (over: Partial<SessionNextToolFailed["data"]> = {}): SessionNextToolFailed => ({
    id: "evt_failed",
    type: "session.next.tool.failed",
    data: {
      timestamp: 200,
      sessionID: "ses_1",
      assistantMessageID: "msg_a",
      callID: "call_1",
      error: { type: "unknown", message: "boom" },
      provider: { executed: false },
      ...over,
    },
  })

  test("a success settles the running part in place without a snapshot request", () => {
    const h = harness([running()])

    h.apply(success())

    const part = h.data.part.msg_a?.[0]
    expect(part).toMatchObject({
      type: "tool",
      callID: "call_1",
      tool: "bash",
      metadata: { providerExecuted: true },
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "total 4",
        title: "bash",
        metadata: { structured: { exit: 0 }, outputPaths: ["/tmp/out"], result: { ok: true } },
        time: { start: 100, end: 200 },
      },
    })
    expect(h.counts).toEqual({ writes: 1, fallbacks: 0 })
  })

  test("a failure preserves input and carries structured/output only from a running state", () => {
    const h = harness([running({ structured: { phase: "halfway" }, output: "partial" })])

    h.apply(failed())

    expect(h.data.part.msg_a?.[0]).toMatchObject({
      state: {
        status: "error",
        input: { command: "ls" },
        error: "boom",
        metadata: { structured: { phase: "halfway" }, output: "partial" },
        time: { start: 100, end: 200 },
      },
    })
    expect(h.counts).toEqual({ writes: 1, fallbacks: 0 })
  })

  test("a failure on a pending part presents an empty input, matching the server updater", () => {
    const h = harness([pending()])

    h.apply(failed())

    expect(h.data.part.msg_a?.[0]).toMatchObject({
      state: { status: "error", input: {}, error: "boom", metadata: { structured: {}, output: "" } },
    })
    expect(h.counts).toEqual({ writes: 1, fallbacks: 0 })
  })

  test("a success on a pending part falls back: only a snapshot still holds the parsed input", () => {
    const h = harness([pending()])

    h.apply(success())

    expect(h.counts).toEqual({ writes: 0, fallbacks: 1 })
  })

  test("settlement for a callID the store does not hold falls back to a snapshot", () => {
    const missing = harness([running()])
    missing.apply(success({ callID: "call_other" }))
    expect(missing.counts).toEqual({ writes: 0, fallbacks: 1 })

    const unloaded = harness(undefined)
    unloaded.apply(success())
    expect(unloaded.counts).toEqual({ writes: 0, fallbacks: 1 })
  })

  test("a settlement replayed onto an already settled part is a no-op", () => {
    const h = harness([
      toolPart({
        status: "completed",
        input: { command: "ls" },
        output: "done",
        title: "bash",
        metadata: {},
        time: { start: 100, end: 150 },
      }),
    ])

    h.apply(success())
    h.apply(failed())

    expect(h.counts).toEqual({ writes: 0, fallbacks: 0 })
    expect(h.data.part.msg_a?.[0]).toMatchObject({ state: { status: "completed", output: "done" } })
  })

  test("called promotes a pending part to running with the executed input", () => {
    const h = harness([pending()])
    const called: SessionNextToolCalled = {
      id: "evt_called",
      type: "session.next.tool.called",
      data: {
        timestamp: 150,
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        callID: "call_1",
        tool: "bash",
        input: { command: "ls" },
        provider: { executed: false },
      },
    }

    h.apply(called)

    expect(h.data.part.msg_a?.[0]).toMatchObject({
      state: {
        status: "running",
        input: { command: "ls" },
        metadata: { structured: {}, output: "" },
        time: { start: 150 },
      },
    })
    expect(h.counts).toEqual({ writes: 1, fallbacks: 0 })
  })

  test("input.ended lands on the pending part's raw text, and progress updates a running part", () => {
    const h = harness([pending()])
    const inputEnded: SessionNextToolInputEnded = {
      id: "evt_input",
      type: "session.next.tool.input.ended",
      data: {
        timestamp: 120,
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        callID: "call_1",
        text: '{"command":"ls"}',
      },
    }

    h.apply(inputEnded)
    expect(h.data.part.msg_a?.[0]).toMatchObject({ state: { status: "pending", raw: '{"command":"ls"}' } })

    const runningHarness = harness([running()])
    const progress: SessionNextToolProgress = {
      id: "evt_progress",
      type: "session.next.tool.progress",
      data: {
        timestamp: 160,
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        callID: "call_1",
        structured: { percent: 50 },
        content: [{ type: "text", text: "half done" }],
      },
    }

    runningHarness.apply(progress)
    expect(runningHarness.data.part.msg_a?.[0]).toMatchObject({
      state: {
        status: "running",
        metadata: { structured: { percent: 50 }, output: "half done" },
        time: { start: 100 },
      },
    })
    expect(runningHarness.counts).toEqual({ writes: 1, fallbacks: 0 })
  })

  test("stale live events on a settled part neither write nor fall back", () => {
    const h = harness([
      toolPart({
        status: "completed",
        input: { command: "ls" },
        output: "done",
        title: "bash",
        metadata: {},
        time: { start: 100, end: 150 },
      }),
    ])

    h.apply({
      id: "evt_progress",
      type: "session.next.tool.progress",
      data: {
        timestamp: 160,
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        callID: "call_1",
        structured: {},
        content: [],
      },
    })

    expect(h.counts).toEqual({ writes: 0, fallbacks: 0 })
  })
})

describe("expandSessionV2ToolBody", () => {
  const stub = () =>
    presentTool("ses_1", "msg_a", {
      type: "tool",
      id: "call_1",
      name: "bash",
      truncated: { bytes: 90_000 },
      state: {
        status: "completed",
        input: { command: "ls" },
        structured: {},
        content: [],
      },
      time: { created: 1, ran: 1, completed: 2 },
    })

  const fullMessage = (text = "total 4"): SessionMessage => ({
    id: "msg_a",
    type: "assistant",
    agent: "build",
    model: { providerID: "provider", id: "model" },
    time: { created: 1, completed: 2 },
    content: [
      {
        type: "tool",
        id: "call_1",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          structured: { exit: 0 },
          content: [{ type: "text", text }],
        },
        time: { created: 1, ran: 1, completed: 2 },
      },
    ],
  })

  const harness = (parts: Part[] | undefined) => {
    const [data, set] = createStore<{ part: Record<string, Part[] | undefined> }>({ part: { msg_a: parts } })
    return {
      data,
      write: (index: number, part: ToolPart) => set("part", "msg_a", index, reconcile(part)),
    }
  }

  test("expanding a stub fetches the message once and rewrites the part in place", async () => {
    const h = harness([stub()])
    let fetches = 0

    const applied = await expandSessionV2ToolBody({
      sessionID: "ses_1",
      part: h.data.part.msg_a![0] as ToolPart,
      load: async () => {
        fetches += 1
        return fullMessage()
      },
      parts: () => h.data.part.msg_a,
      write: h.write,
    })

    expect(applied).toBe(true)
    expect(fetches).toBe(1)
    expect(h.data.part.msg_a).toHaveLength(1)
    expect(h.data.part.msg_a?.[0]).toMatchObject({
      type: "tool",
      id: "call_1",
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "total 4",
        metadata: { structured: { exit: 0 } },
      },
    })
    expect(h.data.part.msg_a?.[0]?.type === "tool" ? h.data.part.msg_a[0].metadata?.truncated : "missing").toBeUndefined()
  })

  test("re-opening while the fetch is in flight issues no second request", async () => {
    const h = harness([stub()])
    let fetches = 0
    let release!: (message: SessionMessage) => void
    const load = () => {
      fetches += 1
      return new Promise<SessionMessage>((resolve) => (release = resolve))
    }

    const first = expandSessionV2ToolBody({
      sessionID: "ses_1",
      part: stub(),
      load,
      parts: () => h.data.part.msg_a,
      write: h.write,
    })
    const second = expandSessionV2ToolBody({
      sessionID: "ses_1",
      part: stub(),
      load,
      parts: () => h.data.part.msg_a,
      write: h.write,
    })

    await expect(second).resolves.toBe(false)
    release(fullMessage())
    await expect(first).resolves.toBe(true)
    expect(fetches).toBe(1)
  })

  // The race the post-fetch stub re-check exists for: while the back-fill is in flight, a
  // non-lean write (a context hydrate, an event settle, an expanded sibling's own fetch) can
  // already have put the real body in the store. The fetched copy must not clobber it.
  test("a full write that landed during the fetch is not overwritten by the back-fill", async () => {
    const h = harness([stub()])
    let release!: (message: SessionMessage) => void
    const pending = expandSessionV2ToolBody({
      sessionID: "ses_1",
      part: h.data.part.msg_a![0] as ToolPart,
      load: () => new Promise<SessionMessage>((resolve) => (release = resolve)),
      parts: () => h.data.part.msg_a,
      write: h.write,
    })

    h.write(
      0,
      presentTool("ses_1", "msg_a", {
        type: "tool",
        id: "call_1",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          structured: { exit: 0 },
          content: [{ type: "text", text: "settled live" }],
        },
        time: { created: 1, ran: 1, completed: 2 },
      }),
    )

    release(fullMessage())
    await expect(pending).resolves.toBe(false)
    expect(h.data.part.msg_a?.[0]).toMatchObject({ state: { status: "completed", output: "settled live" } })
    expect(h.data.part.msg_a?.[0]?.type === "tool" ? h.data.part.msg_a[0].metadata?.truncated : "missing").toBeUndefined()
  })

  test("a part that already carries its body is never fetched", async () => {
    const h = harness([stub()])
    await expect(
      expandSessionV2ToolBody({
        sessionID: "ses_1",
        part: h.data.part.msg_a![0] as ToolPart,
        load: async () => fullMessage(),
        parts: () => h.data.part.msg_a,
        write: h.write,
      }),
    ).resolves.toBe(true)

    let fetches = 0
    await expect(
      expandSessionV2ToolBody({
        sessionID: "ses_1",
        part: h.data.part.msg_a![0] as ToolPart,
        load: async () => {
          fetches += 1
          return fullMessage()
        },
        parts: () => h.data.part.msg_a,
        write: h.write,
      }),
    ).resolves.toBe(false)
    expect(fetches).toBe(0)
  })
})
