import { expect, test } from "bun:test"
import { sandbox } from "./support"

const tui = sandbox("conversation")

test("a new session streams the reply and is titled from its first message", async () => {
  await tui.launch("hello from the e2e suite")
  await tui.waitFor("Sandbox reply to: hello from the e2e suite")
  await tui.idle()
  const sessions = (await tui.api("GET", "/api/session")) as { data: { title: string }[] }
  expect(sessions.data.map((item) => item.title)).toContain("hello from the e2e suite")
  await tui.waitFor(/>\s+hello from the e2e suite/)
})

test("Markdown renders without raw markers", async () => {
  await tui.reply("show markdown")
  const screen = await tui.waitFor("A quoted line.")
  await tui.idle()
  expect(screen).toContain("Sandbox heading")
  expect(screen).toContain("export const answer = 42")
  expect(screen).not.toContain("**bold**")
  expect(screen).not.toContain("```")
})

test("reasoning is shown apart from the answer", async () => {
  await tui.reply("think about it")
  const screen = await tui.waitFor("Thought about it: the answer is 42.")
  expect(screen).toContain("Thinking")
  expect(screen).toContain("I will consider it briefly.")
  await tui.idle()
})

test("a long reply can be scrolled back while the tail stays reachable", async () => {
  await tui.reply("a long one please")
  await tui.waitFor("Paragraph 60.", 20_000)
  await tui.idle()
  await tui.keys("Escape", "PageUp", "PageUp")
  const scrolled = await tui.settle()
  expect(scrolled).not.toContain("Paragraph 60.")
  await tui.keys("End")
  await tui.waitFor("Paragraph 60.")
})

test("Up in an empty reply recalls the previous message", async () => {
  await tui.compose()
  await tui.keys("Up")
  await tui.waitFor("a long one please")
  await tui.keys("Escape")
})
