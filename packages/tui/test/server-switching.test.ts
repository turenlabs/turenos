import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { mountApp } from "../src/index"
import { createServers, type Servers, type Target } from "../src/servers"
import { cleanup, terminal, turen, until } from "./support"

async function setup(
  options: {
    desktop?: boolean
    initial?: (servers: Servers, beta: ReturnType<typeof turen>) => Target
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "turen-tui-switch-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const alpha = turen({ name: "alpha", password: "secret" })
  const beta = turen({ name: "beta", password: "b-secret" })
  if (options.desktop !== false) {
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
  }
  const servers = createServers({ home, platform: "darwin", env: {}, forge: null, config: join(home, "servers.json") })
  await servers.add({ address: beta.listener.url.origin, name: "beta" })
  const { view, screen } = await terminal()
  let quits = 0
  const discarded: number[] = []
  const app = mountApp(view.renderer, servers, {
    initial: options.initial ? options.initial(servers, beta) : await servers.preferred(),
    onQuit: (drafts) => {
      quits++
      discarded.push(drafts)
    },
  })
  cleanup.push(app.dispose)
  return { view, app, alpha, beta, screen, servers, home, quits: () => quits, discarded }
}

test("opens the running desktop app, then switches to a saved server after a password prompt", async () => {
  const { view, alpha, screen } = await setup()
  const first = await screen("alpha says hello")
  expect(first).toContain("● This computer")
  expect(first).toContain("Servers s")
  view.mockInput.pressKey("s")
  const picker = await screen("THIS COMPUTER")
  expect(picker).toContain("SAVED")
  expect(picker).toMatch(/● TurenOS\s+Desktop app · port \d+\s+· current/)
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("beta needs a password")
  // A resize re-lays out the dashboard behind the picker; it must not take the password field's focus.
  await view.mockInput.typeText("b-sec")
  view.resize(118, 36)
  await view.renderOnce()
  await view.mockInput.typeText("ret")
  expect(view.captureCharFrame()).not.toContain("b-secret")
  view.mockInput.pressEnter()
  const second = await screen("beta says hello")
  expect(second).toContain("● beta")
  expect(second).not.toContain("alpha says hello")
  // The first dashboard stopped polling once it was replaced.
  const before = alpha.requests.length
  await Bun.sleep(2500)
  expect(alpha.requests.length).toBe(before)
})

test("Esc returns to the same dashboard, and the picker owns the keyboard while open", async () => {
  const { view, screen } = await setup()
  await screen("alpha says hello")
  view.mockInput.pressKey("s")
  await screen("THIS COMPUTER")
  view.mockInput.pressKey("n")
  await view.renderOnce()
  expect(view.captureCharFrame()).not.toContain("New session")
  view.mockInput.pressKey("ESCAPE")
  const frame = await screen("alpha says hello")
  expect(frame).not.toContain("THIS COMPUTER")
  view.mockInput.pressKey("n")
  await screen("New session")
})

test("switching away from unsent drafts asks for a second Enter", async () => {
  const { view, screen } = await setup()
  await screen("alpha says hello")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("unsent reply")
  view.mockInput.pressKey("ESCAPE")
  // Escape is only final once the terminal knows it did not start an Alt+key sequence.
  await screen("Resume reply")
  view.mockInput.pressKey("s")
  await screen("THIS COMPUTER")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("1 unsent draft on TurenOS will be discarded")
  view.mockInput.pressEnter()
  await screen("beta needs a password")
})

test("a server opened by URL stays listed after switching away, so switching back works", async () => {
  const { view, beta, screen, servers } = await setup({
    initial: (servers, beta) => {
      const target = { kind: "url", id: "cli", name: "cli-beta", url: beta.listener.url.origin, saved: false } as const
      servers.remember(target, "b-secret")
      return target
    },
  })
  await screen("beta says hello")
  view.mockInput.pressKey("s")
  await screen("OPENED THIS SESSION")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("alpha says hello")
  view.mockInput.pressKey("s")
  const picker = await screen("OPENED THIS SESSION")
  expect(picker).toContain("cli-beta")
  view.mockInput.pressArrow("up")
  view.mockInput.pressEnter()
  await screen("beta says hello")
  expect(beta.requests.at(-1)).toBeDefined()
  expect(servers.find("cli-beta")).toBeUndefined()
})

test("the picker opened from a dashboard says why a running desktop is not listed", async () => {
  const { view, screen, home } = await setup()
  await screen("alpha says hello")
  const directory = join(home, "Library", "Application Support", "com.turenlabs.forge.beta")
  await mkdir(directory, { recursive: true })
  await symlink(`${hostname()}-${process.pid}`, join(directory, "SingletonLock"))
  view.mockInput.pressKey("s")
  await screen("TurenOS Beta is running but does not publish its server", 2500)
})

test("without a local server the picker explains why and q quits", async () => {
  const { view, screen, quits } = await setup({ desktop: false })
  await screen("TurenOS is not running on this computer")
  const frame = await screen("SAVED")
  expect(frame).toContain("beta")
  expect(frame).not.toContain("Esc back")
  view.mockInput.pressKey("q")
  expect(quits()).toBe(1)
})

test("a freshly connected dashboard has keyboard focus, so Enter opens the reply editor", async () => {
  const { view, screen } = await setup()
  await screen("alpha says hello")
  expect(view.renderer.currentFocusedRenderable).toBeTruthy()
  // First Enter opens the focused session from the list; the second opens its reply editor.
  view.mockInput.pressEnter()
  await view.renderOnce()
  view.mockInput.pressEnter()
  await screen("Your message")
})

test("a dashboard reached by switching servers also has keyboard focus", async () => {
  const { view, screen } = await setup()
  await screen("alpha says hello")
  view.mockInput.pressKey("s")
  await screen("THIS COMPUTER")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("beta needs a password")
  await view.mockInput.typeText("b-secret")
  view.mockInput.pressEnter()
  await screen("beta says hello")
  expect(view.renderer.currentFocusedRenderable).toBeTruthy()
  // First Enter opens the focused session from the list; the second opens its reply editor.
  view.mockInput.pressEnter()
  await view.renderOnce()
  view.mockInput.pressEnter()
  await screen("Your message")
})

test("quitting reports the unsent drafts it discards so the closing line can say so", async () => {
  const { view, screen, quits, discarded } = await setup()
  await screen("alpha says hello")
  view.mockInput.pressKey("f")
  await view.mockInput.typeText("unsent words")
  view.mockInput.pressKey("c", { ctrl: true })
  await screen("Draft kept")
  view.mockInput.pressKey("c", { ctrl: true })
  await until(() => quits() === 1)
  expect(discarded).toEqual([1])
})
