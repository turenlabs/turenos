import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { diffLines } from "../src/diff"
import { color } from "../src/theme"
import { dashboard, until } from "./support"

const advisory = (id: string, url?: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Advisory ${id}`,
  severity: "high",
  publishedAt: 1,
  updatedAt: 1,
  source: "github",
  summary: `Summary ${id}.`,
  url,
  ...extra,
})

test("intel links show as the URL parser reads them, or are withheld", async () => {
  const app = await dashboard({
    "GET /api/intel/advisories": () => ({
      items: [
        advisory("A1", "javascript:alert(1)"),
        advisory("A2", `https://exa${String.fromCharCode(0x2044)}mple.com/a`),
        advisory("A3", "https://example.com/advisory"),
        advisory("A4", "https://example.com/a b"),
      ],
      total: 4,
      page: 1,
      pageSize: 50,
    }),
  })
  app.view.mockInput.pressKey("I")
  const withheld = await app.screen("Summary A1.")
  expect(withheld).toContain("(link withheld)")
  expect(withheld).not.toContain("javascript:")
  app.view.mockInput.pressArrow("down")
  const lookalike = await app.screen("Summary A2.")
  expect(lookalike).not.toContain(String.fromCharCode(0x2044))
  expect(lookalike).toContain("https://xn--")
  app.view.mockInput.pressArrow("down")
  expect(await app.screen("Summary A3.")).toContain("https://example.com/advisory")
  app.view.mockInput.pressArrow("down")
  expect(await app.screen("Summary A4.")).toContain("(link withheld)")
})

test("intel paging stops at the last page and a failed page does not move the reader", async () => {
  const requested: number[] = []
  const app = await dashboard({
    "GET /api/intel/advisories": (_, url) => {
      const page = Number(url.searchParams.get("page"))
      requested.push(page)
      if (page === 2 && requested.filter((item) => item === 2).length === 1) return new Response(null, { status: 500 })
      return { items: [advisory(`P${page}`)], total: 120, page, pageSize: 50 }
    },
  })
  app.view.mockInput.pressKey("I")
  await app.screen("page 1 of 3")
  app.view.mockInput.pressKey("]")
  await app.screen("unavailable")
  app.view.mockInput.pressKey("r", { ctrl: true })
  await app.screen("page 1 of 3")
  expect(requested.at(-1)).toBe(1)
  for (let press = 0; press < 5; press++) {
    app.view.mockInput.pressKey("]")
    await Bun.sleep(40)
  }
  await app.screen("page 3 of 3")
  expect(Math.max(...requested)).toBe(3)
})

test("a feed toggle that finishes later leaves a dialog the user opened meanwhile alone", async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const feed = { id: "kev", name: "CISA KEV", kind: "kev", url: "https://cisa.gov/kev", enabled: true }
  const app = await dashboard({
    "GET /api/intel/advisories": () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
    "GET /api/intel/feeds": () => [feed],
    "PATCH /api/intel/feeds/kev": async () => {
      await gate
      return { ...feed, enabled: false }
    },
  })
  app.view.mockInput.pressKey("I")
  await app.screen("Intel › Advisories")
  app.view.mockInput.pressKey("f")
  await app.screen("CISA KEV")
  app.view.mockInput.pressEnter()
  await until(() => app.server.requests.some((item) => item.method === "PATCH"))
  app.view.mockInput.pressKey("n")
  await app.screen("What would you like to do?")
  await app.view.mockInput.typeText("keep this draft")
  await app.screen("keep this draft")
  release()
  await app.screen("CISA KEV turned off.").catch(() => undefined)
  await Bun.sleep(150)
  await app.view.renderOnce()
  const frame = app.view.captureCharFrame()
  expect(frame).toContain("keep this draft")
  expect(frame).not.toContain("Intel › Feeds")
})

test("a feed name cannot carry control sequences into the toggle note", async () => {
  const feed = { id: "kev", name: "Feed\x1b]0;x\x07", kind: "kev", url: "https://cisa.gov/kev", enabled: true }
  const app = await dashboard({
    "GET /api/intel/advisories": () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
    "GET /api/intel/feeds": () => [feed],
    "PATCH /api/intel/feeds/kev": () => ({ ...feed, enabled: false }),
  })
  app.view.mockInput.pressKey("I")
  await app.screen("Intel › Advisories")
  app.view.mockInput.pressKey("f")
  await app.screen("Feed]0;x")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("turned off.")
  expect(frame).not.toContain("\x1b")
})

