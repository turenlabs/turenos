import { describe, expect, test } from "bun:test"
import type { MessagesListOutput } from "@turenlabs/client"
import { activityFrame } from "../src/activity"
import { createDashboardState, type DashboardState, type ModalState } from "../src/state"

function dashboard(): DashboardState {
  return {
    ...createDashboardState(),
    connected: true,
    selected: "ses_test",
    snapshot: {
      location: { directory: "/project", project: { id: "project", directory: "/project" } },
      sessions: [],
      active: {},
      terminals: [],
      terminalsAvailable: true,
      loops: [],
      inventoryErrors: { terminals: "", automations: "" },
      updated: 1,
      more: false,
    },
    detail: {
      sessionID: "ses_test",
      messages: [],
      cursor: {},
      tasks: { data: [], active: [], cursor: {} },
      permissions: [],
      questions: [],
      pending: [],
      todos: [],
    },
  }
}

function assistant(content: Extract<MessagesListOutput["data"][number], { type: "assistant" }>["content"] = []) {
  return {
    id: "msg_assistant",
    type: "assistant" as const,
    agent: "build",
    model: { providerID: "test", id: "test" },
    time: { created: 1 },
    content,
  }
}

function tool(
  name = "read_file",
  state: Extract<ReturnType<typeof assistant>["content"][number], { type: "tool" }>["state"] = {
    status: "running",
    input: {},
    structured: {},
    content: [],
  },
) {
  return { id: "part_tool", type: "tool" as const, name, state, time: { created: 1 } }
}

