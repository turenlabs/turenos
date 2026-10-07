import { expect, test } from "bun:test"
import type { MessagesListOutput } from "@turenlabs/client"
import { transcript } from "../src/messages"

type Message = MessagesListOutput["data"][number]

const step = (id: string, content: unknown[], fields: Record<string, unknown> = {}) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "sandbox", id: "scripted" },
    time: { created: 1000, completed: 3000 },
    content,
    ...fields,
  }) as Message

const user = (id: string, text: string) => ({ id, type: "user", text, time: { created: 1 } }) as Message

const tool = (name: string, input: unknown, text: string, structured?: unknown) => ({
  type: "tool",
  id: `call_${name}`,
  name,
  state: { status: "completed", input, structured, content: [{ type: "text", text }] },
})

const lines = (count: number) => Array.from({ length: count }, (_, index) => `row ${index + 1}`).join("\n")
const count = (text: string, part: string) => text.split(part).length - 1

test("a turn that runs a tool shows one header, and its duration covers every step", () => {
  const messages = [
    user("u", "go"),
    step("a1", [tool("read", { path: "a" }, "x")], { time: { created: 1000, completed: 3000 } }),
    step("a2", [{ type: "text", text: "Done." }], { time: { created: 3000, completed: 13000 } }),
  ]
  for (const rich of [false, true]) {
    const text = transcript(messages, false, rich)
    expect(count(text, "sandbox/scripted")).toBe(1)
    expect(text).toContain("· 12s")
    expect(text).toContain("Done.")
  }
  expect(count(transcript(messages, true), "sandbox/scripted")).toBe(1)
})

test("no duration shows while a later step of the turn is still running", () => {
  const messages = [
    step("a1", [tool("read", { path: "a" }, "x")]),
    step("a2", [{ type: "text", text: "Working" }], { time: { created: 3000 } }),
  ]
  const text = transcript(messages)
  expect(count(text, "sandbox/scripted")).toBe(1)
  expect(text).not.toMatch(/\d+s\b/)
})

test("a change of agent or model within a turn gets its own header", () => {
  const text = transcript([
    step("a1", [{ type: "text", text: "first" }]),
    step("a2", [{ type: "text", text: "second" }], { agent: "plan" }),
    step("a3", [{ type: "text", text: "third" }], { agent: "plan", model: { providerID: "sandbox", id: "other" } }),
  ])
  expect(text).toContain("build · sandbox/scripted")
  expect(text).toContain("plan · sandbox/scripted")
  expect(text).toContain("plan · sandbox/other")
})

test("a message from the reader starts a new turn in the dashboard view only", () => {
  const messages = [user("u1", "one"), step("a1", [{ type: "text", text: "reply" }]), user("u2", "two")]
  expect(transcript(messages, false, true)).toMatch(/reply\n\n---\n\n`?USER/)
  expect(transcript(messages)).not.toContain("---")
  expect(transcript(messages, true, true)).not.toContain("---")
  // Machine-delivered updates are not new turns.
  const update = { id: "n", type: "user", source: "shell_job", text: "done", time: { created: 1 } } as Message
  expect(transcript([messages[1]!, update], false, true)).not.toContain("---")
})

test("a tool body over six lines shows four and counts the rest; Ctrl+O shows all", () => {
  const messages = [step("a1", [tool("read", { path: "big.txt" }, lines(30))])]
  const folded = transcript(messages, false, true)
  expect(folded).toContain("row 4")
  expect(folded).not.toContain("row 5\n")
  expect(folded).toContain("+26 lines")
  expect(folded).toContain("Ctrl+O expands")
  const whole = transcript(messages, false, true, { expanded: true })
  expect(whole).toContain("row 30")
  expect(whole).not.toContain("+26 lines")
  // Raw mode and the plain transcript keep the bounded text.
  expect(transcript(messages, true, true)).toContain("row 30")
  expect(transcript(messages)).toContain("row 30")
  expect(transcript([step("a2", [tool("read", { path: "s" }, lines(6))])], false, true)).not.toContain("expands")
})

test("a collapsed body cannot leave a code fence open over the note", () => {
  const body = ["```ts", ...Array.from({ length: 12 }, (_, index) => `const a${index} = 1`), "```"].join("\n")
  const text = transcript([step("a1", [tool("read", { path: "a.ts" }, body)])], false, true)
  expect(count(text, "```") % 2).toBe(0)
  expect(text.indexOf("Ctrl+O expands")).toBeGreaterThan(text.lastIndexOf("```"))
})

test("the to-do checklist is never collapsed", () => {
  const todos = Array.from({ length: 12 }, (_, index) => ({ content: `task ${index + 1}`, status: "pending" }))
  const text = transcript([step("a1", [tool("todowrite", { todos }, "[]")])], false, true)
  expect(text).toContain("task 12")
  expect(text).not.toContain("expands")
})

const patch = (rows: string[]) =>
  `Index: a.ts\n===================================================================\n--- a.ts\n+++ a.ts\n@@ -1,${rows.length} +1,${rows.length} @@\n${rows.join("\n")}\n`
const edit = (rows: string[]) =>
  tool("edit", { path: "a.ts" }, "Edited file successfully: a.ts\nReplacements: 1", {
    files: [{ file: "a.ts", patch: patch(rows), additions: 1, deletions: 1, status: "modified" }],
    replacements: 1,
  })

test("an edit reads as a compact unified diff with its +/- prefixes and no file header block", () => {
  const text = transcript([step("a1", [edit(["-const a = 1", "+const a = 2"])])], false, true)
  expect(text).toContain("```diff")
  expect(text).toContain("a.ts (+1 -1)")
  expect(text).toContain("-const a = 1\n+const a = 2")
  expect(text).not.toMatch(/^(Index:|---|\+\+\+|====)/m)
  expect(text).not.toContain("Edited file successfully")
  // Raw mode keeps what the server sent.
  expect(transcript([step("a1", [edit(["-x", "+y"])])], true)).toContain("Edited file successfully")
})

test("a long diff collapses beyond twenty lines", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `+added ${index + 1}`)
  const text = transcript([step("a1", [edit(rows)])], false, true)
  expect(text).toContain("added 14")
  expect(text).not.toContain("added 15")
  expect(text).toContain("+26 lines · Ctrl+O expands")
  expect(transcript([step("a1", [edit(rows)])], false, true, { expanded: true })).toContain("added 40")
})