function extension(id: string, name: string, enabled = false) {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name,
      description: `${name} description`,
      version: "1",
      publisher: "turen",
      trust: "verified",
      contributions: [],
    },
    origin: "catalog",
    mutable: true,
    enabled,
    status: enabled ? "connected" : "needs-auth",
    secretsSet: {},
    configurationSet: {},
  }
}

test("a second extension toggle waits for the first instead of painting a stale list", async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const app = await dashboard({
    "GET /extension": () => [extension("alpha", "Alpha"), extension("beta", "Beta")],
    "PATCH /extension/alpha": async () => {
      await gate
      return [extension("alpha", "Alpha", true), extension("beta", "Beta")]
    },
    "PATCH /extension/beta": () => [extension("alpha", "Alpha"), extension("beta", "Beta", true)],
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 2; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("○ Alpha")
  app.view.mockInput.pressEnter()
  await until(() => app.server.requests.some((item) => item.path === "/extension/alpha"))
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("Wait for the previous change to finish.")
  expect(app.server.requests.filter((item) => item.method === "PATCH")).toHaveLength(1)
  release()
  await app.screen("● Alpha")
})

test("an extension whose id would leave its route is dropped from the list", async () => {
  const app = await dashboard({
    "GET /extension": () => [extension("..", "Dots"), extension("turenlabs/good", "Good")],
  })
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 2; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("Good")
  expect(frame).not.toContain("Dots")
})

test("a swarm entry kind is shown as plain text and an inherited name gets no style", async () => {
  const entry = {
    id: "ent_1",
    roomID: "room_1",
    seq: 1,
    actor: { type: "human", memberID: "mem_1", name: "you" },
    kind: "constructor\x1b]0;x\x07",
    text: "hello room",
    baseRevision: 0,
    timeCreated: 1,
  }
  const app = await dashboard({
    "GET /api/session/ses_main/room": () => ({
      data: {
        room: {
          id: "room_1",
          rootSessionID: "ses_main",
          objective: "Ship it",
          budget: 1,
          explicitBudget: false,
          head: 1,
          status: "open",
          timeCreated: 1,
          timeUpdated: 1,
        },
        members: [],
        lanes: [],
      },
    }),
    "GET /api/session/ses_main/room/entries": () => ({ data: { entries: [entry], head: 1 } }),
  })
  await app.screen("main task")
  app.view.mockInput.pressEnter()
  // Opening the session puts the keyboard in the reply editor; Esc returns it to the shortcuts.
  await app.screen("Typing")
  app.view.mockInput.pressKey("ESCAPE")
  await until(() => !app.view.captureCharFrame().includes("Typing"))
  await app.view.mockInput.typeText("w")
  const frame = await app.screen("hello room")
  expect(frame).toContain("constructor]0;x")
  expect(frame).not.toContain("\x1b")
  const span = app.view
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((item) => item.text.includes("hello room"))
  expect(span?.fg).toEqual(RGBA.fromHex(color.text))
})

test("file paths the server sends for Changes are checked and a mention that cannot be written says so", async () => {
  const bell = String.fromCharCode(7)
  const file = (name: string) => ({ file: name, patch: `@@ -0,0 +1 @@\n+${name}`, additions: 1, deletions: 0 })
  const app = await dashboard({
    "GET /vcs/diff": () => [file("/etc/passwd"), file("../outside.ts"), file(`bad${bell}name.ts`), file('say "hi".ts')],
  })
  await app.screen("main task")
  app.view.mockInput.pressKey("d")
  const frame = await app.screen('say "hi".ts')
  expect(frame).not.toContain("passwd")
  expect(frame).not.toContain("outside.ts")
  expect(frame).not.toContain("bad")
  app.view.mockInput.pressKey("@")
  await app.screen("cannot be mentioned")
})

test("++x inside a hunk is an added line, while headers before the hunk stay muted", () => {
  const tones = diffLines({
    messageID: "msg_a",
    files: [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n+++x\n---y",
      },
    ],
  }).map((line) => [line.text, line.tone])
  expect(tones).toContainEqual(["--- a/a.ts", "meta"])
  expect(tones).toContainEqual(["+++ b/a.ts", "meta"])
  expect(tones).toContainEqual(["+++x", "added"])
  expect(tones).toContainEqual(["---y", "removed"])
})