describe("activity frames", () => {
  test("idle sessions, absent selections, and non-session views have no activity", () => {
    const state = dashboard()
    expect(activityFrame(state, 0, false)).toBeUndefined()
    state.snapshot!.active = { ses_other: { type: "running" } }
    expect(activityFrame(state, 0, false)).toBeUndefined()
    state.snapshot!.active = { ses_test: { type: "running" } }
    for (const tab of ["terminals", "automations"] as const) {
      state.tab = tab
      expect(activityFrame(state, 0, false)).toBeUndefined()
    }
    state.tab = "sessions"
    state.selected = ""
    expect(activityFrame(state, 0, false)).toBeUndefined()
    state.selected = "ses_test"
    state.snapshot = undefined
    expect(activityFrame(state, 0, false)).toBeUndefined()
  })

  test("activity requires the selected session's own active-map entry", () => {
    const state = dashboard()
    state.selected = "toString"
    expect(activityFrame(state, 0, false)).toBeUndefined()
    state.selected = "ses_test"
    state.snapshot!.active = Object.create({ ses_test: { type: "running" } })
    expect(activityFrame(state, 0, false)).toBeUndefined()
    state.snapshot!.active = { ses_test: { type: "running" } }
    state.detail = undefined
    expect(activityFrame(state, 0, false)).toEqual({
      content: "Working (Esc Esc to stop) \u2828\u2869\u2824",
      tone: "accent",
      animate: true,
    })
  })

  test("busy forms take priority over disconnection and pending input", () => {
    const state = dashboard()
    state.connected = false
    state.connectionError = "Offline"
    state.detail!.questions = [{ id: "que_test", sessionID: "ses_test", questions: [] }]
    // The formatter only reads these flags, not the form's renderer objects.
    state.modal = { busy: true } as ModalState
    expect(activityFrame(state, 0, false)).toEqual({
      content: "Applying request \u2828\u2869\u2824",
      tone: "accent",
      animate: true,
    })
    state.modal = { busy: true, editor: {} } as ModalState
    expect(activityFrame(state, 0, false)).toEqual({
      content: "Sending message \u2828\u2869\u2824",
      tone: "accent",
      animate: true,
    })
    state.connected = true
    expect(activityFrame(state, 0, false)?.content).toBe("Sending message \u2828\u2869\u2824")
    state.modal.editor = undefined
    expect(activityFrame(state, 0, false)?.content).toBe("Applying request \u2828\u2869\u2824")
    state.modal.busy = false
    expect(activityFrame(state, 0, false)?.content).toBe("? Needs your input")
    state.connected = false
    expect(activityFrame(state, 0, false)?.content).toBe("! Disconnected")
  })

  test("connecting is indeterminate, but disconnection stays static over stale work and requests", () => {
    const state = dashboard()
    state.connected = false
    state.snapshot!.active = { ses_test: { type: "running" } }
    state.detail!.questions = [{ id: "que_test", sessionID: "ses_test", questions: [] }]
    expect(activityFrame(state, 0, false)).toEqual({
      content: "Connecting \u2828\u2869\u2824",
      tone: "muted",
      animate: true,
    })
    expect(activityFrame(createDashboardState(), 0, false)?.content).toBe("Connecting \u2828\u2869\u2824")
    state.connectionError = "Untrusted error\u001b\nsecret detail"
    for (const reducedMotion of [false, true]) {
      for (const frame of [0, 6, 13, 1000]) {
        expect(activityFrame(state, frame, reducedMotion)).toEqual({
          content: "! Disconnected",
          tone: "error",
          animate: false,
        })
      }
    }
  })

  for (const request of ["permissions", "questions"] as const) {
    test(`${request} require explicit input and never animate, even while the session is active`, () => {
      const state = dashboard()
      if (request === "permissions")
        state.detail!.permissions = [{ id: "per_test", sessionID: "ses_test", action: "shell", resources: [] }]
      if (request === "questions") state.detail!.questions = [{ id: "que_test", sessionID: "ses_test", questions: [] }]
      for (const active of [false, true]) {
        state.snapshot!.active = active ? { ses_test: { type: "running" } } : {}
        for (const reducedMotion of [false, true]) {
          for (const frame of [0, 6, 13]) {
            expect(activityFrame(state, frame, reducedMotion)).toEqual({
              content: "? Needs your input",
              tone: "warning",
              animate: false,
            })
          }
        }
      }
    })
  }

  test("another session's detail cannot supply requests or a running tool", () => {
    const state = dashboard()
    state.detail!.sessionID = "ses_other"
    state.detail!.permissions = [{ id: "per_other", sessionID: "ses_other", action: "shell", resources: [] }]
    state.detail!.questions = [{ id: "que_other", sessionID: "ses_other", questions: [] }]
    state.detail!.messages = [assistant([tool()])]
    expect(activityFrame(state, 0, false)).toBeUndefined()
    state.snapshot!.active = { ses_test: { type: "running" } }
    expect(activityFrame(state, 0, false)?.content).toBe("Working (Esc Esc to stop) \u2828\u2869\u2824")
  })

  test("delegated tasks and queued inputs do not imply waiting or execution", () => {
    const state = dashboard()
    const task = {
      id: "task_test",
      rootSessionID: "ses_test",
      parentSessionID: "ses_test",
      childSessionID: "ses_child",
      agent: "explore",
      description: "Delegated work",
      depth: 1,
      status: "running" as const,
      revision: 1,
      time: { created: 1, updated: 1 },
    }
    state.detail!.tasks = { data: [task], active: [task], cursor: {} }
    state.detail!.pending = [
      {
        admittedSeq: 1,
        id: "msg_pending",
        sessionID: "ses_test",
        prompt: { text: "Queued input" },
        delivery: "queue",
        timeCreated: 1,
      },
    ]
    expect(activityFrame(state, 0, false)).toBeUndefined()
    state.snapshot!.active = { ses_test: { type: "running" } }
    expect(activityFrame(state, 0, false)?.content).toBe("Working (Esc Esc to stop) \u2828\u2869\u2824")
  })

  test("only a running tool in the actual latest message supplies a specific label", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    const running = assistant([
      tool("completed", { status: "completed", input: {}, structured: {}, content: [] }),
      tool("pending", { status: "pending", input: "" }),
      tool("search"),
      { type: "text", id: "part_text", text: "A readable update" },
    ])
    state.detail!.messages = [running]
    expect(activityFrame(state, 0, false)?.content).toBe("Running search (Esc Esc to stop) \u2828\u2869\u2824")
    const newer: MessagesListOutput["data"] = [
      assistant(),
      assistant([{ type: "text", id: "part_reply", text: "Finished" }]),
      { type: "user", id: "msg_user", text: "Next task", time: { created: 2 } },
      { type: "model-switched", id: "msg_switch", model: { providerID: "test", id: "next" }, time: { created: 2 } },
    ]
    for (const message of newer) {
      state.detail!.messages = [running, message]
      expect(activityFrame(state, 0, false)?.content).toBe("Working (Esc Esc to stop) \u2828\u2869\u2824")
    }
    for (const part of [
      tool("pending", { status: "pending", input: "" }),
      tool("completed", { status: "completed", input: {}, structured: {}, content: [] }),
      tool("failed", {
        status: "error",
        input: {},
        structured: {},
        content: [],
        error: { type: "unknown", message: "Failed" },
      }),
    ]) {
      state.detail!.messages = [assistant([part])]
      expect(activityFrame(state, 0, false)?.content).toBe("Working (Esc Esc to stop) \u2828\u2869\u2824")
    }
    state.detail!.messages = [running]
    state.snapshot!.active = {}
    expect(activityFrame(state, 0, false)).toBeUndefined()
  })

  test("older history pages do not relabel current execution using historical tools", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    state.detail!.messages = [assistant([tool()])]
    state.history = true
    state.historyCursor = "older-page"
    expect(activityFrame(state, 0, false)?.content).toBe("Working (Esc Esc to stop) \u2828\u2869\u2824")
    state.historyCursor = undefined
    expect(activityFrame(state, 0, false)?.content).toBe("Running read_file (Esc Esc to stop) \u2828\u2869\u2824")
    state.history = false
    state.historyCursor = "saved-history-position"
    expect(activityFrame(state, 0, false)?.content).toBe("Running read_file (Esc Esc to stop) \u2828\u2869\u2824")
  })

  test("dotted particle orbits loop every 24 ticks in three Braille cells", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    const frames = Array.from({ length: 24 }, (_, frame) => activityFrame(state, frame, false)!)
    expect(frames[0]!.content).toBe("Working (Esc Esc to stop) \u2828\u2869\u2824")
    expect(new Set(frames.map((frame) => frame.content)).size).toBeGreaterThan(16)
    for (let frame = -48; frame <= 48; frame++) {
      const result = activityFrame(state, frame, false)!
      expect(result.content).toMatch(/^Working \(Esc Esc to stop\) [\u2800-\u28ff]{3}$/)
      expect(result.content).toHaveLength(29)
      expect(result.content).not.toMatch(/%|ETA|\d|#/)
      expect(result.animate).toBe(true)
      expect(result).toEqual(activityFrame(state, frame + 24, false)!)
    }
    for (const frame of [NaN, Infinity, -Infinity, 0.5, -0.5, Number.MAX_SAFE_INTEGER, -Number.MAX_VALUE]) {
      expect(frames.map((result) => result.content)).toContain(activityFrame(state, frame, false)!.content)
    }
  })

  test("reduced motion freezes the globe but preserves every activity label", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    for (const activity of ["Working", "Running read_file", "Connecting", "Applying request", "Sending message"]) {
      if (activity === "Running read_file") state.detail!.messages = [assistant([tool()])]
      if (activity === "Connecting") state.connected = false
      if (activity === "Applying request") state.modal = { busy: true } as ModalState
      if (activity === "Sending message") state.modal = { busy: true, editor: {} } as ModalState
      for (const frame of [0, 1, 6, 12, 13, 10000]) {
        expect(activityFrame(state, frame, true)).toEqual({
          content: `${activity}${activity.startsWith("Working") || activity.startsWith("Running") ? " (Esc Esc to stop)" : ""} \u2828\u2869\u2824`,
          tone: activity === "Connecting" ? "muted" : "accent",
          animate: false,
        })
      }
    }
  })

  test("untrusted tool names are bounded, terminal-sanitized single-line labels", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    state.detail!.messages = [
      assistant([tool("read\u001b\u0007\u009b\u202e\u2066\u200f\u061c\n\tfile" + "x".repeat(100000))]),
    ]
    for (const reducedMotion of [false, true]) {
      const result = activityFrame(state, 6, reducedMotion)!
      expect(result.content).toStartWith("Running read  file")
      expect(result.content).toContain("[display shortened]")
      expect(result.content.length).toBeLessThanOrEqual(128)
      expect(result.content).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/)
    }
    state.detail!.messages = [assistant([tool("\u001b\u0007\n\t")])]
    expect(activityFrame(state, 0, false)?.content).toBe("Running tool (Esc Esc to stop) \u2828\u2869\u2824")
  })
})

