import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mountApp } from "../src/index"
import { createServers } from "../src/servers"
import { cleanup, terminal, turen } from "./support"

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "turen-tui-fsettings-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const alpha = turen({ name: "alpha", password: "secret" })
  const beta = turen({ name: "beta", password: "b-secret" })
  const directory = join(home, "Library", "Application Support", "com.turenlabs.forge")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "attach.json"),
    JSON.stringify({
      version: 1,
      url: alpha.listener.url.origin,
      username: "forge",
      password: "secret",
      pid: process.pid,
    }),
    { mode: 0o600 },
  )
  const servers = createServers({ home, platform: "darwin", env: {}, forge: null, config: join(home, "servers.json") })
  await servers.add({ address: beta.listener.url.origin, name: "beta" })
  await servers.add({ address: beta.listener.url.origin.replace("127.0.0.1", "localhost"), name: "delta" })
  const { view, screen } = await terminal()
  const app = mountApp(view.renderer, servers, { initial: await servers.preferred(), onQuit: () => {} })
  cleanup.push(app.dispose)
  await screen("alpha says hello")
  return { view, screen, beta, servers }
}

const marked = (frame: string) => frame.split("\n").find((line) => line.includes("▶")) ?? ""

/** The marked row once `check` holds for it. */
async function row(view: Awaited<ReturnType<typeof terminal>>["view"], check: (row: string) => boolean) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    await view.renderOnce()
    if (check(marked(view.captureCharFrame()))) return marked(view.captureCharFrame())
    await Bun.sleep(20)
  }
  throw new Error(`No marked row matched:\n${view.captureCharFrame()}`)
}

test("the server picker marks the selected row and opens on the current server every time", async () => {
  const { view, screen } = await setup()
  view.mockInput.pressKey("s")
  expect(marked(await screen("THIS COMPUTER"))).toContain("current")
  view.mockInput.pressArrow("down")
  await row(view, (line) => !line.includes("current"))
  view.mockInput.pressKey("ESCAPE")
  await screen("alpha says hello")
  view.mockInput.pressKey("s")
  await screen("THIS COMPUTER")
  expect(await row(view, (line) => line.includes("current"))).toContain("current")
})

test("removing a saved server keeps the cursor near where it was", async () => {
  const { view, screen, servers } = await setup()
  view.mockInput.pressKey("s")
  await screen("SAVED")
  while (!marked(view.captureCharFrame()).includes("beta")) {
    view.mockInput.pressArrow("down")
    await Bun.sleep(30)
    await view.renderOnce()
  }
  view.mockInput.pressKey("d")
  await screen("Press d again to remove beta")
  view.mockInput.pressKey("d")
  await screen("Removed beta.")
  expect(servers.find("beta")).toBeUndefined()
  const kept = await row(view, (line) => line.length > 0)
  expect(kept).not.toContain("current")
  expect(kept).not.toContain("beta")
})

test("the add form is titled under Servers and saves with Ctrl+S", async () => {
  const { view, screen, beta, servers } = await setup()
  view.mockInput.pressKey("s")
  await screen("THIS COMPUTER")
  view.mockInput.pressKey("a")
  const form = await screen("Servers › Add server")
  expect(form).toContain("Ctrl+S")
  await view.mockInput.typeText(beta.listener.url.origin)
  view.mockInput.pressTab()
  await view.mockInput.typeText("gamma")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Saved gamma.")
  expect(servers.find("gamma")).toBeDefined()
})

test("Esc in Servers returns to Settings when Settings opened it", async () => {
  const { view, screen } = await setup()
  view.mockInput.pressKey(",")
  await screen("Usage and limits")
  for (let step = 0; step < 6; step++) view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("THIS COMPUTER")
  view.mockInput.pressKey("ESCAPE")
  const frame = await screen("Usage and limits")
  expect(frame).not.toContain("THIS COMPUTER")
})
