import { expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@turenlabs/sdk/v2"
import { batch, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createTimelineProjection } from "@/pages/session/timeline/projection"

test("only builds the optimistic row when a prompt starts without compaction", () => {
  const userMessage = (id: string) => ({ id, role: "user" }) as UserMessage
  const assistantMessage = (id: string, parentID: string) =>
    ({ id, parentID, role: "assistant", time: { created: 0, completed: 1 } }) as AssistantMessage
  const textPart = (id: string, messageID: string) =>
    ({ id, messageID, sessionID: "session", type: "text", text: id }) as Part
  const users = [userMessage("user-1"), userMessage("user-2"), userMessage("user-3")]
  const assistants = users.map((message, index) => assistantMessage(`assistant-${index + 1}`, message.id))
  const messages = users.flatMap((message, index) => [message, assistants[index]!])
  const parts = Object.fromEntries(
    messages.map((message) => [message.id, [textPart(`${message.id}-text`, message.id)]]),
  )

  createRoot((dispose) => {
    const [store, setStore] = createStore<{
      messages: Message[]
      users: UserMessage[]
      parts: Record<string, Part[]>
      status: SessionStatus
    }>({ messages, users, parts, status: { type: "idle" } })
    const reads: string[] = []
    const projection = createTimelineProjection({
      messages: () => store.messages,
      userMessages: () => store.users,
      parts: (messageID) => {
        reads.push(messageID)
        return store.parts[messageID] ?? []
      },
      status: () => store.status,
      starting: () => false,
      showReasoningSummaries: () => true,
      inlineComments: () => true,
    })
    projection.rows()
    reads.length = 0

    const next = userMessage("user-next")
    batch(() => {
      setStore("status", { type: "busy" })
      setStore("messages", (current) => [...current, next])
      setStore("users", (current) => [...current, next])
      setStore("parts", next.id, [textPart("user-next-text", next.id)])
    })

    const rows = projection.rows()
    expect(rows.some((row) => row._tag === "Thinking" && row.userMessageID === next.id)).toBe(true)
    expect(reads).toContain(next.id)
    expect(reads).not.toContain("user-1")
    expect(reads).not.toContain("assistant-1")
    expect(reads).not.toContain("user-2")
    expect(reads).not.toContain("assistant-2")
    expect(reads).not.toContain("user-3")
    expect(reads).not.toContain("assistant-3")
    dispose()
  })
})

test("shows startup feedback for a pending prompt before the server becomes active", () => {
  const message = { id: "user-pending", role: "user" } as UserMessage

  createRoot((dispose) => {
    const projection = createTimelineProjection({
      messages: () => [message],
      userMessages: () => [message],
      parts: () => [],
      status: () => ({ type: "idle" }),
      starting: (messageID) => messageID === message.id,
      showReasoningSummaries: () => true,
      inlineComments: () => true,
    })

    expect(projection.rows().some((row) => row._tag === "Thinking" && row.userMessageID === message.id)).toBe(true)
    dispose()
  })
})

test("preserves the latest starting user when a revert hides the visible suffix", () => {
  const user = (id: string) => ({ id, role: "user" }) as UserMessage
  const assistant = (id: string, parentID: string, created: number) =>
    ({ id, parentID, role: "assistant", time: { created, completed: created + 1 } }) as AssistantMessage
  const visible = user("user-visible")
  const hidden = user("user-hidden")
  const messages: Message[] = [
    visible,
    assistant("assistant-visible", visible.id, 1),
    hidden,
    assistant("assistant-hidden", hidden.id, 3),
  ]

  createRoot((dispose) => {
    const [store, setStore] = createStore({ users: [visible, hidden] })
    const projection = createTimelineProjection({
      messages: () => messages,
      userMessages: () => store.users,
      parts: () => [],
      status: () => ({ type: "idle" }),
      starting: (messageID) => messageID === visible.id || messageID === hidden.id,
      showReasoningSummaries: () => true,
      inlineComments: () => true,
    })

    expect(projection.activeMessageID()).toBe(hidden.id)
    setStore("users", [visible])
    expect(projection.activeMessageID()).toBe(hidden.id)
    dispose()
  })
})
