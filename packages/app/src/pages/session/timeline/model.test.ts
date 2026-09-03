import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@turenlabs/sdk/v2"
import { isTimelineReady, selectUserMessages, selectVisibleUserMessages, shouldWidenForRevert } from "./model"

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_1"), assistant("msg_2"), user("msg_3"), user("msg_5")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_1", "msg_3", "msg_5"])
    expect(selectVisibleUserMessages(users, "msg_5").map((message) => message.id)).toEqual(["msg_1", "msg_3"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  describe("shouldWidenForRevert", () => {
    const base = { revertMessageID: "msg_9", visibleUserMessages: 0, more: true, loading: false }

    // Windowed hydration loads the newest messages; a revert to an older boundary hides all of
    // them. Without widening the transcript would be blank rather than merely truncated.
    test("widens when a revert has hidden the entire loaded window", () => {
      expect(shouldWidenForRevert(base)).toBe(true)
    })

    test("stops once something survives the revert boundary", () => {
      expect(shouldWidenForRevert({ ...base, visibleUserMessages: 1 })).toBe(false)
    })

    // Termination: when history runs out the answer must become false, or the effect that reads
    // it would ask for pages forever.
    test("stops when there is no older history left", () => {
      expect(shouldWidenForRevert({ ...base, more: false })).toBe(false)
    })

    test("does not stack requests while one is in flight", () => {
      expect(shouldWidenForRevert({ ...base, loading: true })).toBe(false)
    })

    test("never widens without a staged revert", () => {
      expect(shouldWidenForRevert({ ...base, revertMessageID: undefined })).toBe(false)
    })
  })
})
