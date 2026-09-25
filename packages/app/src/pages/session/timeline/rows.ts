import { AssistantMessage, Part, SessionStatus, UserMessage } from "@turenlabs/sdk/v2"
import { groupParts, renderable, type PartGroup } from "@turenlabs/session-ui/message-part"
import { TimelineRow, type SummaryDiff } from "./timeline-row"
import { assistantPartKind, separateFrom, type TimelineRowKind } from "./density"
import { uniqueSummaryDiffs } from "./summary-diffs"
import { MessageComment } from "./message-comment"

export { TimelineRow, type SummaryDiff } from "./timeline-row"
export { MessageComment } from "./message-comment"
export { assistantPartKind, separateFrom, type TimelineRowKind } from "./density"

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
    separate: boolean
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
    separate: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
    separate: boolean
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    separate: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string; separate: boolean }
  Retry: { userMessageID: string; separate: boolean }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[]; separate: boolean }
  Error: { userMessageID: string; text: string; separate: boolean }
  CompactionFailure: { userMessageID: string; text: string; separate: boolean }
}

export namespace Timeline {
  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    // v2 renders comments inside the user message attachments row instead of a strip row
    inlineComments: boolean,
    /**
     * Compaction state, supplied for the newest turn only.
     *
     * Compaction is the one activity that does not belong to a turn: a manual `/compact` runs with
     * no assistant message in flight, and the automatic one runs when the turn it belongs to has
     * already failed. Both were invisible, because the status row is gated on a turn that is
     * active, un-errored, and has produced nothing yet -- three conditions a compaction routinely
     * violates. Passing it in for the newest turn gives it the one place in the transcript it can
     * legibly appear, without inventing a surface outside the message flow.
     */
    compactionState?: { readonly active: boolean; readonly failure?: string },
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const error = assistantMessages.find((m) => m.error && m.error.name !== "MessageAbortedError")?.error

    const assistantPartRefs: Array<{ messageID: string; messageIndex: number; part: Part }> = []
    assistantMessages.forEach((message, messageIndex) => {
      getMessageParts(message.id).forEach((part) => {
        if (renderable(part, showReasoning)) assistantPartRefs.push({ messageID: message.id, messageIndex, part })
      })
    })
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))

    // Density (see density.ts). A turn is spaced independently of its neighbours:
    // every turn after the first opens with a TurnGap, so the previous turn's tail
    // can never leak into this one's rhythm and each turn's decisions stay local.
    const partByRef = new Map(assistantPartRefs.map((ref) => [`${ref.messageID}:${ref.part.id}`, ref.part] as const))
    const groupKind = (group: PartGroup) =>
      assistantPartKind(
        group,
        group.type === "part" ? partByRef.get(`${group.ref.messageID}:${group.ref.partID}`) : undefined,
      )
    let previousKind: TimelineRowKind | undefined
    const separate = (kind: TimelineRowKind) => {
      const value = separateFrom(previousKind, kind)
      previousKind = kind
      return value
    }

    if (previousUserMessage) {
      rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))
      previousKind = "boundary"
    }

    if (comments.length > 0 && !inlineComments)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
          separate: separate("block"),
        }),
      )

    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: inlineComments || comments.length === 0,
        separate: separate("block"),
      }),
    )

    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
          separate: separate("block"),
        }),
      )
    }

    assistantItems.forEach((item) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
            separate: separate("block"),
          }),
        )
        return
      }

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          separate: separate(groupKind(item.group)),
        }),
      )
    })

    if (
      compactionState?.active === true ||
      (isActive && status === "busy" && !error && (showReasoning ? assistantPartRefs.length === 0 : true))
    ) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
          separate: separate("inline"),
        }),
      )
    }

    if (isActive && status === "retry")
      rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id, separate: separate("inline") }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        new TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
          separate: separate("block"),
        }),
      )
    }

    if (error) {
      const data = error.data?.message
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
          separate: separate("block"),
        }),
      )
    }

    // A compaction that produced no checkpoint is reported where the user is looking. It used to
    // exist only as a toast and a log line, so a session that could not compact looked like a
    // session that had not been asked to.
    if (compactionState?.failure)
      rows.push(
        new TimelineRow.CompactionFailure({
          userMessageID: userMessage.id,
          text: compactionState.failure,
          separate: separate("block"),
        }),
      )

    return rows
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}
