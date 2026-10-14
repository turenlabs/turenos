import { expect, test } from "bun:test"
import { connect } from "../src/server"
import { cleanup, openSwarmRoom, terminal, turen, until, type Route } from "./support"

async function keepDraft(onQuit = () => {}, routes: Record<string, Route> = {}) {
  const { mountDashboard } = await import("../src/index")
  const server = turen({ routes })
  const app = await terminal(120, 36)
  const { view, screen } = app
  const dashboard = mountDashboard(view.renderer, connect({ url: server.url }), server.url, onQuit)
  cleanup.push(dashboard.dispose)
  await dashboard.ready
  await openSwarmRoom(app as Parameters<typeof openSwarmRoom>[0])
  await view.mockInput.typeText("half a thought")
  await screen("half a thought")
  view.mockInput.pressKey("ESCAPE")
  await until(() => !view.captureCharFrame().includes("Swarm room"))
  await screen("Post draft kept")
  return { dashboard, view, screen, server }
}

test("a kept swarm post draft counts as an unsent draft", async () => {
  const { dashboard } = await keepDraft()
  expect(dashboard.drafts()).toBe(1)
})

test("quitting with a kept swarm post draft waits for a second press", async () => {
  let quits = 0
  const { view } = await keepDraft(() => quits++)
  view.mockInput.pressKey("q")
  await Bun.sleep(100)
  expect(quits).toBe(0)
  view.mockInput.pressKey("q")
  await until(() => quits === 1)
})

test.each([false, true])(
  "a resumed swarm draft is removed only after an acknowledged post (refused: %s)",
  async (refused) => {
    const { dashboard, view, screen, server } = await keepDraft(undefined, {
      "POST /api/session/ses_main/room/entries": () =>
        refused
          ? Response.json({ message: "Post refused" }, { status: 400 })
          : {
              data: {
                id: "ent_1",
                roomID: "room_1",
                seq: 1,
                actor: { type: "human", memberID: "mem_1", name: "you" },
                kind: "message",
                text: "half a thought",
                baseRevision: 0,
                timeCreated: 1,
              },
            },
    })
    expect(dashboard.drafts()).toBe(1)
    await Bun.sleep(150)
    view.mockInput.pressKey("w")
    await screen("half a thought")
    view.mockInput.pressKey("TAB")
    view.mockInput.pressEnter()
    await until(() => server.requests.some((item) => item.method === "POST" && item.path.endsWith("/room/entries")))
    if (refused) {
      await screen("Post refused")
      expect(dashboard.drafts()).toBe(1)
      expect(view.captureCharFrame()).toContain("half a thought")
      return
    }
    await until(() => dashboard.drafts() === 0)
    expect(view.captureCharFrame()).toContain("Swarm room")
  },
)
