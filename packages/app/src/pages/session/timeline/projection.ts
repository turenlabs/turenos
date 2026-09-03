import { Binary } from "@turenlabs/core/util/binary"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@turenlabs/sdk/v2"
import { createMemo, createSelector, mapArray, type Accessor } from "solid-js"
import { same } from "@/utils/same"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

const emptyAssistantMessages: AssistantMessage[] = []

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  starting: (messageID: string) => boolean
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
  /**
   * Compaction state for the session, applied to the newest turn.
   *
   * Compaction owns no turn of its own -- manual compaction runs with nothing in flight at all --
   * so the newest turn is the only place in the transcript where it can be seen.
   */
  compaction?: Accessor<{ readonly active: boolean; readonly failure?: string } | undefined>
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo((previous: Map<string, AssistantMessage[]> | undefined) => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    // Appending an optimistic user message must not invalidate every historical turn.
    result.forEach((messages, parentID) => {
      const current = previous?.get(parentID)
      if (current && same(current, messages)) result.set(parentID, current)
    })
    return result
  })
  const activeMessageID = createMemo(() => {
    const parentID = input
      .messages()
      .findLast(
        (message): message is AssistantMessage =>
          message.role === "assistant" && typeof message.time.completed !== "number",
      )?.parentID
    if (parentID) {
      const messages = input.messages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message?.role === "user") return message.id
    }

    if (input.status().type === "idle")
      return input.messages().findLast((message) => message.role === "user" && input.starting(message.id))?.id
    return input.messages().findLast((message) => message.role === "user")?.id
  })
  // Status and compaction can only change the active turn and the row that displays compaction.
  const isActiveMessage = createSelector(activeMessageID)
  const isCompactionMessage = createSelector(() => (input.compaction?.() ? input.userMessages().at(-1)?.id : undefined))
  const messageRowMemos = createMemo(
    mapArray(input.userMessages, (userMessage, indexAccessor) => {
      const assistantMessages = createMemo(
        () => assistantMessagesByParent().get(userMessage.id) ?? emptyAssistantMessages,
      )
      return createMemo((previous: TimelineRow.TimelineRow[] | undefined) => {
        const active = isActiveMessage(userMessage.id)
        return reuseTimelineRows(
          previous,
          Timeline.constructMessageRows(
            userMessage,
            input.parts,
            assistantMessages(),
            indexAccessor(),
            input.showReasoningSummaries(),
            active && input.status().type === "idle" && input.starting(userMessage.id)
              ? "busy"
              : active
                ? input.status().type
                : "idle",
            active,
            input.inlineComments(),
            isCompactionMessage(userMessage.id) ? input.compaction?.() : undefined,
          ),
        )
      })
    }),
  )
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(
      previous,
      messageRowMemos().flatMap((memo) => memo()),
    ),
  )
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}
