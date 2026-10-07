import { expect, test } from "bun:test"
import { sandbox } from "./support"

const tui = sandbox("tabs")

test("a terminal is created, attached, used and detached", async () => {
  await tui.keys("2")
  // Brackets mark the open tab; the unbracketed label is always in the tab bar.
  await tui.waitFor("[2 Term]")
  await tui.keys("a")
  // The sidebar also offers "+ New terminal", so wait for the dialog's own frame title.
  await tui.waitFor("╭─ New terminal")
  await tui.keys("C-s")
  // A new terminal attaches at once, full screen. The Terminals tab also says "(Ctrl+] detaches)",
  // so wait for the attach header and the shell's prompt, not just the key name.
  await tui.waitFor("on the server · Ctrl+] detaches")
  await tui.waitFor(/project\$\s*$/m)
  await tui.type("echo attached-$((40+2))")
  await tui.keys("Enter")
  await tui.waitFor("attached-42")
  await tui.keys("C-]")
  await tui.waitFor("Detached")
  await tui.waitFor("[running]")
  const terminals = (await tui.api("GET", "/api/pty")) as unknown[] | { data: unknown[] }
  expect(Array.isArray(terminals) ? terminals.length : terminals.data.length).toBe(1)
})

test("an automation is created on the Automations tab", async () => {
  await tui.keys("3")
  await tui.waitFor("[3 Auto]")
  await tui.keys("a")
  await tui.waitFor("╭─ New automation")
  await tui.type("Nightly summary")
  await tui.keys("Tab")
  await tui.type("summarise the day")
  await tui.keys("Tab")
  // The schedule starts as "every 1h": clear it (line start, delete to end) before typing.
  await tui.keys("C-a", "C-k")
  await tui.type("every 1d")
  await tui.keys("C-s")
  await tui.waitFor((screen) => !screen.includes("╭─ New automation") && screen.includes("Nightly summary"))
  await tui.waitFor("Every 1d")
  const loops = (await tui.api("GET", "/api/loop")) as { data: { name?: string }[] } | { name?: string }[]
  expect(JSON.stringify(loops)).toContain("Nightly summary")
})

test("Settings opens and closes", async () => {
  await tui.keys("1")
  await tui.keys(",")
  await tui.waitFor("Providers")
  await tui.keys("Escape")
  await tui.waitFor((screen) => !screen.includes("Usage and limits"))
})
