import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mountApp } from "../src/index"
import { fitDetail } from "../src/server-picker/detail"
import { createServers } from "../src/servers"
import { cleanup, dashboard, terminal, turen } from "./support"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const lines = (frame: string) => frame.split("\n").map((line) => line.replace(/^\s*[│╭╰]\s?|\s*[│╮╯]\s*$/g, ""))

function extension(id: string, name: string, enabled: boolean, status: string, contribution = {}) {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name,
      description: `${name} description`,
      version: "1",
      publisher: "turen",
      trust: "verified",
      contributions: [{ type: "skill", id, name, description: `${name} description`, ...contribution }],
    },
    origin: "catalog",
    mutable: true,
    enabled,
    status,
    secretsSet: {},
    configurationSet: {},
  }
}

test("extension rows keep the state word and end-cut the name with an ellipsis, at 80 columns too", async () => {
  const list = () => [
    extension("a", "Customize TurenOS", true, "available"),
    extension("b", "Datadog Security & Incident Response Tooling", false, "disabled"),
    extension("c", "Atlassian Security Context Provider", false, "disabled"),
  ]
  const { view, screen, palette } = await dashboard({ "GET /extension": list })
  for (const [width, height] of [
    [120, 36],
    [80, 24],
  ] as const) {
    view.resize(width, height)
    await palette("Extensions")
    const frame = await screen("enabled")
    const rows = lines(frame).filter((line) => /^\s*(▶ )?[●○] /.test(line.trimStart()))
    expect(rows.length).toBe(3)
    // At 80 columns the column is narrow enough that on and off are the words that fit.
    for (const row of rows)
      expect(row).toMatch(width === 120 ? / · (enabled|disabled)(\s|$)/ : / · (enabled|disabled|on|off)(\s|$)/)
    expect(rows.find((row) => row.includes("Datadog"))).toContain("…")
    // The heading and the rows say the same word for the same state.
    expect(frame).toContain("1 of 3 enabled")
    expect(frame).not.toContain("available")
    view.mockInput.pressKey("ESCAPE")
    await screen("Sessions")
  }
})

test("the extension detail does not repeat the name, the state or the description", async () => {
  const { screen, palette } = await dashboard({
    "GET /extension": () => [extension("a", "Customize TurenOS", true, "available")],
  })
  await palette("Extensions")
  const frame = await screen("PROVIDES")
  // The list row, the pane heading and the description line; no `skill · name` line, no second description.
  expect(frame.split("Customize TurenOS").length - 1).toBe(3)
  expect(frame).toContain("Enabled")
  expect(frame).not.toContain("On · available")
  expect(frame.split("Customize TurenOS description").length - 1).toBe(1)
})

const wing = { id: "wng_1", kind: "project", key: "turen", name: "turen", timeCreated: 1, timeUpdated: 1 }
const personal = { id: "wng_2", kind: "person", key: "personal", name: "Personal", timeCreated: 1, timeUpdated: 1 }
const general = { id: "rom_1", wingID: "wng_2", slug: "general", name: "General", timeCreated: 1, timeUpdated: 1 }
const note = {
  id: "drw_1",
  wingID: "wng_2",
  roomID: "rom_1",
  kind: "note",
  title: "Prefers short answers",
  body: "The owner likes terse replies",
  anchor: {},
  provenance: { assertedBy: "settings", source: "human" },
  timeValidFrom: 1,
  timeCreated: 1,
  timeUpdated: 5,
}

test("memories define wings and rooms, drop repeated labels, and hint only keys that work", async () => {
  const { view, screen, palette } = await dashboard({
    "GET /api/memory/wing": () => [wing, personal],
    "GET /api/memory/room": () => [general],
    "GET /api/memory": () => [note],
  })
  await palette("Memories")
  let frame = await screen("Wings group memories by project or person.")
  expect(frame).toContain("Rooms are topics inside a wing.")
  expect(frame).not.toContain("person · personal")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  frame = await screen("All rooms")
  expect(frame).not.toContain("General\n")
  expect(frame).not.toContain("general")
  // The room hint offers `a` only on a room, not on All rooms.
  expect(frame).not.toContain("a add memory")
  view.mockInput.pressArrow("down")
  await screen("a add memory")
  view.mockInput.pressArrow("up")
  view.mockInput.pressEnter()
  frame = await screen("1 memory")
  // All rooms edits and deletes but cannot add, so its hint says so by omission, and the dialog fits its list.
  expect(frame).toContain("E edit")
  expect(frame).not.toContain("a add")
  expect(frame.split("\n").filter((line) => line.includes("│")).length).toBeLessThan(26)
  // The list row shows the title and the pane does not repeat it.
  expect(frame.split("Prefers short answers").length - 1).toBe(1)
  expect(frame).toContain("Recorded by settings (human)")
  view.mockInput.pressKey("a")
  expect(await screen("added inside a room")).toContain("added inside a room")
})