test("apply_patch and a created file render as diffs, and a diff that quotes a fence stays closed", () => {
  const applied = tool("apply_patch", {}, "Applied patch", {
    files: [{ file: "b.md", patch: patch(["+```", "+text", "+```"]), additions: 3, deletions: 0, status: "added" }],
  })
  const patched = transcript([step("a1", [applied])], false, true)
  expect(patched).toContain("b.md (new file, +3)")
  expect(patched).toContain("~~~diff")
  const created = tool("write", { path: "n.md", content: "# Notes\n\nBody\n" }, "Created file successfully: n.md", {
    operation: "write",
    resource: "n.md",
    existed: false,
  })
  expect(transcript([step("a2", [created])], false, true)).toContain("n.md (new file, +3)\n+# Notes\n+\n+Body")
  const overwritten = tool("write", { path: "n.md", content: "x" }, "Wrote file successfully: n.md", { existed: true })
  expect(transcript([step("a3", [overwritten])], false, true)).toContain("Wrote file successfully")
})

test("a tool result without structured output keeps its text", () => {
  expect(transcript([step("a1", [tool("edit", { path: "a" }, "Edited file successfully: a")])], false, true)).toContain(
    "Edited file successfully: a",
  )
})

test("answered questions read as question and answer lines", () => {
  const questions = [{ question: "Which colour?" }, { question: "Which toppings?" }, { question: "Unused?" }]
  const answered = tool(
    "question",
    { questions },
    `User has answered your questions: "Which colour?"="Red". You can now continue with the user's answers in mind.`,
    { answers: [["Red"], ["Cheese", "Olives"], []] },
  )
  const text = transcript([step("a1", [answered])])
  expect(text).toContain("Which colour? → Red\nWhich toppings? → Cheese, Olives\nUnused? → Unanswered")
  expect(text).not.toContain("User has answered")
  const bare = tool("question", { questions }, "User has answered your questions: x")
  expect(transcript([step("a2", [bare])])).toContain("User has answered your questions: x")
})

test("errors are bold in the dashboard and keep their words everywhere", () => {
  const failed = step("a1", [], { error: { message: "HTTP 401: key refused" } })
  expect(transcript([failed], false, true)).toContain("**ERROR: HTTP 401: key refused**")
  expect(transcript([failed])).toContain("ERROR: HTTP 401: key refused")
  expect(transcript([failed])).not.toContain("**")
  expect(transcript([failed], true, true)).not.toContain("**")
  const stopped = step("a2", [], { error: { message: "Provider turn interrupted" } })
  expect(transcript([stopped], false, true)).toContain("**INTERRUPTED:")
  // Text that would end the emphasis keeps only the label bold.
  const starred = step("a3", [], { error: { message: "bad *glob*" } })
  expect(transcript([starred], false, true)).toContain("**ERROR:** bad *glob*")
})

test("a subagent tool line names the delegated task", () => {
  const spawn = tool("spawn_agent", { agent: "general", description: "Summarise the readme", prompt: "p" }, "{}")
  expect(transcript([step("a1", [spawn])])).toContain("[completed] spawn_agent · Summarise the readme")
  const bash = tool("bash", { command: "ls", description: "List files" }, "x")
  expect(transcript([step("a2", [bash])])).toContain("bash · ls\n")
})
