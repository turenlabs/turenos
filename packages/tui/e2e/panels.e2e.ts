import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sandbox } from "./support"

const tui = sandbox("panels")

test("a file the agent writes shows in Changes with its added lines", async () => {
  await tui.launch("please write the notes")
  await tui.waitFor("Done: the write tool returned")
  await tui.idle()
  const project = ((await tui.api("GET", "/api/location")) as { directory: string }).directory
  expect(readFileSync(join(project, "notes.md"), "utf8")).toContain("Written by the sandbox model.")
  // The launched session's reply editor is open; Esc leaves it so d is the Changes shortcut.
  await tui.keys("Escape")
  await tui.waitFor("Focus:")
  await tui.keys("d")
  // The transcript shows the edit's diff inline too, so look for the Changes panel itself.
  const changes = await tui.waitFor(/Uncommitted changes · 1 file/)
  expect(changes).toContain("notes.md")
  expect(changes).toMatch(/\+\s*# Notes/)
  await tui.keys("Escape")
  await tui.waitFor((screen) => !screen.includes("Uncommitted changes"))
})

test("Files lists the project and opens a file", async () => {
  await tui.keys("e")
  await tui.waitFor("README.md")
  await tui.waitFor("answer.ts")
  // Moving the selection previews the file under it; stop once answer.ts shows with its line numbers.
  for (let step = 0; step < 6 && !/\b1 {2}export const answer = 42/.test(tui.screen()); step++) {
    await tui.keys("Down")
    await Bun.sleep(300)
  }
  await tui.waitFor(/\b1 {2}export const answer = 42/)
  await tui.keys("Escape")
})

test("a todo list shows its statuses in Tasks", async () => {
  await tui.reply("make a todo list")
  await tui.waitFor("Done: the todowrite tool returned")
  await tui.idle()
  await tui.keys("Escape")
  await tui.waitFor("Focus:")
  await tui.keys("t")
  // The todo texts are already in the transcript; the dialog's own header and marks are not.
  const tasks = await tui.waitFor("TO-DOS · 1/3 done · read-only")
  expect(tasks).toContain("● Read the sandbox README")
  expect(tasks).toContain("◐ Write the notes file")
  expect(tasks).toContain("○ Review the changes")
  await tui.keys("Escape")
})

test("a delegated subagent runs in a child session the parent can list", async () => {
  await tui.reply("delegate the summary")
  await tui.waitFor("Done: the spawn_agent tool returned", 30_000)
  await tui.idle(60_000)
  const sessions = (await tui.api("GET", "/api/session")) as { data: { title: string; parentID?: string }[] }
  expect(sessions.data.filter((session) => session.parentID).length).toBe(1)
  await tui.keys("Escape")
  await tui.waitFor("Focus:")
  await tui.keys("t")
  await tui.waitFor("Summarise the readme")
  await tui.keys("Escape")
})
