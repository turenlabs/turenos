import { expect, test } from "bun:test"
import { until } from "./support"
import { loop, open, world, type World } from "./team-fixture"

const ops = { id: "trm_ops", name: "ops", topic: "", head: 0 }

/** The server applies a change to one room and answers with it. */
function change(w: World, id: string, edit: Record<string, unknown>) {
  const index = w.state.rooms.findIndex((item) => item.id === id)
  w.state.rooms[index] = { ...w.state.rooms[index], ...edit }
  return w.state.rooms[index]
}

test("n new room asks for a name and topic, sends them, and selects the new room", async () => {
  const w = world({
    "POST /api/team/room": () => {
      w.state.rooms.push(ops)
      return ops
    },
  })
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("a")
  await screen("New room")
  await view.mockInput.typeText("ops")
  view.mockInput.pressKey("TAB")
  await view.mockInput.typeText("Incident work")
  view.mockInput.pressKey("s", { ctrl: true })
  const frame = await screen("No messages yet.")
  expect(w.sent("POST", "/api/team/room")[0]!.body).toEqual({ name: "ops", topic: "Incident work" })
  expect(frame).toContain("# ops")
})

test("a room needs a name, and a refused create may be corrected and sent again", async () => {
  let attempts = 0
  const w = world({
    "POST /api/team/room": () => {
      if (++attempts === 1)
        return Response.json({ _tag: "InvalidRequestError", message: "Room names are unique" }, { status: 400 })
      w.state.rooms.push(ops)
      return ops
    },
  })
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("a")
  await screen("New room")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Enter a room name.")
  expect(w.sent("POST", "/api/team/room")).toHaveLength(0)
  await view.mockInput.typeText("ops")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Room names are unique")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("No messages yet.")
  expect(attempts).toBe(2)
})

test("E edits the name and the topic of an active room", async () => {
  const w = world({
    "PATCH /api/team/room/trm_team": () => change(w, "trm_team", { name: "crew" }),
  })
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("E", { shift: true })
  const form = await screen("Edit")
  expect(form).toContain("Ship it")
  view.mockInput.pressKey("a", { ctrl: true })
  view.mockInput.pressKey("k", { ctrl: true })
  await view.mockInput.typeText("crew")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("PATCH", "/api/team/room/trm_team").length === 1)
  expect(w.sent("PATCH", "/api/team/room/trm_team")[0]!.body).toEqual({ name: "crew", topic: "Ship it" })
  await screen("# crew")
})

test("archiving needs the typed word, then selects the next active room", async () => {
  const w = world({
    "POST /api/team/room/trm_team/archive": () => change(w, "trm_team", { archived: true }),
  })
  w.state.rooms.push(ops)
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("d")
  const menu = await screen("Archive")
  expect(menu).toContain("Read-only, schedules pause")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const dialog = await screen("Confirmation (type archive)")
  expect(dialog).toContain("The room becomes read-only")
  expect(dialog).toContain("work must finish first")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Type archive to confirm.")
  expect(w.sent("POST", "/api/team/room/trm_team/archive")).toHaveLength(0)
  await view.mockInput.typeText("archive")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("# ops")
  expect(w.sent("POST", "/api/team/room/trm_team/archive")).toHaveLength(1)
})

test("restoring an archived room says it does not resume schedules", async () => {
  const w = world({
    "POST /api/team/room/trm_old/restore": () => change(w, "trm_old", { archived: false }),
  })
  const { view, screen } = await open(w.routes)
  await screen("1 archived hidden")
  view.mockInput.pressKey("A", { shift: true })
  await screen("# retro · archived")
  view.mockInput.pressArrow("up")
  await screen("Archived · read-only")
  view.mockInput.pressKey("d")
  const menu = await screen("Restore")
  expect(menu).toContain("Delete permanently")
  view.mockInput.pressEnter()
  const dialog = await screen("Restoring does not")
  expect(dialog).toContain("resume schedules that archiving paused.")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("POST", "/api/team/room/trm_old/restore").length === 1)
  await screen("Restored. Its schedules stay paused: resume them in Automations (3).")
})

