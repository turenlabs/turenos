import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Message, Part, SessionMessage } from "@turenlabs/sdk/v2/client"
import { SESSION_V2_MESSAGE_PAGE_LIMIT } from "./session-v2-message-window"

let createSessionV2TimelineController: typeof import("./session-v2-timeline-controller").createSessionV2TimelineController

// The transcripts each test session serves, newest-first pagination over `session.messages`.
// Cursor values are plain offsets, mirroring the benchmark page server: a request without
// `cursor` reads the newest page and `cursor.next` walks towards the session start.
const transcripts = new Map<string, SessionMessage[]>()
let requests: Array<Record<string, unknown>> = []

// Set before an in-flight assertion: the request carrying this cursor is held until released, so
// the test can move ownership between the fetch and the store write.
let held:
  | { cursor: string; seen: Promise<void>; gate: Promise<void>; arrive: () => void; release: () => void }
  | undefined

const holdRequest = (cursor: string) => {
  let arrive!: () => void
  let release!: () => void
  const request = {
    cursor,
    seen: new Promise<void>((resolve) => (arrive = resolve)),
    gate: new Promise<void>((resolve) => (release = resolve)),
    arrive: () => arrive(),
    release: () => release(),
  }
  held = request
  return request
}

const [data, setData] = createStore<{
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  session_status: Record<string, { type: string } | undefined>
}>({ message: {}, part: {}, session_status: {} })

const optimisticIDs = new Map<string, Set<string>>()

const dirsync = {
  data,
  set: (...args: unknown[]) => (setData as (...input: unknown[]) => unknown)(...args),
  session: {
    optimistic: {
      add(input: { sessionID: string; message: Message; parts: Part[] }) {
        const ids = optimisticIDs.get(input.sessionID) ?? new Set<string>()
        ids.add(input.message.id)
        optimisticIDs.set(input.sessionID, ids)
        setData("message", input.sessionID, (messages: Message[] | undefined = []) =>
          [...messages.filter((message) => message.id !== input.message.id), input.message].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          ),
        )
        setData("part", input.message.id, input.parts)
      },
      remove(input: { sessionID: string; messageID: string }) {
        if (!optimisticIDs.get(input.sessionID)?.delete(input.messageID)) return
        setData(
          "message",
          input.sessionID,
          (messages: Message[] | undefined) => (messages ?? []).filter((message) => message.id !== input.messageID),
        )
      },
    },
    statusRevision: () => 0,
    holdStatusSettlement: () => () => {},
  },
}

const admission = {
  watch: () => ({ dispose: () => {}, refresh: () => {}, pause: () => {} }),
  settle: () => {},
  error: () => undefined,
  get: () => undefined,
}

const messagesEndpoint = async (payload: { sessionID: string; limit: number; order?: string; cursor?: string }) => {
  requests.push(payload)
  if (held && payload.cursor === held.cursor) {
    held.arrive()
    await held.gate
  }
  const source = transcripts.get(payload.sessionID) ?? []
  const start = payload.cursor === undefined ? 0 : Number(payload.cursor)
  const page = [...source].reverse().slice(start, start + payload.limit)
  return {
    data: {
      data: page,
      cursor: { next: start + payload.limit < source.length ? String(start + payload.limit) : undefined },
    },
  }
}

const sdkValue = {
  directory: "/repo",
  scope: "local",
  client: {
    v2: {
      session: {
        pendingInputs: async () => ({ data: { data: [] } }),
        messages: messagesEndpoint,
        inputStatus: async () => ({ data: { data: { status: "promoted" } } }),
        history: async () => ({ data: { latest: 0 } }),
        active: async () => ({ data: { data: {} } }),
        // The durable stream is never opened in tests; snapshots are driven directly.
        events: () => new Promise(() => {}),
      },
    },
  },
  event: { on: () => () => {} },
}

beforeAll(async () => {
  // `mock.module` replaces the module for the whole `bun test` process; the controller under
  // test is imported afterwards so its context hooks resolve to these stubs.
  mock.module("@/context/sdk", () => ({ useSDK: () => () => sdkValue }))
  mock.module("@/context/sync", () => ({ useSync: () => () => dirsync }))
  mock.module("@/context/platform", () => ({ usePlatform: () => ({}) }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/components/prompt-input/prompt-admission", () => ({ promptAdmissionFor: () => admission }))
  const mod = await import("./session-v2-timeline-controller")
  createSessionV2TimelineController = mod.createSessionV2TimelineController
})

beforeEach(() => {
  transcripts.clear()
  optimisticIDs.clear()
  requests = []
  held = undefined
  // `set("message", {})` merges into the existing record rather than replacing it; only a root
  // reconcile clears the rows a previous test wrote.
  setData(reconcile({ message: {}, part: {}, session_status: {} }))
})

const assistant = (id: string, created: number): SessionMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  content: [{ id: `${id}_text`, type: "text", text: `reply ${id}` }],
  time: { created },
})

