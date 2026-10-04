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
  await tui.keys("d")
  const changes = await tui.waitFor("notes.md")
  expect(changes).toMatch(/\+\s*# Notes/)
  await tui.keys("Escape")
  await tui.waitFor((screen) => !screen.includes("+# Notes") && !screen.includes("+ # Notes"))
})

test("Files lists the project and opens a file", async () => {
  await tui.keys("e")
  await tui.waitFor("README.md")
  await tui.waitFor("answer.ts")
  await tui.keys("Escape")
})

test("a todo list shows its statuses in Tasks", async () => {
  await tui.reply("make a todo list")
  await tui.waitFor("Done: the todowrite tool returned")
  await tui.idle()
  await tui.keys("t")
  const tasks = await tui.waitFor("Write the notes file")
  expect(tasks).toContain("Read the sandbox README")
  expect(tasks).toContain("Review the changes")
  await tui.keys("Escape")
})

test("a delegated subagent runs in a child session the parent can list", async () => {
  await tui.reply("delegate the summary")
  await tui.waitFor("Done: the spawn_agent tool returned", 30_000)
  await tui.idle(60_000)
  const sessions = (await tui.api("GET", "/api/session")) as { data: { title: string; parentID?: string }[] }
  expect(sessions.data.filter((session) => session.parentID).length).toBe(1)
  await tui.keys("t")
  await tui.waitFor("Summarise the readme")
  await tui.keys("Escape")
})
