import { mock } from "bun:test"
import { strict as assert } from "node:assert"
import { createRoot } from "solid-js"
import type { ForgeClient, SessionMessage } from "@turenlabs/sdk/v2/client"
import { createServerSession } from "../../src/context/server-session"

const listeners = new Map<string, Set<(event: { properties: Record<string, string> }) => void>>()
const event = {
  on(type: string, listener: (event: { properties: Record<string, string> }) => void) {
    const bucket = listeners.get(type) ?? new Set()
    bucket.add(listener)
    listeners.set(type, bucket)
    return () => bucket.delete(listener)
  },
  emit(type: string, properties: Record<string, string>) {
    listeners.get(type)?.forEach((listener) => listener({ properties }))
  },
}
const sessionID = "ses_replay"
const answer = "The answer repeats. The answer repeats."
const thought = "Consider carefully."
const transcript: SessionMessage[] = [
  { id: "user", type: "user", text: "question", time: { created: 1 } },
  {
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "p", id: "m" },
    time: { created: 2, completed: 3 },
    content: [
      { type: "text", id: "text", text: answer },
      { type: "reasoning", id: "reasoning", text: thought },
    ],
  },
]
let fail = false
const session = {
  pendingInputs: async () => ({ data: { data: [] } }),
  messages: async () => {
    if (fail) throw new Error("temporary snapshot failure")
    return { data: { data: [...transcript].reverse(), cursor: {} } }
  },
  history: async () => ({ data: { latest: 1 } }),
  active: async () => ({ data: { data: {} } }),
  events: () => new Promise(() => {}),
}
const client = {
  v2: { session },
  session: { get: async () => ({ data: undefined }) },
} as unknown as ForgeClient
const store = createServerSession(client)
store.remember({
  id: sessionID,
  slug: sessionID,
  projectID: "project",
  directory: "/repo",
  title: "test",
  version: "1",
  time: { created: 1, updated: 1 },
})
const sdk = { directory: "/repo", scope: "local", client, event }
const sync = { data: store.data, set: store.set, session: store }
mock.module("@/context/sdk", () => ({ useSDK: () => () => sdk }))
mock.module("@/context/sync", () => ({ useSync: () => () => sync }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({}) }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/components/prompt-input/prompt-admission", () => ({
  promptAdmissionFor: () => ({
    watch: () => ({ dispose() {}, refresh() {}, pause() {} }),
    settle() {},
    error: () => undefined,
  }),
}))
const { createSessionV2TimelineController } = await import(
  "../../src/pages/session/goal/session-v2-timeline-controller"
)
const mounted = createRoot((dispose) => ({
  dispose,
  controller: createSessionV2TimelineController({
    sessionID: () => sessionID,
    sessionKey: () => sessionID,
    agent: () => "build",
    model: () => ({ providerID: "p", modelID: "m" }),
  }),
}))
const partText = (messageID: string, id: string) => {
  const part = store.data.part[messageID]?.find((item) => item.id === id)
  return part?.type === "text" || part?.type === "reasoning" ? part.text : undefined
}
const delta = (messageID: string, id: string, value: string, type: "text" | "reasoning" = "text") =>
  event.emit(`session.next.${type}.delta`, {
    sessionID,
    assistantMessageID: messageID,
    [type === "text" ? "textID" : "reasoningID"]: id,
    delta: value,
  })

try {
  await mounted.controller.hydrate(sessionID)
  store.set("session_status", sessionID, { type: "idle" })
  if (process.argv[2] === "status") {
    store.apply({ type: "session.next.step.started", properties: { sessionID, assistantMessageID: "assistant" } })
    store.apply({ type: "session.next.step.ended", properties: { sessionID, assistantMessageID: "assistant" } })
    assert.equal(store.data.session_status[sessionID]?.type, "idle")
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(store.data.session_status[sessionID]?.type, "idle")
  }
  if (process.argv[2] === "replay") {
    for (const chunk of ["The answer ", "repeats. ", "The answer ", "repeats."]) delta("assistant", "text", chunk)
    for (const chunk of ["Consider ", "carefully."]) delta("assistant", "reasoning", chunk, "reasoning")
    assert.equal(partText("assistant", "text"), answer)
    assert.equal(partText("assistant", "reasoning"), thought)
    await mounted.controller.hydrate(sessionID)
    assert.equal(partText("assistant", "text"), answer)
    assert.equal(partText("assistant", "reasoning"), thought)
  }
  if (process.argv[2] === "live") {
    transcript.push(
      { id: "user2", type: "user", text: "another", time: { created: 4 } },
      {
        id: "assistant2",
        type: "assistant",
        agent: "build",
        model: { providerID: "p", id: "m" },
        time: { created: 5 },
        content: [
          { type: "text", id: "text2", text: "" },
          { type: "reasoning", id: "reasoning2", text: "" },
        ],
      },
    )
    await mounted.controller.hydrate(sessionID)
    store.apply({ type: "session.next.step.started", properties: { sessionID, assistantMessageID: "assistant2" } })

    assert.equal(store.data.session_status[sessionID]?.type, "busy")
    delta("assistant2", "text2", "same")
    delta("assistant2", "text2", "same")
    delta("assistant2", "reasoning2", "think", "reasoning")
    delta("assistant2", "reasoning2", "think", "reasoning")
    assert.equal(partText("assistant2", "text2"), "samesame")
    assert.equal(partText("assistant2", "reasoning2"), "thinkthink")
    fail = true
    await assert.rejects(mounted.controller.hydrate(sessionID), /temporary snapshot failure/)

    assert.equal(partText("assistant2", "text2"), "samesame")
    fail = false
    await mounted.controller.hydrate(sessionID)

    assert.equal(partText("assistant2", "text2"), "samesame")
    assert.equal(partText("assistant2", "reasoning2"), "thinkthink")
    assert.equal(store.data.session_status[sessionID]?.type, "busy")
    delta("assistant2", "text2", "same")
    transcript[3] = {
      id: "assistant2",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "m" },
      time: { created: 5, completed: 6 },
      content: [
        { type: "text", id: "text2", text: "samesame" },
        { type: "reasoning", id: "reasoning2", text: "thinkthink" },
      ],
    }
    await mounted.controller.hydrate(sessionID)
    assert.equal(partText("assistant2", "text2"), "samesame")
  }
} finally {
  mounted.dispose()
}
// The real server-session store may retain background timers beyond controller disposal.
process.exit(0)
