import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mountDashboard } from "../src/index"
import { cleanup, waitForFrame, fixture } from "./dashboard-fixture"

test("an open permission dialog closes when a refresh shows it was resolved elsewhere", async () => {
  const server = fixture()
  server.pending.permissions = [{ id: "per_gone", sessionID: "ses_running", action: "shell", resources: ["npm test"] }]
  const view = await createTestRenderer({ width: 110, height: 38 })
  cleanup.push(() => view.renderer.destroy())
  const app = mountDashboard(view.renderer, server.connection, server.server.url.href)
  cleanup.push(app.dispose)
  await app.ready
  await waitForFrame(view, (frame) => frame.includes("Permission request"))
  server.pending.permissions = []
  await app.refresh()
  const frame = await waitForFrame(view, (text) => text.includes("no longer pending"))
  expect(frame).not.toContain("Permission request")
  expect(server.posts).toHaveLength(0)
})
