import { expect, test } from "bun:test"
import type { MessagesListOutput } from "@turenlabs/client"
import { latestMessage, transcript } from "../src/messages"
import { toolText } from "../src/inspect/tool-text"
import { todoChecklist } from "../src/messages/todos"

type Message = MessagesListOutput["data"][number]

const shell = (fields: Record<string, unknown>) =>
  ({ id: "msg_shell", type: "shell", callID: "c", time: { created: 1 }, output: "", ...fields }) as Message

const turn = (fields: Record<string, unknown>, content: unknown[] = []) =>
  ({
    id: "msg_turn",
    type: "assistant",
    agent: "build",
    model: { providerID: "sandbox", id: "scripted" },
    time: { created: 1000 },
    content,
    ...fields,
  }) as Message

const notice = (source: string, text: string) =>
  ({ id: "msg_n", type: "user", source, text, time: { created: 1 } }) as Message

test("a shell command with a non-zero exit reads as failed with the code", () => {
  const failed = shell({ command: "cat nope", status: "completed", exitCode: 1, output: "cat: nope: No such file" })
  expect(transcript([failed])).toBe("[failed · exit 1] $ cat nope\ncat: nope: No such file")
  expect(latestMessage([failed])).toContain("failed (exit 1)")
  expect(transcript([shell({ command: "false", status: "failed", exitCode: 2 })])).toContain(
    "[failed · exit 2] $ false",
  )
  expect(transcript([shell({ command: "true", status: "completed", exitCode: 0 })])).toBe(
    "[completed] $ true\n(no output)",
  )
  expect(latestMessage([shell({ command: "true", status: "completed", exitCode: 0 })])).toContain("completed")
  expect(transcript([shell({ command: "sleep 9", status: "running" })])).toBe("[running] $ sleep 9")
})

test("todowrite renders as a checklist and raw mode keeps the result", () => {
  const todos = [
    { content: "write tests", status: "completed", priority: "high" },
    { content: "fix bug", status: "in_progress", priority: "high" },
    { content: "ship", status: "pending", priority: "low" },
  ]
  const part = {
    type: "tool",
    id: "p",
    name: "todowrite",
    state: { status: "completed", input: { todos }, content: [{ type: "text", text: '{"k":"v"}' }] },
  }
  const text = transcript([turn({}, [part])])
  expect(text).toContain("  [x] write tests\n  [>] fix bug\n  [ ] ship")
  expect(text).not.toContain("priority")
  expect(transcript([turn({}, [part])], true)).toContain('{"k":"v"}')
})

test("room posts and subagent results read as one line, raw keeps the full text", () => {
  const entry = { room_id: "r", seq: 1, kind: "message", actor: { type: "human", name: "x" }, text: "hello room" }
  const room = `A swarm room member posted an update.\n<forge-swarm-room-update>\n${JSON.stringify(entry)}\n</forge-swarm-room-update>\nmore`
  expect(transcript([notice("swarm_room", room)])).toBe("SWARM ROOM\nRoom: you posted #1 message: hello room")
  expect(transcript([notice("swarm_room", room)], true)).toContain("<forge-swarm-room-update>")
  expect(latestMessage([notice("swarm_room", room)])).toContain("Room: you posted #1 message: hello room")
  const settle = `A subagent task reached a terminal state.\ncompleted: Summarise the readme (task tsk_1, agent explore)\nResult: {"a":\n"b"}\nCollect the full durable report with wait_agents.`
  expect(transcript([notice("subagent_settle", settle)])).toBe(
    'SUBAGENT FINISHED\nSubagent completed: Summarise the readme (explore) - {"a": "b"}',
  )
  expect(transcript([notice("swarm_room", "plain text")])).toBe("SWARM ROOM\nplain text")
})

test("the assistant header drops an unknown model and appends the turn duration", () => {
  const unknown = { providerID: "unknown", id: "unknown" }
  expect(transcript([turn({ model: unknown })])).toBe("build")
  expect(transcript([turn({ time: { created: 1000, completed: 13000 } })])).toBe("build · sandbox/scripted · 12s")
  expect(transcript([turn({ time: { created: 1000, completed: 125000 } })])).toBe("build · sandbox/scripted · 2m 04s")
  expect(transcript([turn({ time: { created: 5000, completed: 1000 } })])).toBe("build · sandbox/scripted")
  expect(transcript([turn({ time: { created: 1000, completed: 1100 } })])).toBe("build · sandbox/scripted")
  expect(transcript([turn({ time: { created: 1 } })])).toBe("build · sandbox/scripted")
})

test("tool descriptions end at a word with an ellipsis", () => {
  const description =
    "Launch parallel subagents that coordinate their work across the repository and report back to the lead agent when every lane is done"
  const text = toolText({ visible: [{ id: "task", source: "builtin", description }], mcpServers: [], exclusions: [] })
  const line = text.split("\n").find((line) => line.includes("task · builtin"))!
  expect(line).toContain("…")
  expect(line).not.toContain("[display shortened]")
  expect(line.endsWith(" …")).toBe(false)
  expect(description).toContain(line.slice(line.indexOf("—") + 2, -1))
})

test("a user message with no text adds no bare label to the transcript", () => {
  const messages = [
    { id: "msg_1", type: "user", text: "hello", time: { created: 1 } },
    { id: "msg_2", type: "user", text: "  \n", time: { created: 2 } },
  ] as Message[]
  expect(transcript(messages)).toBe("USER\nhello")
})

test("a to-do status the checklist does not know, even an inherited name, shows as pending", () => {
  expect(todoChecklist({ todos: [{ content: "odd", status: "constructor" }] })).toBe("  [ ] odd")
})
