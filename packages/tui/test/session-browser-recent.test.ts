import { expect, test } from "bun:test"
import { session, fixture } from "./session-browser-fixture"

test("Recent starts with mains, searches loaded children by metadata, and keeps selection and draft markers", async () => {
  const app = await fixture()
  const main = session("ses_main", "Main conversation")
  const child = {
    ...session("ses_child", "Investigate rendering"),
    parentID: main.id,
    agent: "auditor",
    location: { directory: "/srv/child-project" },
  }
  app.state.snapshot!.sessions = [main, child]
  app.state.snapshot!.active = { [child.id]: { type: "running" } }
  app.state.selected = child.id
  app.state.previousSession = child.id
  app.drafts.add(child.id)
  app.menus.switcher()
  const recent = await app.screen("Main conversation")
  expect(recent).not.toContain(child.title)
  expect(recent).toContain("Type to include subagents")
  expect(recent).toContain("1/1")
  for (const value of ["rendering", "/srv/child-project", "auditor", "ses_child"]) {
    app.query(value)
    const frame = await app.screen("▶ * Investigate rendering")
    expect(frame).toContain("[child] · current [draft]")
    expect(frame).not.toContain("[task]")
    expect(frame.split("\n").filter((line) => line.includes(child.title))).toHaveLength(1)
    expect(app.input().focused).toBe(true)
  }
  app.query(" ")
  expect(await app.screen("Main conversation")).not.toContain(child.title)
  app.query("ses_")
  // The session on screen leads the list, so the main session the earlier query left selected is the second row.
  await app.screen("▶ Main conversation")
  app.view.mockInput.pressArrow("up")
  await app.screen("▶ * Investigate rendering")
  app.query("ses_ ")
  await app.screen("▶ * Investigate rendering")
  expect(app.calls).toEqual([])
  app.view.mockInput.pressEnter()
  expect(app.opened).toEqual([{ id: child.id, inspect: false, session: child }])
  expect(app.drafts.has(child.id)).toBe(true)
})

test("Recent project headings reuse compact path and workspace disambiguation", async () => {
  const app = await fixture()
  app.state.snapshot!.sessions = [
    { ...session("ses_a", "Alpha main"), location: { directory: "/srv/alpha/project" } },
    { ...session("ses_b", "Beta main"), location: { directory: "/srv/beta/project" } },
    { ...session("ses_c", "Default main"), location: { directory: "/srv/unique" } },
    { ...session("ses_d", "Workspace main"), location: { directory: "/srv/unique", workspaceID: "ws_one" } },
  ]
  app.menus.switcher()
  const frame = await app.screen("Workspace main")
  for (const heading of ["alpha/project", "beta/project", "unique [default]", "unique [ws_one]"])
    expect(frame).toContain(heading)
  // The selected session's own path sits under the list; the headings carry only the compact form.
  expect(frame.split("\n").filter((line) => line.includes("/srv/"))).toEqual([
    expect.stringContaining("/srv/alpha/project"),
  ])
  expect(frame).toContain("1/4")
  expect(app.input().focused).toBe(true)
})

test("Recent with no loaded mains offers child discovery and preserves open by ID", async () => {
  const app = await fixture()
  const child = { ...session("ses_child", "Only loaded child"), parentID: "ses_missing" }
  app.state.snapshot!.sessions = [child]
  app.menus.switcher()
  const frame = await app.screen("No loaded main sessions")
  expect(frame).toContain("Type to include subagents")
  expect(frame).toContain("Tab All")
  expect(frame).toContain("Ctrl+O ID")
  app.view.mockInput.pressEnter()
  expect(app.opened).toEqual([])
  app.query("child")
  expect(await app.screen("Only loaded child")).toContain("[child]")
  expect(app.calls).toEqual([])
  app.query("ses_old")
  app.view.mockInput.pressKey("o", { ctrl: true })
  await app.screen("Open session by ID")
  expect(app.input().value).toBe("ses_old")
  app.view.mockInput.pressEnter()
  await app.wait(() => !app.state.modal)
  expect(app.opened).toEqual([{ id: "ses_old", inspect: false, session: app.old }])
})

test("desktop finder uses available space and exposes selected session details", async () => {
  const app = await fixture()
  app.view.resize(180, 50)
  app.menus.switcher()
  await app.screen("Recent record 0")
  expect(app.state.modal!.frame.width).toBeGreaterThan(96)
  expect(app.state.modal!.frame.height).toBeGreaterThan(32)
  expect(app.view.captureCharFrame()).toContain("/srv/browser project")
  app.view.mockInput.pressKey("END", { ctrl: true })
  await app.screen("ses_recent99")
  expect(app.input().focused).toBe(true)
  app.view.mockInput.pressKey("HOME", { ctrl: true })
  await app.screen("ses_recent0")
  expect(app.opened).toEqual([])
})

test("resized finder masks conversation text outside its frame", async () => {
  const app = await fixture()
  app.ui.renderContent(Array.from({ length: 80 }, () => "BACKGROUND CONVERSATION").join("\n"))
  app.menus.switcher()
  for (const [width, height] of [
    [60, 24],
    [120, 36],
    [60, 24],
  ]) {
    app.view.resize(width!, height!)
    await app.view.renderOnce()
    const frame = app.view.captureCharFrame()
    expect(frame).toContain("Switch session")
    expect(frame).not.toContain("BACKGROUND CONVERSATION")
    expect(app.input().focused).toBe(true)
  }
})

test("choosing an open row passes the captured session even if evicted from snapshot by polling", async () => {
  const app = await fixture()
  app.menus.switcher()
  await app.screen("Recent record 0")
  // Simulate polling eviction from snapshot while the switcher remains open
  app.state.snapshot!.sessions = app.state.snapshot!.sessions.filter((s) => s.id !== "ses_recent0")
  app.view.mockInput.pressEnter()
  expect(app.opened).toHaveLength(1)
  expect(app.opened[0]!.id).toBe("ses_recent0")
  expect(app.opened[0]!.session?.id).toBe("ses_recent0")
})
