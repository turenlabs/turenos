import { expect, test } from "bun:test"
import { open, room, world } from "./team-fixture"

const base = {
  outcome: "Ship",
  parameters: {},
  acceptanceCriteria: "One",
  directory: "/srv/main",
  coordinatorTeammateID: "tm_moss",
  teammateIDs: ["tm_moss", "tm_rae"],
}

test("factory panel keeps every character of wrapped setup text beside the scroll bar", async () => {
  const lost: string[] = []
  for (const pad of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const words =
      `${"x".repeat(pad)} ${Array.from({ length: 70 }, (_, i) => `w${String(i).padStart(2, "0")}${"q".repeat(i % 7)}`).join(" ")}`.trim()
    const w = world()
    w.state.rooms = [{ ...room, factory: { revision: 2, config: { ...base, constraints: words } } }]
    const app = await open(w.routes, 160, 44)
    await app.screen("Done")
    app.view.mockInput.pressKey("F", { shift: true })
    const f = await app.screen("Revision 2")
    const pane = f.split("\n").map((l) => l.slice(37, 157).trim())
    const start = pane.findIndex((l) => l.startsWith("Constraints:"))
    const end = pane.findIndex((l) => l.startsWith("Coordinator:"))
    const got = pane.slice(start, end).join(" ").replace("Constraints: ", "")
    if (got !== words)
      lost.push(
        `pad ${pad}: ${words
          .split(" ")
          .filter((x) => !got.split(" ").includes(x))
          .join(",")}`,
      )
  }
  expect(lost).toEqual([])
})

test("factory panel keeps every character of an unbroken token beside the scroll bar", async () => {
  const token = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")
  const w = world()
  w.state.runs = [
    {
      id: "run_1",
      roomID: "trm_team",
      status: "failed",
      phase: "work",
      taskIDs: [],
      error: token,
      time: { created: 1, updated: 2 },
    },
  ]
  w.state.rooms = [{ ...room, factory: { revision: 2, config: { ...base, constraints: "" } } }]
  const app = await open(w.routes, 160, 44)
  await app.screen("Done")
  app.view.mockInput.pressKey("F", { shift: true })
  const f = await app.screen("Error:")
  const pane = f.split("\n").map((l) => l.slice(37, 157).trim())
  const at = pane.findIndex((l) => l === "Error:")
  expect(pane.slice(at + 1, at + 4).join("")).toBe(token)
})
