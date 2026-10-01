import { expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@turenlabs/sdk/v2"
import { Timeline, TimelineRow } from "./rows"

const text = (id: string, messageID: string, value: string) =>
  ({ id, messageID, type: "text", text: value }) as Part

const tool = (id: string, messageID: string, name: string, status: "completed" | "error" = "completed") =>
  ({
    id,
    messageID,
    type: "tool",
    tool: name,
    state:
      status === "error"
        ? { status, input: {}, error: "denied", time: { start: 1, end: 2 } }
        : { status, input: {}, output: "ok", metadata: {}, title: name, time: { start: 1, end: 2 } },
  }) as Part

test("associates part kinds across grouped references and interruption boundaries", () => {
  const parts = new Map([
    ["user-1", []],
    [
      "assistant-1",
      [
        tool("context-1", "assistant-1", "read"),
        tool("context-2", "assistant-1", "grep"),
        tool("failure-1", "assistant-1", "write", "error"),
        tool("failure-2", "assistant-1", "write", "error"),
        text("text-before", "assistant-1", "before interruption"),
      ],
    ],
    [
      "assistant-3",
      [tool("question", "assistant-3", "question"), text("text-after", "assistant-3", "after interruption")],
    ],
  ])
  const rows = Timeline.constructMessageRows(
    { id: "user-1" } as UserMessage,
    (messageID) => parts.get(messageID) ?? [],
    [
      { id: "assistant-1" } as AssistantMessage,
      { id: "assistant-2", error: { name: "MessageAbortedError" } } as AssistantMessage,
      { id: "assistant-3" } as AssistantMessage,
    ],
    0,
    true,
    "idle",
    false,
    true,
  )

  expect(rows.map((row) => row._tag)).toEqual([
    "UserMessage",
    "AssistantPart",
    "AssistantPart",
    "AssistantPart",
    "TurnDivider",
    "AssistantPart",
    "AssistantPart",
  ])
  expect(
    rows
      .filter((row): row is TimelineRow.AssistantPart => row._tag === "AssistantPart")
      .map((row) => ({ key: row.group.key, separate: row.separate })),
  ).toEqual([
    { key: "context:context-1", separate: true },
    { key: "failure:failure-1", separate: false },
    { key: "part:assistant-1:text-before", separate: true },
    { key: "part:assistant-3:question", separate: true },
    { key: "part:assistant-3:text-after", separate: true },
  ])
})
