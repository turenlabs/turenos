import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@turenlabs/sdk/v2/client"
import { createStore } from "solid-js/store"
import { readPartText } from "@turenlabs/session-ui/message-part-text"
import type { State } from "./types"
import { applyDirectoryEvent } from "./event-reducer"

/**
 * Repro for an assistant response block that vanishes mid-turn and returns a few seconds later.
 *
 * Streams a text part by deltas, then delivers the `message.part.updated` snapshot the server
 * sends for a part that is still in flight. What the user sees is whatever `readPartText` returns
 * for a part that `renderable` admitted; both are asserted together, because the flicker is only
 * visible when those two disagree or when the snapshot walks the streamed text back.
 */

const session = (id: string) => ({ id, time: { created: 1, updated: 1 } }) as Session

const assistantMessage = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID: "user-message",
    time: { created: 1 },
    agent: "assistant",
    mode: "primary",
    modelID: "gpt",
    providerID: "openai",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as Message

const streamingTextPart = (input: { id: string; messageID: string; sessionID: string; text: string }) =>
  ({
    id: input.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "text",
    text: input.text,
  }) as Part

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

/**
 * What the transcript shows for a text part.
 *
 * `renderable` decides whether the row exists at all, but it lives in message-part.tsx, which
 * cannot be imported here -- the module pulls in Kobalte and throws on the server. Its text
 * branch is mirrored inline; keep in step with message-part.tsx:742.
 */
function visibleText(store: State, messageID: string, partID: string) {
  const part = store.part[messageID]?.find((item) => item.id === partID) as { id: string; text?: string } | undefined
  if (!part) return ""
  const admitted = !!part.text?.trim()
  if (!admitted) return ""
  return readPartText(store.part_text_accum_delta as Record<string, string>, part)
}

describe("streaming assistant text", () => {
  test("a mid-stream part.updated snapshot must not blank the response the user is reading", () => {
    const part = streamingTextPart({ id: "part", messageID: "message", sessionID: "session", text: "" })
    const [store, setStore] = createStore(
      baseState({
        session: [session("session")],
        message: { session: [assistantMessage("message", "session")] },
        part: { message: [part] },
      }),
    )

    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({ event, store, setStore, push() {}, directory: "/tmp", loadLsp() {} } as never)

    for (const delta of ["I'll replace only ", "/Applications/TurenOS Dev.app ", "with the dev build."])
      apply({
        type: "message.part.delta",
        properties: { messageID: "message", partID: "part", field: "text", delta },
      })

    const streamed = "I'll replace only /Applications/TurenOS Dev.app with the dev build."
    expect(visibleText(store, "message", "part")).toBe(streamed)

    // The server's snapshot for a part still in flight: same id, text not yet durable.
    apply({
      type: "message.part.updated",
      properties: {
        part: streamingTextPart({ id: "part", messageID: "message", sessionID: "session", text: "" }),
      },
    })

    // The block was on screen a moment ago. Nothing the user did removed it.
    expect(visibleText(store, "message", "part")).toBe(streamed)
  })

  test("the reducer never leaves the part and the accumulator disagreeing about having text", () => {
    const part = streamingTextPart({ id: "part", messageID: "message", sessionID: "session", text: "" })
    const [store, setStore] = createStore(
      baseState({
        session: [session("session")],
        message: { session: [assistantMessage("message", "session")] },
        part: { message: [part] },
      }),
    )

    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({ event, store, setStore, push() {}, directory: "/tmp", loadLsp() {} } as never)

    apply({
      type: "message.part.delta",
      properties: { messageID: "message", partID: "part", field: "text", delta: "streamed" },
    })
    apply({
      type: "message.part.updated",
      properties: {
        part: streamingTextPart({ id: "part", messageID: "message", sessionID: "session", text: "" }),
      },
    })

    const stored = store.part.message![0] as { id: string; text?: string }
    // `readPartText` prefers the accumulator; `renderable` reads `part.text` and never sees it
    // (message-part.tsx:742). They can only agree if the reducer keeps the streamed text on the
    // part, so assert the two answers rather than either one alone.
    const rendered = readPartText(store.part_text_accum_delta as Record<string, string>, stored)
    const admitted = !!stored.text?.trim()
    expect(rendered).toBe("streamed")
    expect(admitted).toBe(true)
  })

  test("a snapshot that carries text is authoritative, even when it is shorter", () => {
    const part = streamingTextPart({ id: "part", messageID: "message", sessionID: "session", text: "" })
    const [store, setStore] = createStore(
      baseState({
        session: [session("session")],
        message: { session: [assistantMessage("message", "session")] },
        part: { message: [part] },
      }),
    )

    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({ event, store, setStore, push() {}, directory: "/tmp", loadLsp() {} } as never)

    apply({
      type: "message.part.delta",
      properties: { messageID: "message", partID: "part", field: "text", delta: "a long streamed draft" },
    })
    apply({
      type: "message.part.updated",
      properties: {
        part: streamingTextPart({ id: "part", messageID: "message", sessionID: "session", text: "edited" }),
      },
    })

    // Retaining the longest value would strand an edited or replaced part on stale text.
    expect(visibleText(store, "message", "part")).toBe("edited")
  })
})
