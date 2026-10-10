import { expect, test } from "bun:test"
import { sandbox } from "./support"

const tui = sandbox("team")

type Answer = { teammates: { handle: string }[]; factoryRuns?: { status: string; result?: string }[] }

async function addTeammate(name: string, handle: string) {
  await tui.keys("a")
  await tui.waitFor("New teammate")
  await tui.type(name)
  await tui.keys("Tab")
  await tui.type(handle)
  await tui.keys("Tab")
  await tui.type("Analyst")
  await tui.keys("Tab")
  // The scripted model reacts to some everyday words, so the mission avoids them.
  await tui.type("Answer briefly.")
  await tui.keys("C-s")
  await tui.waitFor(`@${handle}  ${name}`)
}

test("two teammates are added from the Team tab", async () => {
  await tui.keys("4")
  await tui.waitFor("[4 Team]")
  await tui.waitFor("No messages yet.")
  await tui.type("M")
  await tui.waitFor("No teammates yet.")
  await addTeammate("Ada", "ada")
  await addTeammate("Bo", "bo")
  const answer = (await tui.api("GET", "/api/team")) as Answer
  expect(answer.teammates.map((mate) => mate.handle)).toEqual(["ada", "bo"])
  await tui.keys("Escape")
})

test("a factory is configured and run until its check is accepted", async () => {
  const project = ((await tui.api("GET", "/api/location")) as { directory: string }).directory
  await tui.type("F")
  await tui.waitFor("Not configured. s opens settings.")
  await tui.keys("s")
  await tui.waitFor("Outcome (required")
  await tui.type("Summarise the sandbox project")
  // Parameters keep {}; constraints stay empty.
  await tui.keys("Tab", "Tab", "Tab")
  await tui.type("One short line from each teammate")
  await tui.keys("Tab")
  await tui.keys("C-a", "C-k")
  await tui.type(project)
  await tui.keys("Tab", "Space", "Down", "Space")
  await tui.waitFor("(•) @ada")
  await tui.keys("C-s")
  await tui.waitFor("Factory saved. Saving does not start work")
  await tui.keys("C-r")
  await tui.waitFor("Request (optional")
  await tui.keys("C-s")
  await tui.waitFor("Factory run started.")
  const finished = await tui.waitFor(/Run \S+ · succeeded/, 90_000)
  expect(finished).toContain("Sandbox check accepted the outputs.")
  const answer = (await tui.api("GET", "/api/team")) as Answer
  expect(answer.factoryRuns?.[0]?.status).toBe("succeeded")
  expect(answer.factoryRuns?.[0]?.result).toBe("Sandbox check accepted the outputs.")
  await tui.keys("Escape")
})
