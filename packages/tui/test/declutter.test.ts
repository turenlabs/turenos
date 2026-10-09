import { afterEach, expect, test } from "bun:test"
import { replyHeading, replyHint, replyPlaceholder, type ReplyFacts } from "../src/requests/reply-hint"
import { fitContext } from "../src/layout/context-line"
import { cleanup, mount } from "./support"
import { open as openTeam, server as teamServer } from "./team-fixture"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const running = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }
const idle: ReplyFacts = {
  live: false,
  queue: false,
  waiting: undefined,
  review: false,
  revert: false,
  queued: 0,
  draft: false,
  listed: false,
}

/** How many rows of `frame` contain `text`: a hint said twice on one screen is clutter. */
const rows = (frame: string, text: string) => frame.split("\n").filter((line) => line.includes(text)).length

test.each([58, 80])("at %d columns an idle reply is one hint row, the footer says Typing, and nothing repeats", async (width) => {
  const { view, screen } = await mount(width, {}, 31)
  const frame = await screen("Typing")
  expect(rows(frame, "Enter send")).toBe(1)
  expect(rows(frame, "Esc shortcuts")).toBe(1)
  expect(frame).toContain("1/4 Sessions · Typing")
  expect(frame).toContain("Ctrl+P commands")
  for (const gone of ["Transcript", "Reply to", "Shift/Alt+Enter", "F4 discard", "f Reply", "View 1/4", "Type a message"])
    expect(frame).not.toContain(gone)
  if (width < 70) expect(frame.split("\n")[1]).not.toContain("Models")
  expect(view.captureCharFrame()).toContain("Message…")
})

test("shortcut mode names the key back to typing and help, and the editor hints are gone", async () => {
  const { view, screen } = await mount(58, {}, 31)
  await screen("Typing")
  view.mockInput.pressEscape()
  await Bun.sleep(150)
  const frame = await screen("Enter type")
  expect(frame).toContain("1/4 Sessions")
  expect(frame).toContain("Enter type · ? help")
  expect(frame).not.toContain("Typing")
  expect(frame).not.toContain("Esc shortcuts")
})

test("a running turn says so in the heading with the mode key, and Typing stays", async () => {
  const { screen } = await mount(58, running, 31)
  const frame = await screen("Steer · agent is working")
  expect(frame).toContain("Ctrl+T queue")
  expect(frame).toContain("Typing")
  expect(frame.split("\n")[1]).toContain("1 running")
})

test("the header keeps its buttons from 70 columns and drops them below", async () => {
  const wide = (await (await mount(70, {}, 24)).screen("Typing")).split("\n")[1]!
  expect(wide).toContain("Models")
  expect(wide).toContain("Sessions Ctrl+K")
  const narrow = (await (await mount(69, {}, 24)).screen("Typing")).split("\n")[1]!
  expect(narrow).not.toContain("Models")
  expect(narrow).not.toContain("Sessions Ctrl+K")
  expect(narrow).toMatch(/● \d+ · idle/)
})

test("the Team post editor has one hint row, Typing in the footer, and no heading", async () => {
  const w = teamServer()
  const { view, screen } = await openTeam(w.routes, 58, 31)
  await screen("f Post")
  view.mockInput.pressKey("f")
  const frame = await screen("Enter post · Esc shortcuts")
  expect(rows(frame, "Enter post")).toBe(1)
  expect(frame).toContain("4/4 Team · Typing")
  expect(frame).not.toContain("Shift+Enter")
  expect(frame).not.toContain("Post to #")
})

test("the reply heading carries only news", () => {
  expect(replyHeading(idle)).toBe("")
  expect(replyHeading({ ...idle, live: true })).toStartWith("Steer · agent is working")
  expect(replyHeading({ ...idle, live: true, queue: true })).toStartWith("Queue ·")
  expect(replyHeading({ ...idle, waiting: "permission", review: true })).toBe("Send · Permission waiting")
  expect(replyHeading({ ...idle, revert: true })).toBe("Send · undo staged")
  expect(replyHeading({ ...idle, elsewhere: "Other work" })).toBe("Send · Reply to Other work")
  expect(replyHeading({ ...idle, queued: 2 })).toBe("Send · 2 queued")
})

test("the reply hint is one row that drops whole entries from the end", () => {
  expect(replyHint(idle, 60)).toBe("Enter send · Esc shortcuts")
  expect(replyHint({ ...idle, draft: true }, 60)).toBe("Enter send · Esc shortcuts · F4 discard")
  expect(replyHint({ ...idle, draft: true }, 30)).toBe("Enter send · Esc shortcuts")
  expect(replyHint({ ...idle, draft: true }, 5)).toBe("Enter send")
  expect(replyHint({ ...idle, listed: true }, 60)).toContain("Tab complete")
  expect(replyPlaceholder(99)).toBe("Message…")
  expect(replyPlaceholder(100)).toContain("! shell")
})

test("the context line leaves out Transcript and keeps the last two folders", () => {
  expect(fitContext("/home/dad/turen/turenos/.worktrees/tui-audit", 58)).toBe("…/.worktrees/tui-audit")
  expect(fitContext("History · page 2 · /home/dad/project", 120)).toBe("History · page 2 · /home/dad/project")
})
