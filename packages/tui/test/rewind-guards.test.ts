import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import type { MessagesListOutput } from "@turenlabs/client"
import { assistant } from "./support"
import { fileRevert, message, fixture } from "./rewind-fixture"

for (const action of ["undo", "redo"] as const) {
  for (const apply of [true, false]) {
    test(`${action} ambiguous response retry is GET-only (applied=${apply})`, async () => {
      const app = await fixture(action === "redo" ? fileRevert : undefined)
      app.remote.ambiguous = true
      app.remote.apply = apply
      await app.ready(action)
      await app.confirm(action)
      await app.waitFor((frame) => frame.includes("Outcome unknown"))
      expect(app.posts()).toHaveLength(2)
      app.submit()
      await app.waitFor((frame) => (apply ? !app.state.modal : frame.includes("Outcome is not confirmed")))
      expect(app.posts()).toHaveLength(2)
      expect(app.calls).toHaveLength(apply ? 2 : 0)
      if (!apply) {
        app.submit()
        await app.waitFor((frame) => frame.includes("Outcome is not confirmed"))
        expect(app.posts()).toHaveLength(2)
      }
    })
  }
  test(`${action} acknowledged mutation followed by GET failure retries only GET`, async () => {
    const app = await fixture(action === "redo" ? fileRevert : undefined)
    app.remote.failAfterWrite = true
    await app.ready(action)
    await app.confirm(action)
    await app.waitFor((frame) => frame.includes("HTTP 503"))
    expect(app.calls).toEqual([])
    app.remote.getFailure = false
    app.submit()
    await app.waitFor(() => !app.state.modal)
    expect(app.posts()).toHaveLength(2)
  })
}

for (const change of ["identity", "boundary", "ownership"] as const) {
  test(`confirmation rechecks ${change} before interruption`, async () => {
    const app = await fixture()
    await app.ready()
    if (change === "identity") app.remote.session = { ...app.remote.session, location: { directory: "/srv/other" } }
    if (change === "boundary") app.remote.session = { ...app.remote.session, revert: { messageID: "msg_m" } }
    if (change === "ownership") app.remote.blocked = true
    await app.confirm()
    await app.waitFor((frame) => frame.includes("Ctrl+S retry"))
    expect(app.posts()).toEqual([])
  })
}

test("cancelled late message fetch cannot populate or mutate a newer modal", async () => {
  const app = await fixture()
  const gate = Promise.withResolvers<void>()
  app.remote.gate = gate.promise
  app.controls.undo()
  await app.waitFor(() => app.requests.some((request) => request.path.endsWith("/message")))
  app.view.mockInput.pressEscape()
  const newer = app.dialogs.open("Other dialog")
  gate.resolve()
  await Bun.sleep(30)
  await app.view.renderOnce()
  expect(app.state.modal).toBe(newer)
  expect(newer!.fields).toEqual([])
  expect(app.posts()).toEqual([])
})

test("missing boundary stops after ten pages without any mutation", async () => {
  const app = await fixture({ messageID: "msg_missing" })
  app.remote.pages = Array.from({ length: 12 }, (_, page) =>
    Array.from({ length: 30 }, (_, i) => message(`msg_${page}_${i}`, "A prompt", page * 30 + i)),
  )
  app.controls.undo()
  await app.waitFor((frame) => frame.includes("outside the bounded"))
  expect(app.requests.filter((request) => request.path.endsWith("/message"))).toHaveLength(10)
  app.submit()
  await app.waitFor((frame) => frame.includes("inspection"))
  expect(app.posts()).toEqual([])
})

test("known owned tasks never open rewind or make requests", async () => {
  const app = await fixture()
  app.remote.blocked = true
  app.controls.undo()
  app.controls.redo()
  expect(app.state.modal).toBeUndefined()
  expect(app.requests).toEqual([])
  expect(app.notices.at(-1)).toContain("Task-owned")
})

