import { expect, test } from "bun:test"
import { SelectRenderable } from "@opentui/core"
import { fileRevert, message, fixture } from "./rewind-fixture"

test("staged file changes are disclosed before confirming, and Ctrl+D toggles the patch read-only", async () => {
  const app = await fixture({
    messageID: "msg_a",
    snapshot: "tree_original",
    files: [
      { path: "src/auth.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-OLDLINE\n+NEWLINE" },
      { path: "src/gone.ts", status: "deleted", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@\n-DROPPED" },
    ],
  })
  app.controls.undo()

  // The count must be readable before the control is even finished loading,
  // because confirming can restore these files immediately.
  const initial = await app.waitFor((frame) => frame.includes("Staged file changes"))
  expect(initial).toContain("2 files · +1 -5")
  expect(initial).not.toContain("NEWLINE")

  app.view.mockInput.pressKey("d", { ctrl: true })
  const opened = await app.waitFor((frame) => frame.includes("NEWLINE"))
  expect(opened).toContain("M src/auth.ts  +1 -1")
  expect(opened).toContain("-OLDLINE")
  expect(opened).toContain("D src/gone.ts  +0 -4")

  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.waitFor((frame) => !frame.includes("NEWLINE"))
  expect(app.view.captureCharFrame()).toContain("Staged file changes")
  expect(app.posts()).toHaveLength(0)
})

test("a rewind with no staged files shows no diff affordance", async () => {
  const app = await fixture()
  await app.ready()
  expect(app.view.captureCharFrame()).not.toContain("Staged file changes")
  app.view.mockInput.pressKey("d", { ctrl: true })
  await app.view.renderOnce()
  expect(app.view.captureCharFrame()).not.toContain("Staged file changes")
  expect(app.posts()).toHaveLength(0)
})

test("confirmation does not truncate a longer word into an accepted action", async () => {
  const app = await fixture()
  await app.ready()
  await app.confirm("undone")
  await app.waitFor((frame) => frame.includes("Type undo to confirm"))
  expect(app.view.renderer.currentFocusedEditor?.plainText).toBe("undone")
  expect(app.posts()).toHaveLength(0)
})

test.each(["direct", "resize"])(
  "minimum-size confirmation keeps controls visible with long metadata (%s)",
  async (mode) => {
    const app = await fixture(undefined, mode === "direct" ? 60 : 100)
    const longSession = {
      ...app.remote.session,
      title: "Long session description requiring several wrapped lines ".repeat(4),
      location: {
        ...app.remote.session.location,
        directory: "/srv/projects/very-long-project-name/packages/deeply-nested-component",
      },
    }
    app.remote.session = longSession
    app.state.snapshot!.sessions = [longSession]
    await app.ready()
    if (mode === "resize") app.view.resize(60, 24)
    await app.waitFor(
      (frame) =>
        frame.includes("Conversation only") && frame.includes("Conversation + files") && frame.includes("type undo"),
    )
    const field = app.view.renderer.currentFocusedEditor!
    await app.view.mockInput.typeText("undo")
    await app.view.renderOnce()
    expect(field.plainText).toBe("undo")
    expect(field.y).toBeGreaterThan(app.state.modal!.form.viewport.y)
    expect(field.y).toBeLessThan(app.state.modal!.error.y)
    expect(app.view.captureCharFrame().split("\n")[field.y]).toContain("undo")
    expect(app.posts()).toHaveLength(0)
  },
)

test("retry cannot apply a hidden earlier file mode after a preflight failure", async () => {
  const app = await fixture()
  await app.ready()
  const files = app.state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  files.setSelectedIndex(1)
  app.remote.getFailure = true
  await app.confirm()
  await app.waitFor((frame) => frame.includes("HTTP 503"))
  app.remote.getFailure = false
  files.setSelectedIndex(0)
  app.submit()
  await app.waitFor((frame) => frame.includes("original file mode"))
  expect(app.posts()).toHaveLength(0)
})

test("lost file-stage response cannot be confirmed from matching message identity alone", async () => {
  const app = await fixture()
  await app.ready()
  const files = app.state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  files.setSelectedIndex(1)
  app.remote.ambiguous = true
  await app.confirm()
  await app.waitFor((frame) => frame.includes("Outcome unknown"))
  app.remote.session = {
    ...app.remote.session,
    revert: { messageID: "msg_a", files: [], diff: "", snapshot: "tree_original" },
  }
  app.submit()
  await app.waitFor((frame) => frame.includes("File restoration is unconfirmed"))
  expect(app.posts()).toHaveLength(2)
  expect(app.calls).toHaveLength(0)
  expect(app.notices.some((text) => text.includes("Undo confirmed"))).toBe(false)
})

test("undo inspection and Enter are read-only; captures target, defaults files false and restores draft after GET", async () => {
  const app = await fixture()
  await app.ready()
  const frame = await app.waitFor((frame) => frame.includes("Latest real prompt"))
  expect(frame).not.toContain("stops active work")
  expect(frame).toContain("next reply commits")
  expect(app.posts()).toEqual([])
  app.view.mockInput.pressEnter()
  app.submit()
  await app.waitFor((frame) => frame.includes("to confirm"))
  expect(app.posts()).toEqual([])
  app.state.selected = "ses_elsewhere"
  await app.confirm()
  await app.waitFor(() => !app.state.modal)
  expect(app.posts().map((request) => [request.path, request.body])).toEqual([
    ["/api/session/ses_rewind/interrupt", ""],
    ["/api/session/ses_rewind/revert/stage", '{"messageID":"msg_a","files":false}'],
  ])
  expect(app.calls[0]?.[0]).toBe("changed")
  expect(app.calls[1]).toEqual(["restore", "ses_rewind", "msg_a", "Latest real prompt"])
  expect(app.state.selected).toBe("ses_elsewhere")
})

test("undo uses descending cursor order across pages and deduplicates boundary and notifications", async () => {
  const app = await fixture({ messageID: "msg_a" })
  app.remote.pages = [
    [message("msg_a", "Latest real prompt", 3)],
    [
      message("msg_a", "Latest real prompt", 3),
      message("msg_b", "Board", 2, "subagent_board"),
      message("msg_z", "Earlier real prompt", 1),
    ],
  ]
  await app.ready()
  await app.confirm()
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.posts()[1]!.body)).toEqual({ messageID: "msg_z", files: false })
  const pages = app.requests.filter((request) => request.path.endsWith("/message"))
  expect(pages).toHaveLength(2)
  expect(new URLSearchParams(pages[0]!.query).get("order")).toBe("desc")
  expect(new URLSearchParams(pages[1]!.query).get("cursor")).toBe("1")
})

