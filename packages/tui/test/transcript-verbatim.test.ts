import { afterEach, expect, test } from "bun:test"
import { CodeRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { MessagesListOutput } from "@turenlabs/client"
import { createMarkdown } from "../src/markdown"
import { transcript } from "../src/messages"

type Message = MessagesListOutput["data"][number]

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}

/** The frame the dashboard draws for text, once highlighting has settled. */
async function frame(text: string, width = 100) {
  const view = await createTestRenderer({ width, height: 60 })
  const markdown = createMarkdown(view.renderer)
  view.renderer.root.add(markdown)
  cleanup.push(() => view.renderer.destroy())
  markdown.content = text
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await view.renderOnce()
    if (descendants(markdown).every((node) => !(node instanceof CodeRenderable) || !node.isHighlighting)) break
    await Bun.sleep(10)
  }
  await view.renderOnce()
  return view.captureCharFrame()
}

const shell = (fields: Record<string, unknown>) =>
  ({ id: "msg_shell", type: "shell", callID: "c", time: { created: 1 }, output: "", ...fields }) as Message

const step = (content: unknown[]) =>
  ({
    id: "a1",
    type: "assistant",
    agent: "build",
    model: { providerID: "sandbox", id: "scripted" },
    time: { created: 1000, completed: 3000 },
    content,
  }) as Message

const tool = (name: string, input: unknown, text: string, status = "completed") => ({
  type: "tool",
  id: `call_${name}`,
  name,
  state: { status, input, content: [{ type: "text", text }] },
})

const hostile = [
  "const base = process.env.XDG || (process.env.HOME ? `${process.env.HOME}/.local/state` : undefined)",
  "*a* and _b_ and **c**",
  "# not a heading",
  "> not a quote",
  "- item",
  "[x](y)",
  "| a | b |",
  "| - | - |",
  "```",
  "after the fence run",
]

test("a shell command and its output show every character in the dashboard", async () => {
  const command = "echo `whoami` *bold* && pwd"
  const text = transcript(
    [shell({ command, status: "completed", exitCode: 0, output: hostile.join("\n") })],
    false,
    true,
  )
  const shown = await frame(text)
  expect(shown).toContain(`$ ${command}`)
  for (const line of hostile) expect(shown).toContain(line)
})

test("a tool's title and output show every character in the dashboard", async () => {
  const pattern = "foo `bar` *baz* _q_"
  const text = transcript([step([tool("grep", { pattern }, hostile.join("\n"))])], false, true, { expanded: true })
  const shown = await frame(text)
  expect(shown).toContain(`[completed] grep · ${pattern}`)
  for (const line of hostile) expect(shown).toContain(line)
})

test("a tool command that starts and ends with backticks stays on one literal line", async () => {
  const command = "`a_1` [x]`"
  const text = transcript([step([tool("bash", { command }, "ok")])], false, true)
  // The span's padding space is the one visible cost of a command that touches a backtick.
  expect(await frame(text)).toMatch(/\[completed\] bash · {1,2}`a_1` \[x\]`/)
})

test("a multi-line shell command and a failed tool's message are literal", async () => {
  const text = transcript(
    [
      shell({ command: "echo `a`\n*b*", status: "running" }),
      step([
        {
          ...tool("bash", { command: "x" }, "", "error"),
          state: { status: "error", input: {}, content: [], error: { message: "bad `tick` *star*" } },
        },
      ]),
    ],
    false,
    true,
  )
  const shown = await frame(text)
  expect(shown).toContain("echo `a`")
  expect(shown).toContain("*b*")
  expect(shown).toContain("bad `tick` *star*")
})

test("a folded output keeps its note outside the block and every kept line literal", async () => {
  const body = Array.from({ length: 12 }, (_, index) => `row \`${index + 1}\` *x*`).join("\n")
  const text = transcript([step([tool("read", { path: "a" }, body)])], false, true)
  expect(text.trimEnd().endsWith("… +8 lines · Ctrl+O expands")).toBe(true)
  expect(text.indexOf("Ctrl+O expands")).toBeGreaterThan(text.lastIndexOf("```"))
  const shown = await frame(text)
  expect(shown).toContain("row `4` *x*")
  expect(shown).not.toContain("row `5`")
  expect(shown).toContain("… +8 lines · Ctrl+O expands")
  expect(
    await frame(transcript([step([tool("read", { path: "a" }, body)])], false, true, { expanded: true })),
  ).toContain("row `12` *x*")
})

test("the shortening marker sits outside the block", () => {
  const text = transcript(
    [shell({ command: "x", status: "completed", output: "`".repeat(5) + "y".repeat(17000) })],
    false,
    true,
  )
  expect(text.endsWith("\n`````\n[display shortened]")).toBe(false)
  expect(text).toMatch(/\n`{6}\n\[display shortened\]$/)
})

test("the plain transcript and the raw view gain no fences or backticks", () => {
  const messages = [
    shell({ command: "echo `whoami` *bold*", status: "completed", exitCode: 0, output: "out `x`" }),
    step([tool("grep", { pattern: "a `b`" }, "hit `c`")]),
  ]
  const plain =
    "[completed] $ echo `whoami` *bold*\nout `x`\n\n" +
    "build · sandbox/scripted · 2s\n  [completed] grep · a `b`\nhit `c`"
  expect(transcript(messages)).toBe(plain)
  expect(transcript(messages, true)).toBe(plain)
  expect(transcript(messages, true, true)).toBe(plain)
})
