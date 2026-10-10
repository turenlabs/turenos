import { expect, test } from "bun:test"
import { mountDashboard } from "../src/index"
import { connect } from "../src/server"
import { welcomeBody } from "../src/chrome"
import { replyHeading } from "../src/requests/reply-hint"
import { cleanup, session, terminal, turen, until, type Route } from "./support"
import { answer, message, mates, open as openTeam, task } from "./team-fixture"

// The owner's phone: 58 columns by 31 rows. Each test pins one finding from the round-two UX audit.
const running = { "GET /api/session/active": () => ({ data: { ses_main: { type: "running" } } }) }
const waiting = (requests: unknown[]) => ({
  "GET /api/session/ses_main/permission": () => ({ data: requests }),
  "POST /api/session/ses_main/permission/per_one/reply": () => new Response(null, { status: 204 }),
})
const request = { id: "per_one", sessionID: "ses_main", action: "shell", resources: ["npm test"] }

async function phone(routes: Record<string, Route>, height = 31, width = 58) {
  const server = turen({ routes })
  const { view, screen } = await terminal(width, height, true)
  const app = mountDashboard(view.renderer, connect({ url: server.url }), server.url)
  cleanup.push(app.dispose)
  await app.ready
  return { server, view, screen }
}

const footer = (frame: string) =>
  frame
    .split("\n")
    .filter((line) => line.trim())
    .at(-1)!

test("a permission panel keeps the footer, which names the mode before and after Esc", async () => {
  const { view, screen } = await phone({ ...running, ...waiting([request]) })
  const panel = await screen("2 Allow once")
  expect(footer(panel)).toContain("1/4 Sessions · Panel")
  expect(footer(panel)).toContain("Esc, then ? help")
  // The panel's own hint row names Esc even on a phone.
  expect(panel).toContain("Esc close")
  view.mockInput.pressEscape()
  expect(footer(await screen("Steer · permission waiting"))).toContain("Typing")
})

test("a question panel keeps the footer and names the key that selects", async () => {
  const questions = {
    "GET /api/session/ses_main/question": () => ({
      data: [
        {
          id: "que_1",
          sessionID: "ses_main",
          questions: [
            {
              header: "Colour",
              question: "Which colour?",
              custom: true,
              options: [
                { label: "Red", description: "A warm colour" },
                { label: "Blue", description: "A cool colour" },
              ],
            },
          ],
        },
      ],
    }),
  }
  const { screen } = await phone(questions)
  const panel = await screen("Which colour?")
  expect(footer(panel)).toContain("Panel")
  expect(panel).toContain("1-9 move · Enter select")
  expect(panel).toContain("Esc close")
})

test("a draft and a waiting permission keep the heading short and never join phrases with an ellipsis", async () => {
  const requests: unknown[] = []
  const { view, screen } = await phone({ ...running, ...waiting(requests) })
  await screen("Typing")
  await view.mockInput.typeText("half")
  requests.push(request)
  const frame = await screen("Steer · permission waiting")
  expect(frame).not.toContain("…c")
  expect(frame).not.toContain("...")
  expect(frame).toContain("Esc then Enter answers")
})

test("the welcome is short rows that fit 58 columns and name the tabs", () => {
  const body = welcomeBody("sessions", { connected: true, connectionError: "", columns: 58, serverSwitching: true })
  for (const line of body.split("\n")) expect(line.length).toBeLessThanOrEqual(54)
  expect(body).toContain("1-4 tabs · 4 Team")
})

test("shortcut mode names the tabs and the action row leads with the keys the state needs", async () => {
  const queued = [1, 2].map((seq) => ({
    admittedSeq: seq,
    id: `msg_${seq}`,
    sessionID: "ses_main",
    prompt: { text: "queued" },
    delivery: "queue",
    timeCreated: 1,
  }))
  const { view, screen } = await phone({ ...running, "GET /api/session/ses_main/input": () => ({ data: queued }) })
  view.mockInput.pressEscape()
  const frame = await screen("u 2 queued")
  const row = frame.split("\n").find((line) => line.includes("u 2 queued"))!
  expect(row.indexOf("x Stop")).toBeGreaterThanOrEqual(0)
  expect(row.indexOf("x Stop")).toBeLessThan(row.indexOf("u 2 queued"))
  expect(row).not.toContain("h History")
  expect(row).not.toContain("i Details")
  expect(footer(frame)).toContain("1/4 Sessions · 1-4 tabs")
})

test("the new-teammate form fits 58 columns on one row per label and short hint", async () => {
  const app = await openTeam({ ...(await import("./team-fixture")).world().routes }, 58, 31)
  await app.screen("Done")
  app.view.mockInput.pressKey("M", { shift: true })
  await app.screen("teammates in this room")
  app.view.mockInput.pressKey("a")
  const form = await app.screen("New teammate")
  expect(form).toContain("Tab next · Ctrl+S save · Esc cancel")
  expect(form).toContain("Handle (letters, digits, _ -)")
  expect(form).toContain("Model provider/model")
})