test("no real prompt and unstaged redo remain read-only", async () => {
  const app = await fixture()
  app.remote.pages = [[message("msg_board", "Board", 1, "subagent_board")]]
  app.controls.undo()
  await app.waitFor((frame) => frame.includes("No earlier user prompt"))
  app.view.mockInput.pressEscape()
  app.controls.redo()
  await app.waitFor((frame) => frame.includes("Nothing staged to redo"))
  expect(app.posts()).toEqual([])
})

test("ownership discovered during loading prevents controls and writes", async () => {
  const app = await fixture()
  const gate = Promise.withResolvers<void>()
  app.remote.gate = gate.promise
  app.controls.undo()
  await app.waitFor(() => app.requests.some((request) => request.path.endsWith("/message")))
  app.remote.blocked = true
  gate.resolve()
  await app.waitFor((frame) => frame.includes("Task-owned"))
  expect(app.state.modal!.fields).toEqual([])
  expect(app.posts()).toEqual([])
})

async function picker(app: Awaited<ReturnType<typeof fixture>>) {
  app.remote.pages = [
    [assistant("reply", "Assistant reply") as unknown as MessagesListOutput["data"][number], ...app.remote.pages[0]!],
  ]
  app.controls.pick()
  return app.waitFor((frame) => frame.includes("Rewind to an earlier message") && frame.includes("First prompt"))
}

test("the rewind picker lists user prompts newest first and leaves out other messages", async () => {
  const app = await fixture()
  const frame = await picker(app)
  const at = (text: string) => frame.indexOf(text)
  expect(at("Latest real prompt")).toBeGreaterThan(-1)
  expect(at("Latest real prompt")).toBeLessThan(at("Earlier real prompt"))
  expect(at("Earlier real prompt")).toBeLessThan(at("First prompt"))
  expect(frame).not.toContain("Assistant reply")
  expect(frame).not.toContain("Job notification")
  expect(frame).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  expect(app.posts()).toEqual([])
})

test("choosing the second-newest prompt opens the undo confirmation and stages that message only after it", async () => {
  const app = await fixture()
  await picker(app)
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.waitFor(() => app.state.modal?.fields.some((field) => field instanceof InputRenderable) === true)
  const frame = await app.waitFor(
    (frame) => frame.includes("Earlier real prompt") && frame.includes("Confirmation (type rewind)"),
  )
  expect(frame).toContain("Rewind conversation?")
  expect(frame).not.toContain("Undo conversation?")
  expect(app.posts()).toEqual([])
  await app.confirm("rewind")
  await app.waitFor(() => !app.state.modal)
  expect(app.posts().map((request) => [request.path, request.body])).toEqual([
    ["/api/session/ses_rewind/interrupt", ""],
    ["/api/session/ses_rewind/revert/stage", '{"messageID":"msg_z","files":false}'],
  ])
  expect(app.calls[1]).toEqual(["restore", "ses_rewind", "msg_z", "Earlier real prompt"])
})

test("Escape in the rewind picker stages nothing", async () => {
  const app = await fixture()
  await picker(app)
  app.view.mockInput.pressEscape()
  await app.waitFor(() => !app.state.modal)
  expect(app.posts()).toEqual([])
})

test("the rewind picker refuses task-owned sessions, the staged boundary and later prompts", async () => {
  const owned = await fixture()
  owned.remote.blocked = true
  owned.controls.pick()
  expect(owned.state.modal).toBeUndefined()
  expect(owned.requests).toEqual([])
  expect(owned.notices.at(-1)).toContain("Task-owned")

  const staged = await fixture({ messageID: "msg_z", files: [], diff: "", snapshot: "tree_original" })
  await picker(staged)
  staged.view.mockInput.pressEnter()
  await staged.waitFor(() => staged.notices.some((notice) => notice.includes("after the staged boundary")))
  expect(staged.state.modal).toBeUndefined()
  const picked = await fixture({ messageID: "msg_z", files: [], diff: "", snapshot: "tree_original" })
  await picker(picked)
  picked.view.mockInput.pressArrow("down")
  picked.view.mockInput.pressEnter()
  await picked.waitFor(() => picked.notices.some((notice) => notice.includes("already the staged boundary")))
  expect(staged.posts().concat(picked.posts())).toEqual([])
})
