import { SelectRenderable } from "@opentui/core"
import { afterEach, expect, test } from "bun:test"
import { cleanup, dashboard } from "./support"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const selects = (app: Awaited<ReturnType<typeof dashboard>>) => {
  const found: SelectRenderable[] = []
  const walk = (node: { getChildren(): unknown[] }) =>
    node.getChildren().forEach((child) => {
      if (child instanceof SelectRenderable) found.push(child)
      walk(child as { getChildren(): unknown[] })
    })
  walk(app.view.renderer.root)
  return found
}

test("every Appearance description fits the dialog at 80 columns", async () => {
  const app = await dashboard({})
  app.view.resize(80, 30)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 7; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("Settings › Appearance")
  expect(frame).toContain("Bell and title alerts · Enter turns them off")
  const rows = selects(app)
    .at(-1)!
    .options.flatMap((option) => [option.name, option.description])
  for (const text of rows) expect(text.length, text).toBeLessThanOrEqual(56)
})

test("the Settings root cuts descriptions to its width with an ellipsis and refits on resize", async () => {
  const app = await dashboard({})
  app.view.resize(60, 24)
  app.view.mockInput.pressKey(",")
  const narrow = await app.screen("Usage and limits")
  const row = narrow.split("\n").find((line) => line.includes("Motion, alerts"))!
  expect(row).toMatch(/Motion, alerts and transcript display[^│]*…\s*│/)
  app.view.resize(120, 36)
  await app.screen("Motion, alerts and transcript display on this computer")
})

test("the command palette cuts every row to its laid-out width and keeps the key whole", async () => {
  const app = await dashboard({})
  app.view.resize(60, 24)
  app.view.mockInput.pressKey("p", { ctrl: true })
  const frame = await app.screen("Find a command")
  const options = selects(app).at(-1)!.options
  for (const option of options.slice(0, 10)) expect(frame, option.name).toContain(option.name)
  expect(options.find((option) => option.name.startsWith("Archive / restore session"))!.name).toEndWith("…")
  expect(options.find((option) => option.name.startsWith("Switch session"))!.name).toEndWith("(Ctrl+K)")
  app.view.resize(120, 36)
  await app.screen("Hide or restore history")
})

function extension(id: string, name: string, enabled: boolean) {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name,
      description: `${name} description`,
      version: "1",
      publisher: "turen",
      trust: "verified",
      contributions: [{ type: "skill", id, name, description: `${name} description` }],
    },
    origin: "catalog",
    mutable: true,
    enabled,
    status: enabled ? "available" : "disabled",
    secretsSet: {},
    configurationSet: {},
  }
}

test("the Extensions list uses one state vocabulary for every row, chosen by width", async () => {
  const list = () => [
    extension("a", "Automox", false),
    extension("b", "1Password Developer Tools", false),
    extension("c", "Customize TurenOS", true),
  ]
  const app = await dashboard({ "GET /extension": list })
  const rows = (frame: string) => frame.split("\n").filter((line) => /[●○] .* · \S+/.test(line))
  app.view.resize(80, 24)
  await app.palette("Extensions")
  const narrow = rows(await app.screen("1 of 3 enabled"))
  expect(narrow.length).toBe(3)
  for (const row of narrow) expect(row).toMatch(/ · (on|off)\s/)
  app.view.mockInput.pressKey("ESCAPE")
  await app.screen("Sessions")
  app.view.resize(120, 36)
  await app.palette("Extensions")
  const wide = rows(await app.screen("1 of 3 enabled"))
  expect(wide.length).toBe(3)
  for (const row of wide) expect(row).toMatch(/ · (enabled|disabled)/)
})

const wing = { id: "wng_1", kind: "project", key: "turen", name: "turen", timeCreated: 1, timeUpdated: 1 }
const room = { id: "rom_1", wingID: "wng_1", slug: "tooling", name: "Tooling", timeCreated: 1, timeUpdated: 1 }
const memory = {
  id: "drw_1",
  wingID: "wng_1",
  roomID: "rom_1",
  kind: "note",
  title: "Prefers short answers over long explanations in every reply",
  body: "Keep replies brief.",
  anchor: {},
  provenance: { assertedBy: "settings", source: "human" },
  timeValidFrom: 1,
  timeCreated: 1,
  timeUpdated: 5,
}

test("a memory title is cut to the list column with an ellipsis and the pane repeats it whole", async () => {
  const app = await dashboard({
    "GET /api/memory/wing": () => [wing],
    "GET /api/memory/room": () => [room],
    "GET /api/memory": () => [memory],
  })
  app.view.resize(80, 24)
  await app.palette("Memories")
  await app.screen("project · turen")
  app.view.mockInput.pressEnter()
  await app.screen("All rooms")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("Recorded by settings (human)")
  const row = frame.split("\n").find((line) => line.includes("[note] Prefers"))!
  expect(row).toMatch(/\[note\] Prefers[^│]*…/)
  expect(frame).toContain("Prefers short answers over long explanations")
})

test("a feed description cut by the server ends in an ellipsis", async () => {
  const summary = "alpha ".repeat(100).slice(0, 500)
  const advisory = {
    id: "GHSA-1",
    title: "Parser overflow",
    severity: "critical",
    publishedAt: 1,
    updatedAt: 1,
    source: "github",
    summary,
  }
  const app = await dashboard({
    "GET /api/intel/advisories": () => ({ items: [advisory], total: 1, page: 1, pageSize: 50 }),
  })
  app.view.mockInput.pressKey("I")
  await app.screen("al…")
})
