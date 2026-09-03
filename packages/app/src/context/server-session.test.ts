import { describe, expect, test } from "bun:test"
import type { Message, ForgeClient, Part, Session } from "@turenlabs/sdk/v2/client"
import { createServerSession, sessionNextStatusTransition } from "./server-session"

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  parentID,
  time: { created: 1, updated: 1 },
})

type UserMessage = Extract<Message, { role: "user" }>
type TextPart = Extract<Part, { type: "text" }>

const userMessage = (id: string, input: Partial<UserMessage> = {}): UserMessage => ({
  id,
  sessionID: "child",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
  ...input,
})

const textPart = (messageID: string, input: Partial<TextPart> = {}): TextPart => ({
  id: "part",
  sessionID: "child",
  messageID,
  type: "text",
  text: "text",
  ...input,
})

function setup(sessions: Record<string, Session>) {
  const get: unknown[] = []
  const client = {
    session: {
      get: async (input: unknown) => {
        get.push(input)
        const id = (input as { sessionID: string }).sessionID
        return { data: sessions[id] }
      },
      diff: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
    },
  } as unknown as ForgeClient
  return { get, store: createServerSession(client) }
}

describe("server session", () => {
  test("resolves lineage by session ID without directory", async () => {
    const ctx = setup({ child: session("child", "root"), root: session("root") })

    const result = await ctx.store.lineage.resolve("child")

    expect(result.root.id).toBe("root")
    expect(ctx.get).toEqual([{ sessionID: "child" }, { sessionID: "root" }])
    expect(ctx.store.lineage.peek("child")).toEqual(result)
  })

  // The Session V2 timeline controller owns transcript hydration. This store must resolve
  // session metadata and nothing else — in particular it must never issue a transcript
  // read, because the legacy `GET /session/:id/message` endpoint answers a permanent 404
  // for every session that can exist.
  test("syncs session metadata without reading any transcript endpoint", async () => {
    const calls: string[] = []
    const client = {
      session: {
        get: async () => {
          calls.push("get")
          return { data: session("root") }
        },
        messages: async () => {
          calls.push("messages")
          throw new Error("legacy transcript endpoint must never be called")
        },
        message: async () => {
          calls.push("message")
          throw new Error("legacy transcript endpoint must never be called")
        },
      },
    } as unknown as ForgeClient
    const store = createServerSession(client)

    await store.sync("root")
    await store.sync("root", { force: true })
    await store.prefetch("root")

    expect(calls).toEqual(["get", "get"])
    expect(store.get("root")?.id).toBe("root")
  })

  test("clears delta buffers when removing optimistic content", () => {
    const message = userMessage("message")
    const part = textPart(message.id, { text: "optimistic" })
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: part.id, field: "text", delta: " delta" },
    })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.part[message.id]).toBeUndefined()
    expect(store.data.part_text_accum_delta[part.id]).toBeUndefined()
  })

  test("does not remove content confirmed by a message event", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({ type: "message.updated", properties: { sessionID: "child", info: message } })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("does not remove parts confirmed by part events", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({ type: "message.updated", properties: { sessionID: "child", info: message } })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([part])
  })

  test("treats a part event as confirmation when it precedes the message event", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [part] })
    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })

    store.optimistic.remove({ sessionID: "child", messageID: message.id })

    expect(store.data.message.child).toEqual([message])
    expect(store.data.part[message.id]).toEqual([part])
  })

  test("ignores a late part update after a completed message removal", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store
    store.apply({ type: "message.updated", properties: { info: message } })
    store.apply({ type: "message.removed", properties: { sessionID: "child", messageID: message.id } })

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("drops a part update whose parent message is unknown", () => {
    const message = userMessage("message")
    const part = textPart(message.id)
    const store = setup({ child: session("child") }).store

    store.apply({ type: "message.part.updated", properties: { sessionID: "child", part, time: 2 } })

    expect(store.data.part[message.id]).toBeUndefined()
  })

  test("does not cache skipped optimistic parts", () => {
    const message = userMessage("message")
    const part = { id: "part", sessionID: "child", messageID: message.id, type: "step-start" as const }
    const store = setup({ child: session("child") }).store

    store.optimistic.add({ sessionID: "child", message, parts: [part] })

    expect(store.data.part[message.id]).toEqual([])
  })

  test("clears stale delta buffers when replacing optimistic parts", () => {
    const message = userMessage("message")
    const stale = textPart(message.id, { id: "stale", text: "stale" })
    const optimistic = textPart(message.id, { id: "optimistic", text: "optimistic" })
    const store = setup({ child: session("child") }).store
    store.optimistic.add({ sessionID: "child", message, parts: [stale] })
    store.apply({
      type: "message.part.delta",
      properties: { sessionID: "child", messageID: message.id, partID: stale.id, field: "text", delta: " delta" },
    })

    store.optimistic.add({ sessionID: "child", message, parts: [optimistic] })

    expect(store.data.part_text_accum_delta[stale.id]).toBeUndefined()
    expect(store.data.part_text_accum_delta[optimistic.id]).toBeUndefined()
  })

  test("applies events without a directory store", () => {
    const ctx = setup({})
    ctx.store.apply({ type: "session.created", properties: { sessionID: "root", info: session("root") } })
    ctx.store.apply({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })

    expect(ctx.store.get("root")?.directory).toBe("/repo")
    expect(ctx.store.data.session_working("root")).toBe(true)
    expect(ctx.get).toEqual([])
  })

  test("does not retain internal lobby session metadata or status in global navigation state", () => {
    const ctx = setup({})
    ctx.store.apply({
      type: "session.created",
      properties: {
        sessionID: "ses_lobby_hidden",
        info: { ...session("ses_lobby_hidden"), metadata: { "forge.internal": true } },
      },
    })
    ctx.store.apply({
      type: "session.status",
      properties: { sessionID: "ses_lobby_hidden", status: { type: "busy" } },
    })

    expect(ctx.store.get("ses_lobby_hidden")).toBeUndefined()
    expect(ctx.store.data.session_status.ses_lobby_hidden).toBeUndefined()
  })

  test("clears status entries that disappear from a directory snapshot without session metadata", () => {
    const ctx = setup({})

    ctx.store.setStatuses("/repo", { unknown: { type: "busy" } })
    expect(ctx.store.data.session_status.unknown).toEqual({ type: "busy" })

    ctx.store.setStatuses("/repo", {})

    expect(ctx.store.data.session_status.unknown).toBeUndefined()
  })

  test("keeps an unowned local status until metadata gives it a directory owner", () => {
    const ctx = setup({})

    ctx.store.set("session_status", "unknown", { type: "busy" })
    ctx.store.setStatuses("/repo", {})

    expect(ctx.store.data.session_status.unknown).toEqual({ type: "busy" })

    ctx.store.remember(session("unknown"))
    ctx.store.setStatuses("/repo", {})

    expect(ctx.store.data.session_status.unknown).toBeUndefined()
  })

  test("does not overwrite a newer live status with an older directory snapshot", () => {
    const ctx = setup({})
    const snapshotRevision = ctx.store.beginStatusSnapshot()

    ctx.store.apply({ type: "session.next.step.started", properties: { sessionID: "unknown", timestamp: 1 } }, "/repo")
    ctx.store.setStatuses("/repo", {}, snapshotRevision)

    expect(ctx.store.data.session_status.unknown).toEqual({ type: "busy" })
  })

  test("does not clear a status after a newer status event arrives", () => {
    const ctx = setup({})
    const snapshotRevision = ctx.store.beginStatusSnapshot()
    ctx.store.setStatuses("/repo", { unknown: { type: "busy" } }, snapshotRevision)
    const staleSnapshotRevision = ctx.store.beginStatusSnapshot()

    ctx.store.apply({ type: "session.status", properties: { sessionID: "unknown", status: { type: "idle" } } }, "/repo")
    ctx.store.setStatuses("/repo", {}, staleSnapshotRevision)

    expect(ctx.store.data.session_status.unknown).toEqual({ type: "idle" })
  })

  test("ignores an older directory snapshot that completes after a newer one", () => {
    const ctx = setup({})
    const olderRevision = ctx.store.beginStatusSnapshot()
    const newerRevision = ctx.store.beginStatusSnapshot()

    ctx.store.setStatuses("/repo", { newer: { type: "busy" } }, newerRevision)
    ctx.store.setStatuses("/repo", { older: { type: "busy" } }, olderRevision)

    expect(ctx.store.data.session_status.newer).toEqual({ type: "busy" })
    expect(ctx.store.data.session_status.older).toBeUndefined()
  })

  // `pin` is what keeps the on-screen session safe from cache eviction while the V2
  // timeline controller hydrates it, now that there is no in-flight transcript load to
  // protect it instead.
  test("preserves pinned session content under server-wide cache pressure", () => {
    const ctx = setup({})
    ctx.store.pin("active")
    ctx.store.optimistic.add({
      sessionID: "active",
      message: {
        id: "message",
        sessionID: "active",
        role: "assistant",
        time: { created: 1 },
        parentID: "parent",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "agent",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    })

    for (let index = 0; index < 50; index++) {
      ctx.store.remember(session(`session-${index}`))
      ctx.store.apply({
        type: "session.status",
        properties: { sessionID: `session-${index}`, status: { type: "idle" } },
      })
    }

    expect(ctx.store.data.message.active?.map((message) => message.id)).toEqual(["message"])
    expect(ctx.store.data.session_status["session-0"]).toBeUndefined()
  })
})

