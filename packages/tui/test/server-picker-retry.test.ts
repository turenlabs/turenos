import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { createServerPicker } from "../src/server-picker"
import { createServers, type Entry, type Target } from "../src/servers"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const initial: Target = {
  kind: "url",
  id: "startup-url",
  name: "http://127.0.0.1:1",
  url: "http://127.0.0.1:1",
  saved: false,
}
const privateServer: Entry = {
  target: { kind: "headless", id: "headless", name: "Private server", binary: "/synthetic/forge" },
  group: "This computer",
  detail: "Starts a private server",
}

async function fixture(entries: Entry[]) {
  const home = await mkdtemp(join(tmpdir(), "tui-picker-retry-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const servers = createServers({ env: {}, home, forge: null, persistentRecord: join(home, "missing-record") })
  // The real chooser owns layout and input; discovery and connection are synthetic boundaries.
  servers.scan = async () => entries
  const view = await createTestRenderer({ width: 80, height: 24 })
  cleanup.push(() => view.renderer.destroy())
  const attempts: Target[] = []
  const picker = createServerPicker(view.renderer, servers, {
    current: () => undefined,
    drafts: () => 0,
    connect: async (target) => {
      attempts.push(target)
      throw new Error("Synthetic connection refused")
    },
    closed() {},
    quit() {},
  })
  cleanup.push(() => picker.close(false))
  picker.start(initial)
  await view.waitForFrame((frame) => frame.includes("Synthetic connection refused"))
  return { servers, view, attempts }
}

test("a failed explicit startup URL stays selected for retry and is not persisted", async () => {
  const f = await fixture([privateServer])
  expect(f.view.captureCharFrame()).toContain(initial.name)
  expect(f.view.captureCharFrame()).toContain("THIS SESSION")
  f.view.mockInput.pressKey("r")
  await f.view.waitForFrame((frame) => frame.includes("Rescanned."))
  expect(f.view.captureCharFrame()).toContain(initial.name)
  f.view.mockInput.pressEnter()
  await f.view.waitForFrame((frame) => frame.includes("Synthetic connection refused"))
  expect(f.attempts.map((target) => target.id)).toEqual([initial.id, initial.id])
  expect(await Bun.file(f.servers.configPath).exists()).toBe(false)
})

test("a failed startup URL matching a local row selects that row without listing the URL twice", async () => {
  const local: Entry = {
    target: { kind: "persistent", id: "persistent", name: "Persistent server" },
    group: "This computer",
    detail: initial.url,
    url: initial.url,
  }
  const f = await fixture([privateServer, local])
  const frame = f.view.captureCharFrame()
  expect(frame.match(/http:\/\/127\.0\.0\.1:1/g)).toHaveLength(1)
  expect(frame).not.toContain("THIS SESSION")
  f.view.mockInput.pressEnter()
  await f.view.waitForFrame(() => f.attempts.length === 2)
  expect(f.attempts.map((target) => target.id)).toEqual([initial.id, local.target.id])
})
