import { expect, test } from "bun:test"
import type { MessagesListOutput } from "@turenlabs/client"
import { transcript } from "../src/messages"

type Message = MessagesListOutput["data"][number]

const user = (text: string) => ({ id: "u", type: "user", text, time: { created: 1 } }) as Message

const step = (content: unknown[], error?: string) =>
  ({
    id: "a",
    type: "assistant",
    agent: "build",
    model: { providerID: "sandbox", id: "scripted" },
    time: { created: 1000, completed: 3000 },
    content,
    ...(error ? { error: { type: "unknown", message: error } } : {}),
  }) as Message

const spawn = (structured: unknown) =>
  step([
    {
      type: "tool",
      id: "call_spawn",
      name: "spawn_agent",
      state: { status: "completed", input: { agent: "general", description: "Summarise" }, structured, content: [] },
    },
  ])

const tools = Array.from({ length: 23 }, (_, index) => ({ name: `tool_${index}`, description: "Use it" }))
const childPrompt = (json: string) =>
  `Your task: summarise.\n\nReference data from the parent session follows.\n\n<forge-parent-session-context>\n\n${json}\n\n</forge-parent-session-context>`

test("a child's parent-session reference data folds to one line, and Ctrl+O shows it literally", () => {
  const text = childPrompt(JSON.stringify({ tools, harness: null }))
  const folded = transcript([user(text)], false, true)
  expect(folded).toContain("Your task: summarise.")
  expect(folded).toContain("Parent session context: 23 tools (hidden; Ctrl+O shows it)")
  expect(folded).not.toContain("tool_0")
  expect(folded).not.toContain("forge-parent-session-context")
  const expanded = transcript([user(text)], false, true, { expanded: true })
  expect(expanded).toContain('```text\n{"tools":[{"name":"tool_0"')
  expect(expanded).not.toContain("hidden; Ctrl+O")
})

test("reference data that does not parse still folds, without a count", () => {
  const text = childPrompt('{"tools": [oops')
  expect(transcript([user(text)], false, true)).toContain("Parent session context (hidden; Ctrl+O shows it)")
  const fenced = childPrompt("```\n# injected heading\n```")
  expect(transcript([user(fenced)], false, true, { expanded: true })).toContain("````text\n")
})

test("the CLI transcript keeps the reference data as delivered", () => {
  const text = childPrompt(JSON.stringify({ tools }))
  expect(transcript([user(text)])).toContain('"name":"tool_0"')
})

test("spawn_agent shows what it started instead of nothing", () => {
  const task = { task_id: "tsk_1", session_id: "ses_2", agent: "general", description: "d", status: "running" }
  const text = transcript([spawn({ task })], false, true)
  expect(text).toContain("Started general subagent · task `tsk_1` · session `ses_2` · running")
  expect(transcript([spawn({ task })])).not.toContain("Started general")
})

test("an unrecognised spawn_agent result is shown literally", () => {
  const text = transcript([spawn({ queue: ["*bold*"], note: "x" })], false, true)
  expect(text).toContain("```text")
  expect(text).toContain("*bold*")
  expect(text).not.toContain("Started")
})

test("a refused key points at provider setup in the dashboard only", () => {
  for (const message of ["HTTP 401: sandbox provider refused the key", "HTTP 403: forbidden", "Your key was revoked"]) {
    const rich = transcript([step([], message)], false, true)
    expect(rich).toContain("Check the provider's key: Models (m), then F2 for provider setup, or Settings › Providers.")
    expect(transcript([step([], message)])).not.toContain("Check the provider's key")
    expect(transcript([step([], message)], true, true)).not.toContain("Check the provider's key")
  }
})

test("other provider errors and interruptions get no key guidance", () => {
  for (const message of ["HTTP 503: busy", "Provider turn interrupted"])
    expect(transcript([step([], message)], false, true)).not.toContain("Check the provider's key")
})