describe("background session status", () => {
  // The nav rail, sidebar and tab strip read `data.session_status` from this store, and
  // the focused session's V2 controller is torn down on tab switch — so lifecycle events
  // arriving on the global stream are the only way a background session's completion can
  // reach those surfaces.
  const setupBackground = (active: () => Record<string, unknown>) => {
    const activeCalls: number[] = []
    const client = {
      session: {
        get: async (input: unknown) => ({ data: session((input as { sessionID: string }).sessionID) }),
        diff: async () => ({ data: [] }),
        todo: async () => ({ data: [] }),
      },
      v2: {
        session: {
          active: async () => {
            activeCalls.push(Date.now())
            return { data: { data: active() } }
          },
        },
      },
    } as unknown as ForgeClient
    return { activeCalls, store: createServerSession(client) }
  }

  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3_000
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  }

  test("maps lifecycle events to status intents", () => {
    expect(sessionNextStatusTransition("session.next.step.started")).toBe("busy")
    expect(sessionNextStatusTransition("session.next.shell.started")).toBe("busy")
    expect(sessionNextStatusTransition("session.next.compaction.started")).toBe("busy")
    expect(sessionNextStatusTransition("session.next.step.ended")).toBe("settle")
    expect(sessionNextStatusTransition("session.next.step.failed")).toBe("settle")
    expect(sessionNextStatusTransition("session.next.shell.ended")).toBe("settle")
    expect(sessionNextStatusTransition("session.next.compaction.ended")).toBe("settle")
    expect(sessionNextStatusTransition("session.next.compaction.failed")).toBe("settle")
    // Deltas and prompts carry no phase meaning for the busy indicator.
    expect(sessionNextStatusTransition("session.next.text.delta")).toBeUndefined()
    expect(sessionNextStatusTransition("session.next.prompted")).toBeUndefined()
  })

  test("a step.started on the global stream marks a background session busy, and step.ended settles it idle once the server stops reporting it", async () => {
    let active: Record<string, unknown> = { bg: { sessionID: "bg" } }
    const ctx = setupBackground(() => active)

    ctx.store.apply({ type: "session.next.step.started", properties: { sessionID: "bg", timestamp: 1 } })
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "busy" })

    active = {}
    ctx.store.apply({ type: "session.next.step.ended", properties: { sessionID: "bg", timestamp: 2 } })
    await until(() => ctx.store.data.session_status["bg"]?.type === "idle")
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "idle" })
  })

  test("a step boundary forces a session metadata refresh so cost stays live", async () => {
    let gets = 0
    const client = {
      session: {
        get: async () => {
          gets += 1
          return { data: { ...session("bg"), cost: gets } }
        },
        diff: async () => ({ data: [] }),
        todo: async () => ({ data: [] }),
      },
      v2: { session: { active: async () => ({ data: { data: {} } }) } },
    } as unknown as ForgeClient
    const store = createServerSession(client)

    // Cached up front, so the only thing that can fetch again is the forced refresh.
    store.remember(session("bg"))
    store.apply({ type: "session.next.step.started", properties: { sessionID: "bg", timestamp: 1 } })
    expect(gets).toBe(0)

    store.apply({ type: "session.next.step.ended", properties: { sessionID: "bg", timestamp: 2 } })
    await until(() => gets >= 1)
    await until(() => store.data.info["bg"]?.cost === 1)
    expect(store.data.info["bg"]?.cost).toBe(1)
    expect(gets).toBe(1)
  })

  test("a mid-turn step boundary stays busy while the server still reports the session", async () => {
    const ctx = setupBackground(() => ({ bg: { sessionID: "bg" } }))

    ctx.store.apply({ type: "session.next.step.started", properties: { sessionID: "bg", timestamp: 1 } })
    ctx.store.apply({ type: "session.next.step.ended", properties: { sessionID: "bg", timestamp: 2 } })

    // step.ended does not mean the turn is over; the store must ask the server rather
    // than guess, and keep the indicator up while the session is still reported active.
    await until(() => ctx.activeCalls.length >= 1)
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "busy" })
  })

  test("does not settle a focused session while its terminal transcript refresh is held", async () => {
    const ctx = setupBackground(() => ({}))

    ctx.store.apply({ type: "session.next.step.started", properties: { sessionID: "bg", timestamp: 1 } })
    const release = ctx.store.holdStatusSettlement("bg")
    ctx.store.apply({ type: "session.next.step.ended", properties: { sessionID: "bg", timestamp: 2 } })

    await until(() => ctx.activeCalls.length >= 1)
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "busy" })

    release()
    await until(() => ctx.store.data.session_status["bg"]?.type === "idle")
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "idle" })
  })

  test("tracks a shared revision for every status writer", () => {
    const ctx = setup({})
    const initial = ctx.store.statusRevision("bg")

    ctx.store.set("session_status", "bg", { type: "busy" })
    const busy = ctx.store.statusRevision("bg")
    ctx.store.set("session_status", "bg", { type: "idle" })

    expect(busy).toBeGreaterThan(initial)
    expect(ctx.store.statusRevision("bg")).toBeGreaterThan(busy)
  })

  test("directory snapshots respect focused settlement holds and advance shared revisions", () => {
    const ctx = setup({ bg: session("bg") })
    ctx.store.remember(session("bg"))
    ctx.store.set("session_status", "bg", { type: "busy" })
    const busy = ctx.store.statusRevision("bg")
    const release = ctx.store.holdStatusSettlement("bg")

    ctx.store.setStatuses("/repo", {}, ctx.store.beginStatusSnapshot())
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "busy" })
    expect(ctx.store.statusRevision("bg")).toBe(busy)

    release()
    ctx.store.setStatuses("/repo", {}, ctx.store.beginStatusSnapshot())
    expect(ctx.store.data.session_status["bg"]).toBeUndefined()
    expect(ctx.store.statusRevision("bg")).toBeGreaterThan(busy)
  })

  test("reconciles a directory idle snapshot after the focused settlement hold releases", async () => {
    const ctx = setupBackground(() => ({}))
    ctx.store.remember(session("bg"))
    ctx.store.set("session_status", "bg", { type: "busy" })
    const release = ctx.store.holdStatusSettlement("bg")

    ctx.store.setStatuses("/repo", {}, ctx.store.beginStatusSnapshot())
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "busy" })

    release()
    await until(() => ctx.store.data.session_status["bg"]?.type === "idle")
    expect(ctx.store.data.session_status["bg"]).toEqual({ type: "idle" })
  })

  test("does not let an older inactive snapshot settle a newer busy event", async () => {
    let resolveActive = (_value: { data: { data: Record<string, unknown> } }) => {}
    const client = {
      session: {
        get: async () => ({ data: session("bg") }),
        diff: async () => ({ data: [] }),
        todo: async () => ({ data: [] }),
      },
      v2: {
        session: {
          active: () =>
            new Promise<{ data: { data: Record<string, unknown> } }>((resolve) => {
              resolveActive = resolve
            }),
        },
      },
    } as unknown as ForgeClient
    const store = createServerSession(client)

    store.apply({ type: "session.next.step.started", properties: { sessionID: "bg", timestamp: 1 } })
    store.apply({ type: "session.next.step.ended", properties: { sessionID: "bg", timestamp: 2 } })
    await new Promise((resolve) => setTimeout(resolve, 350))
    store.apply({ type: "session.next.step.started", properties: { sessionID: "bg", timestamp: 3 } })
    resolveActive({ data: { data: {} } })
    await Promise.resolve()

    expect(store.data.session_status["bg"]).toEqual({ type: "busy" })
  })
})
