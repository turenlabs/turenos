import { expect, test } from "bun:test"
import { agent, world } from "./agent-fixture"
import { assistant } from "./support"

// A long audit turn: a text part per step, ending with the report the reader came for.
const turn = () => {
  const parts = Array.from({ length: 300 }, (_, index) => ({ id: `prt_${index}`, type: "text", text: `step ${index}` }))
  return assistant("long", "", {
    content: [...parts.slice(0, 299), { id: "prt_final", type: "text", text: "FINAL REPORT" }],
  })
}

test("show and wait print the final text part of a 300-part reply", async () => {
  const server = world()
  server.state.messages = [turn()]
  const shown = await agent(["show", "ses_main"], { url: server.url })
  expect(shown.stdout).toContain("step 0")
  expect(shown.stdout).toContain("[172 parts omitted]")
  expect(shown.stdout).toContain("FINAL REPORT")
  const everything = await agent(["show", "ses_main", "--all"], { url: server.url })
  expect(everything.stdout).toContain("FINAL REPORT")
  const waited = await agent(["wait", "ses_main"], { url: server.url })
  expect(waited.code).toBe(0)
  expect(waited.stdout).toContain("FINAL REPORT")
})