test("delete refuses locally while a schedule is linked, and asks for the word once none is", async () => {
  const w = world({
    "DELETE /api/team/room/trm_old": () => {
      w.state.rooms = w.state.rooms.filter((item) => item.id !== "trm_old")
      return new Response(null, { status: 204 })
    },
  })
  w.state.loops = [{ ...loop, factoryRoomID: "trm_old" }]
  const { view, screen } = await open(w.routes)
  await screen("1 archived hidden")
  view.mockInput.pressKey("A", { shift: true })
  await screen("# retro · archived")
  view.mockInput.pressArrow("up")
  await screen("Archived · read-only")
  view.mockInput.pressKey("d")
  await screen("Delete permanently")
  const menu = (await screen("Automations (3).")).replace(/\s*│\s*\n\s*│\s*/g, " ")
  expect(menu).toContain('Blocked: 1 linked schedule ("Nightly check"). Remove it in Automations (3).')
  expect(menu).toContain("Blocked, see above")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Remove it in Automations (3).")
  await Bun.sleep(100)
  expect(w.sent("DELETE", "/api/team/room/trm_old")).toHaveLength(0)
  w.state.loops = []
  view.mockInput.pressKey("r")
  await Bun.sleep(2300)
  view.mockInput.pressKey("d")
  await screen("Delete permanently")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Confirmation (type delete)")
  await view.mockInput.typeText("delete")
  view.mockInput.pressKey("s", { ctrl: true })
  await until(() => w.sent("DELETE", "/api/team/room/trm_old").length === 1)
  await screen("Room deleted.")
})

test("an active room shows Delete as unavailable until it is archived", async () => {
  const w = world()
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("d")
  const menu = await screen("Delete (archive first)")
  expect(menu).not.toContain("Delete permanently")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Archive this room before you delete it.")
  expect(w.sent("DELETE", "/api/team/room/trm_team")).toHaveLength(0)
})

test("Enter in a typed-word confirmation sends once the word is typed", async () => {
  const w = world({
    "POST /api/team/room/trm_team/archive": () => change(w, "trm_team", { archived: true }),
  })
  w.state.rooms.push(ops)
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("d")
  await screen("Archive")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Confirmation (type archive)")
  view.mockInput.pressEnter()
  await screen("Type archive to confirm.")
  expect(w.sent("POST", "/api/team/room/trm_team/archive")).toHaveLength(0)
  await view.mockInput.typeText("archive")
  view.mockInput.pressEnter()
  await until(() => w.sent("POST", "/api/team/room/trm_team/archive").length === 1)
})

test("in the new room form Enter moves to the topic and sends from the last field", async () => {
  const w = world({
    "POST /api/team/room": async (request) => {
      const body = (await request.json()) as { name: string; topic: string }
      const created = { id: "trm_new", name: body.name, topic: body.topic, head: 0 }
      w.state.rooms = [...w.state.rooms, created]
      return created
    },
  })
  const { view, screen } = await open(w.routes)
  await screen("Done")
  view.mockInput.pressKey("a")
  await screen("Topic (optional)")
  view.mockInput.pressEnter()
  view.mockInput.pressEnter()
  await screen("Enter a room name.")
  expect(w.sent("POST", "/api/team/room")).toHaveLength(0)
  await view.mockInput.typeText("crew")
  view.mockInput.pressEnter()
  await view.mockInput.typeText("Plan the week")
  expect(w.sent("POST", "/api/team/room")).toHaveLength(0)
  view.mockInput.pressEnter()
  await until(() => w.sent("POST", "/api/team/room").length === 1)
  expect(w.sent("POST", "/api/team/room")[0]!.body).toEqual({ name: "crew", topic: "Plan the week" })
})
