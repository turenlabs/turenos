import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { cleanup, turen } from "./support"

async function permissionDialog(save: string[]) {
  const server = turen({
    routes: {
      "GET /api/session/ses_main/permission": () => ({
        data: [{ id: "per_1", sessionID: "ses_main", action: "bash", resources: ["make"], save }],
      }),
      "POST /api/session/ses_main/permission/per_1/reply": () => new Response(null, { status: 204 }),
    },
  })
  const view = await createTestRenderer({ width: 60, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  const screen = async (text: string) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (view.captureCharFrame().includes(text)) return view.captureCharFrame()
      await Bun.sleep(20)
    }
    throw new Error(`Expected ${JSON.stringify(text)}:\n${view.captureCharFrame()}`)
  }
  return { server, view, screen }
}

test("allow always lists every saved rule in the dialog body and keeps the option to a summary", async () => {
  const save = Array.from({ length: 8 }, (_, index) => `rule${index} ${"x".repeat(90)} end${index}`)
  const { view, screen } = await permissionDialog(save)
  const seen = new Set<number>()
  let frame = await screen("Permission request")
  expect(frame).toContain("saves 8 rules")
  expect(frame).not.toContain("Also allow")
  for (let page = 0; page < 12 && seen.size < 8; page++) {
    save.forEach((_, index) => frame.includes(`end${index}`) && seen.add(index))
    view.mockInput.pressKey("\x1b[6~")
    await view.renderOnce()
    frame = view.captureCharFrame()
  }
  expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
})

test("allow always refuses when the rule list had to be cut, and allow once still works", async () => {
  const save = Array.from({ length: 24 }, (_, index) => `rule${index}`)
  const { server, view, screen } = await permissionDialog(save)
  await screen("Permission request")
  view.mockInput.pressKey("3")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("too long to show in full")
  expect(server.sent("/api/session/ses_main/permission/per_1/reply")).toHaveLength(0)
  view.mockInput.pressKey("2")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Allowed once.")
  expect(server.sent("/api/session/ses_main/permission/per_1/reply")[0]?.body).toMatchObject({ reply: "once" })
})