// Three messages per turn — user, then two assistant messages — so a page boundary at a multiple
// of three lands mid-turn: the message just above the boundary is an assistant whose parent user
// message is in the previous page. Exactly the shape the orphan carry exists for.
const transcript = (turns: number) =>
  Array.from({ length: turns }, (_, turn): SessionMessage[] => [
    { id: `msg_u${turn}`, type: "user", text: `prompt ${turn}`, time: { created: turn * 3 } },
    assistant(`msg_a${turn}_1`, turn * 3 + 1),
    assistant(`msg_a${turn}_2`, turn * 3 + 2),
  ]).flat()

const turnIDs = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => {
    const turn = from + index
    return [`msg_u${turn}`, `msg_a${turn}_1`, `msg_a${turn}_2`]
  }).flat()

const ids = (sessionID: string) => (data.message[sessionID] ?? []).map((message) => message.id)

const spawn = (input: { sessionID: () => string | undefined; sessionKey: () => string }) =>
  createRoot((dispose) => ({
    dispose,
    controller: createSessionV2TimelineController({
      sessionID: input.sessionID,
      sessionKey: input.sessionKey,
      agent: () => "build",
      model: () => ({ providerID: "provider", modelID: "model" }),
    }),
  }))

describe("session V2 history prepend", () => {
  test("loadOlder issues exactly one cursor request with no order and splices the page in front", async () => {
    // 50 turns = 150 messages. The windowed hydrate covers messages[100..149] (the newest page),
    // which opens on `msg_a33_1` — mid-turn, so the presenter drops it and the two assistants of
    // turn 33 stay out of the store until their parent `msg_u33` arrives.
    transcripts.set("ses_a", transcript(50))
    const { controller, dispose } = spawn({ sessionID: () => undefined, sessionKey: () => "key-a" })
    try {
      await controller.hydrate("ses_a")
      expect(ids("ses_a")).toEqual(turnIDs(34, 49))
      expect(controller.hasOlder("ses_a")).toBe(true)

      requests = []
      await controller.loadOlder("ses_a")

      expect(requests).toEqual([
        { sessionID: "ses_a", limit: SESSION_V2_MESSAGE_PAGE_LIMIT, lean: "true", cursor: "50" },
      ])
      expect(ids("ses_a")).toEqual(turnIDs(17, 49))
      expect(controller.hasOlder("ses_a")).toBe(true)

      await controller.loadOlder("ses_a")
      expect(ids("ses_a")).toEqual(turnIDs(0, 49))
      // The last page has no `cursor.next`, so the window is complete and the affordance retires.
      expect(controller.hasOlder("ses_a")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("a page that opens mid-turn carries its leading assistants until their parent loads", async () => {
    transcripts.set("ses_a", transcript(50))
    const { controller, dispose } = spawn({ sessionID: () => undefined, sessionKey: () => "key-a" })
    try {
      await controller.hydrate("ses_a")
      // The window opens on `msg_a33_1`, whose parent `msg_u33` is one page back.
      expect(ids("ses_a")).not.toContain("msg_a33_1")
      expect(ids("ses_a")).not.toContain("msg_a33_2")

      await controller.loadOlder("ses_a")
      // The prepend brought in `msg_u33`, so both assistants are now presented and parented.
      expect(ids("ses_a")).toContain("msg_a33_1")
      expect(data.message["ses_a"]?.find((message) => message.id === "msg_a33_1")).toMatchObject({
        role: "assistant",
        parentID: "msg_u33",
      })
      expect(data.message["ses_a"]?.find((message) => message.id === "msg_a33_2")).toMatchObject({
        role: "assistant",
        parentID: "msg_u33",
      })
      // But this page also opened mid-turn: `msg_a16_2`'s parent `msg_u16` is still a page away.
      expect(ids("ses_a")).not.toContain("msg_a16_2")

      await controller.loadOlder("ses_a")
      expect(data.message["ses_a"]?.find((message) => message.id === "msg_a16_2")).toMatchObject({
        role: "assistant",
        parentID: "msg_u16",
      })
      expect(ids("ses_a")[0]).toBe("msg_u0")
    } finally {
      dispose()
    }
  })

  test("a prepend that resolves after the session changed does not write into the store", async () => {
    transcripts.set("ses_a", transcript(50))
    transcripts.set("ses_b", transcript(2))
    const [sessionID, setSessionID] = createSignal<string | undefined>("ses_a")
    const [sessionKey, setSessionKey] = createSignal("key-a")
    const { controller, dispose } = spawn({ sessionID, sessionKey })
    try {
      await controller.hydrate("ses_a")
      const before = ids("ses_a")
      expect(before.length).toBeGreaterThan(0)

      const gate = holdRequest("50")
      const pending = controller.loadOlder("ses_a")
      await gate.seen

      // Switch sessions before the page lands: ownership moves immediately and `requested`
      // follows once ses_b's own snapshot is issued.
      setSessionKey("key-b")
      setSessionID("ses_b")
      for (let i = 0; i < 50 && !requests.some((request) => request.sessionID === "ses_b"); i++)
        await new Promise((resolve) => setTimeout(resolve, 0))
      gate.release()
      await pending

      expect(ids("ses_a")).toEqual(before)
    } finally {
      dispose()
    }
  })
})