test("an unknown-handle warning waits while the @ list is open", async () => {
  const { server } = await import("./team-fixture").then((fixture) => ({ server: fixture.server() }))
  const { view, screen } = await openTeam(server.routes, 58, 31)
  await screen("Done")
  view.mockInput.pressKey("f")
  await screen("No mention:")
  await view.mockInput.typeText("hi @m")
  const frame = await screen("Tab complete")
  expect(frame).not.toContain("is not in this room")
  await view.mockInput.typeText("zz")
  await view.mockInput.typeText(" ")
  await screen("@mzz is not in this room")
})

test("the Team log shortens a long session ID instead of wrapping it", async () => {
  const id = "ses_0123456789abcdefghijklmnopqrstuv"
  const routes: Record<string, Route> = {
    "GET /api/team": () =>
      answer([message(1, "Welcome"), message(2, "Please review @moss")], {
        tasks: [task("succeeded", { sessionID: id })],
      }),
  }
  const { screen } = await openTeam(routes, 58, 31)
  const frame = await screen("→ @moss")
  expect(frame).not.toContain(id)
  const line = frame.split("\n").find((item) => item.includes("→ @moss"))!
  expect(line).toContain("…")
  expect(line.trim().length).toBeLessThan(58)
  expect(mates).toHaveLength(2)
})

test("a long directory in the permission panel keeps its last two folders", async () => {
  const deep = "/run/user/1000/turen-tui-sandbox/uxcalm/project"
  const main = { ...session("main"), location: { directory: deep } }
  const { screen } = await phone({ ...waiting([request]), "GET /api/session": () => ({ data: [main], cursor: {} }) })
  const frame = await screen("Directory:")
  expect(frame).toContain("Directory: …/uxcalm/project")
})

test("the session picker drops its spacer rows on a phone and words its hint plainly", async () => {
  const { view, screen } = await phone({})
  await screen("main says hello")
  view.mockInput.pressKey("k", { ctrl: true })
  const frame = await screen("Switch session")
  const lines = frame.split("\n")
  const search = lines.findIndex((line) => line.includes("Search title"))
  // No spacer rows between the field, the scope buttons and the list.
  expect(lines[search + 1]).toContain("[Recent]")
  expect(lines[search + 2]).toContain("+ New session")
  expect(frame).toContain("Type to filter")
  expect(frame).not.toContain("children")
})

test("a reply sent to a running turn confirms in the hint row, not on a row of its own", async () => {
  const { view, screen } = await phone({
    ...running,
    "POST /api/session/ses_main/prompt": async (input: Request) => ({
      data: { id: ((await input.json()) as { id: string }).id, sessionID: "ses_main" },
    }),
  })
  await screen("Typing")
  await view.mockInput.typeText("go on")
  view.mockInput.pressEnter()
  const frame = await screen("Reply sent.")
  const lines = frame.split("\n")
  const at = lines.findIndex((line) => line.includes("Reply sent."))
  // The hint row sits under the editor, inside its frame.
  expect(lines[at]).toContain("│")
  await until(() => !view.captureCharFrame().includes("Reply sent."))
})

test("p right after closing help still opens the waiting permission", async () => {
  const { view, screen } = await phone(waiting([request]))
  await screen("2 Allow once")
  view.mockInput.pressEscape()
  await screen("Typing")
  view.mockInput.pressEscape()
  await screen("1-4 tabs")
  await Bun.sleep(150)
  view.mockInput.pressKey("?")
  await screen("Keyboard shortcuts")
  view.mockInput.pressEscape()
  await Bun.sleep(150)
  view.mockInput.pressKey("p")
  const frame = await screen("2 Allow once")
  expect(frame).not.toContain("No pending permission")
})

test("the reply heading gives up whole parts for the room it has and never ends in a cut phrase", () => {
  const facts = {
    live: true,
    queue: true,
    waiting: undefined,
    review: false,
    revert: false,
    queued: 1,
    draft: false,
    listed: false,
  }
  expect(replyHeading(facts)).toBe("Queue · sent when the agent is idle · Ctrl+T steer · 1 queued")
  expect(replyHeading(facts, 40)).toBe("Queue · sent when idle · 1 queued")
  expect(replyHeading(facts, 20)).toBe("Queue")
  expect(replyHeading({ ...facts, queue: false, queued: 0 }, 20)).toBe("Steer")
  for (const room of [58, 40, 30, 20]) expect(replyHeading(facts, room)).not.toContain("…")
})