test("in a room the hint offers a add", async () => {
  const { view, screen, palette } = await dashboard({
    "GET /api/memory/wing": () => [personal],
    "GET /api/memory/room": () => [general],
    "GET /api/memory": () => [note],
  })
  await palette("Memories")
  await screen("Personal")
  view.mockInput.pressEnter()
  await screen("All rooms")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  expect(await screen("1 memory")).toContain("a add")
})

async function settingsAt(routes: Parameters<typeof dashboard>[0], steps: number) {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < steps; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  return app
}

test("agents list primary agents first and say the server default once", async () => {
  const agent = (id: string, mode: string) => ({
    id,
    mode,
    hidden: false,
    request: { headers: {}, body: {} },
    permissions: [],
  })
  const { screen } = await settingsAt(
    {
      "GET /api/agent": (_, url) => ({
        location: { directory: url.searchParams.get("location[directory]") },
        data: [
          agent("adversarial-review", "subagent"),
          agent("build", "primary"),
          agent("explore", "subagent"),
          agent("plan", "primary"),
        ],
      }),
      "GET /provider": () => ({ all: [], connected: [] }),
    },
    4,
  )
  const frame = await screen("explore · subagent")
  expect(frame.indexOf("build · primary")).toBeLessThan(frame.indexOf("plan · primary"))
  expect(frame.indexOf("plan · primary")).toBeLessThan(frame.indexOf("adversarial-review · subagent"))
  expect(frame).not.toContain("Server default model")
  expect(frame).toContain("Enter set model")
  expect(frame).toContain("Enter sets an agent's model")
})

test("usage names providers and fills the Refresh row", async () => {
  const { screen } = await settingsAt(
    {
      "GET /provider/usage": () => ({
        providers: [{ providerID: "sandbox", turns: 25, cost: 0, tokens: { input: 32000, output: 0, reasoning: 0 } }],
        quotas: [],
      }),
      "GET /provider": () => ({ all: [{ id: "sandbox", name: "Sandbox", models: {} }], connected: ["sandbox"] }),
    },
    1,
  )
  const frame = await screen("25 turns")
  expect(frame).toContain("Sandbox: 25 turns")
  expect(frame).not.toContain("sandbox: 25")
  expect(frame).toContain("Fetch usage and quotas again")
})

test("provider rows show names, and ids only when names collide", async () => {
  const { screen } = await settingsAt(
    {
      "GET /provider": () => ({
        all: [
          { id: "claude-code", name: "Claude Code", models: {} },
          { id: "twin-a", name: "Twin", models: {} },
          { id: "twin-b", name: "Twin", models: {} },
        ],
        connected: [],
      }),
    },
    0,
  )
  const frame = await screen("Claude Code")
  expect(frame).not.toContain("claude-code")
  expect(frame).toContain("not connected")
  expect(frame).toContain("twin-a · not connected")
})

test("the model picker and provider setup use one phrase for connecting a provider", async () => {
  const { view, screen } = await dashboard({
    "GET /provider": () => ({ all: [{ id: "claude-code", name: "Claude Code", models: {} }], connected: [] }),
  })
  await screen("main task")
  view.mockInput.pressKey("n")
  await screen("What would you like to do?")
  view.mockInput.pressKey("l", { ctrl: true })
  const picker = await screen("F2")
  expect(picker).toContain("+ Connect a provider  F2")
  expect(picker).not.toContain("add custom model")
  view.mockInput.pressKey("F2")
  const list = await screen("+ Add custom provider")
  expect(list).toContain("Connect a provider")
  expect(list).toContain("Claude Code")
  expect(list).not.toContain("claude-code")
})