describe("retries and elapsed time", () => {
  const user = (created: number) =>
    ({ id: "msg_user", type: "user", text: "go", time: { created } }) as unknown as MessagesListOutput["data"][number]

  test("a running turn shows how long it has run and how to stop it", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    state.detail!.messages = [user(Date.now() - 75_000)]
    expect(activityFrame(state, 0, true)?.content).toBe("Working (1m 15s · Esc Esc to stop) ⠨⡩⠤")
    state.detail!.messages = [user(Date.now() - 2 * 86_400_000)]
    expect(activityFrame(state, 0, true)?.content).toBe("Working (Esc Esc to stop) ⠨⡩⠤")
  })

  test("a pending provider retry replaces Working with the wait, attempt and reason", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    state.retries = { ses_test: { attempt: 3, at: Date.now() + 4000, message: "HTTP 503: provider is busy" } }
    expect(activityFrame(state, 0, true)).toEqual({
      content: "Retrying in 4s (attempt 3 · Esc Esc to stop): HTTP 503: provider is busy ⠨⡩⠤",
      tone: "warning",
      animate: false,
    })
    state.retries.ses_test!.at = Date.now() - 1000
    expect(activityFrame(state, 0, true)?.content).toStartWith("Retrying now (attempt 3 · Esc Esc to stop)")
  })

  test("another session's retry does not relabel the selected session", () => {
    const state = dashboard()
    state.snapshot!.active = { ses_test: { type: "running" } }
    state.retries = { ses_other: { attempt: 1, at: Date.now(), message: "" } }
    expect(activityFrame(state, 0, true)?.content).toBe("Working (Esc Esc to stop) ⠨⡩⠤")
  })
})
