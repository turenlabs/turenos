import { expect, test } from "bun:test"
import { sandbox } from "./support"

// The smallest supported terminal; every control must stay reachable here.
const tui = sandbox("layout", { cols: 60, rows: 24 })

test("at 60x24 a session can be started and answered", async () => {
  await tui.launch("hello at sixty columns")
  await tui.waitFor("Sandbox reply to: hello at sixty")
  await tui.idle()
})

test("help opens and closes at 60x24", async () => {
  await tui.keys("?")
  await tui.waitFor("Keyboard shortcuts")
  await tui.keys("Escape")
  await tui.waitFor((screen) => !screen.includes("Keyboard shortcuts"))
})

test("a reply keeps streaming across resizes and can be stopped", async () => {
  await tui.reply("a slow one")
  await tui.waitFor("word2")
  tui.resize({ cols: 120, rows: 36 })
  await tui.waitFor("x Stop")
  tui.resize({ cols: 80, rows: 24 })
  await tui.waitFor(/word1\d/)
  await tui.keys("x")
  await tui.waitFor("Type stop")
  await tui.type("stop")
  await tui.keys("C-s")
  await tui.waitFor("INTERRUPTED")
  await tui.idle()
})

test("below the minimum size the TUI asks for a bigger terminal, then recovers", async () => {
  tui.resize({ cols: 50, rows: 20 })
  await tui.waitFor("Resize the terminal")
  tui.resize({ cols: 80, rows: 24 })
  await tui.waitFor((screen) => !screen.includes("Resize the terminal"))
})

test("q quits, restores the terminal and says so", async () => {
  await tui.keys("q")
  const screen = await tui.waitFor("[sandbox] turen-tui exited with status 0")
  expect(screen).toContain("Turen TUI closed.")
})