test("server details cut each part on its own and drop an address that repeats the name", () => {
  const detail = "forge serve from /home/dad/.forge/bin/forge · stops when you quit"
  const fitted = fitDetail("Start a private server", detail, 40)
  expect(fitted.length).toBeLessThanOrEqual(40)
  expect(fitted).toEndWith(" · stops when you quit")
  expect(fitted).toContain("forge serve from …")
  expect(fitted).toContain("…")
  expect(fitDetail("127.0.0.1:35925", "http://127.0.0.1:35925", 60)).toBe("")
  expect(fitDetail("Persistent server", "turenos.service · /etc/turenos/attach.json", 60)).toBe(
    "turenos.service · /etc/turenos/attach.json",
  )
})

test("Servers opened from Settings is titled by its path, and its hints wrap between entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "turen-tui-readability-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const alpha = turen({ name: "alpha", password: "secret" })
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
  const servers = createServers({
    home,
    platform: "darwin",
    env: {},
    forge: "/opt/turenos-installs/current/bin/forge",
    config: join(home, "servers.json"),
  })
  await servers.add({ address: alpha.listener.url.origin.replace("127.0.0.1", "localhost"), name: "alpha" })
  const { view, screen } = await terminal(80, 24)
  const app = mountApp(view.renderer, servers, { initial: await servers.preferred(), onQuit: () => {} })
  cleanup.push(app.dispose)
  await screen("alpha says hello")
  view.mockInput.pressKey("p", { ctrl: true })
  await view.mockInput.typeText("Settings")
  view.mockInput.pressEnter()
  await screen("Usage and limits")
  for (let step = 0; step < 6; step++) view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  const frame = await screen("Settings › Servers")
  expect(frame).toContain("q quit")
  for (const line of lines(frame)) expect(line).not.toMatch(/ · q$/)
  // The command and the path are cut apart: the command stays whole and the note after them is not lost.
  const privateServer = lines(frame).find((line) => line.includes("Start a private server")) ?? ""
  expect(privateServer).toContain("forge serve from")
  expect(privateServer).toEndWith("· stops when you quit")
})

test("Intel rows end in an ellipsis, bare ids show their summary, markup is plain and dates are ISO", async () => {
  const feed = {
    id: "kev",
    name: "CISA KEV",
    kind: "kev",
    url: `https://www.cisa.gov/feeds/${"known_exploited_".repeat(5)}.json`,
    enabled: true,
  }
  const advisory = (id: string, title: string, summary: string) => ({
    id,
    title,
    severity: "critical",
    cvss: 10,
    publishedAt: Date.UTC(2026, 9, 7, 12),
    updatedAt: 1,
    source: "github",
    summary,
  })
  const { view, screen } = await dashboard({
    "GET /api/intel/advisories": () => ({
      items: [
        advisory(
          "GHSA-1",
          "vm2 contains a sandbox escape vulnerability in NodeVM",
          "Hardens `NodeVM` **even when the sandbox requests** builtin:['*'].",
        ),
        advisory("CVE-2026-33396", "CVE-2026-33396", "Parser overflow in the gateway."),
      ],
      total: 2,
      page: 1,
      pageSize: 50,
    }),
    "GET /api/intel/feeds": () => [feed],
  })
  view.mockInput.pressKey("I")
  const wide = await screen("Hardens NodeVM even when the sandbox requests")
  expect(wide).toContain("CRIT CVE-2026-33396 Parser")
  view.mockInput.pressKey("ESCAPE")
  view.resize(80, 24)
  view.mockInput.pressKey("I")
  const frame = await screen("Hardens NodeVM even when the sandbox requests")
  expect(frame).not.toContain("**")
  expect(frame).not.toContain("`")
  expect(frame).toContain("2026-10-07")
  expect(frame).not.toContain("10/7/2026")
  const rows = lines(frame).filter((line) => line.trimStart().startsWith("▶") || line.trimStart().startsWith("CRIT"))
  expect(rows.some((row) => row.includes("vm2 contains") && row.includes("…"))).toBe(true)
  view.mockInput.pressKey("f")
  const feeds = await screen("● CISA KEV · on")
  expect(feeds).toContain("known exploited list · https://")
  expect(feeds).toContain("…")
  expect(feeds).not.toContain("· kev")
})