test("existing file undo rejects conversation-only before interrupt; explicit file mode is honored", async () => {
  const app = await fixture(fileRevert)
  await app.ready()
  await app.confirm()
  await app.waitFor((frame) => frame.includes("Redo first"))
  expect(app.posts()).toEqual([])
  const select = app.state.modal!.fields.find((field) => field instanceof SelectRenderable) as SelectRenderable
  select.setSelectedIndex(1)
  app.submit()
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.posts()[1]!.body)).toEqual({ messageID: "msg_z", files: true })
})

test("redo advances to next real user by sequence and only clears the matching restored draft", async () => {
  const app = await fixture({ messageID: "msg_m" })
  await app.ready("redo")
  await app.confirm("redo")
  await app.waitFor(() => !app.state.modal)
  expect(JSON.parse(app.posts()[1]!.body)).toEqual({ messageID: "msg_z", files: false })
  expect(app.calls.map((call) => call[0])).toEqual(["changed", "clear"])
  expect(app.calls[1]).toEqual(["clear", "ses_rewind", "msg_m", "First prompt"])
})

test("redo clears final stage with disclosed immediate file effects and no prompt restoration", async () => {
  const app = await fixture(fileRevert)
  await app.ready("redo")
  await app.waitFor((frame) => frame.includes("Redo restores the staged files now."))
  await app.confirm("redo")
  await app.waitFor(() => !app.state.modal)
  expect(app.posts().map((request) => request.path)).toEqual([
    "/api/session/ses_rewind/interrupt",
    "/api/session/ses_rewind/revert/clear",
  ])
  expect(app.calls[1]).toEqual(["clear", "ses_rewind", "msg_a", "Latest real prompt"])
})

test("undo preserves an existing reply draft when restore callback refuses", async () => {
  const app = await fixture()
  app.draft.keep = true
  await app.ready()
  await app.confirm()
  await app.waitFor(() => !app.state.modal)
  expect(app.notices.at(-1)).toContain("Existing draft kept")
  expect(app.calls).toHaveLength(2)
})
