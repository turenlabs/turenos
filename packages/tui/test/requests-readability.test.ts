import { expect, test } from "bun:test"
import { dashboard, type Route } from "./support"

const location = { directory: "/srv/main", project: { id: "project", directory: "/srv/main" } }
const commands = (names: string[]) => ({
  "GET /api/command": () => ({
    location,
    data: names.map((name) => ({ name, description: `Server ${name}`, template: "x", subtask: false })),
  }),
})
const permission = (save: string[], resources = ["make"]): Record<string, Route> => ({
  "GET /api/session/ses_main/permission": () => ({
    data: [{ id: "per_1", sessionID: "ses_main", action: "bash", resources, save }],
  }),
})
const question = (extra: Record<string, unknown> = {}): Record<string, Route> => ({
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
            ...extra,
          },
        ],
      },
    ],
  }),
})
const lines = (frame: string) => frame.split("\n").map((line) => line.replace(/^\s*│\s?/, "").trimEnd())
const count = (frame: string, text: string) => lines(frame).filter((line) => line.includes(text)).length

// Permission request

test("a permission names the session and folder on their own rows and lists the command once", async () => {
  const { screen } = await dashboard(permission(["make"]))
  const frame = await screen("Permission request")
  expect(frame).toContain("For: main task")
  expect(frame).toContain("Directory: /srv/main")
  expect(frame).not.toContain("main task · /srv/main")
  expect(count(frame, "make")).toBe(1)
  expect(frame).toContain("3 Allow always · saves the command above")
  expect(frame).not.toContain("Allow always saves 1 rule")
  expect(frame).not.toContain("Do not allow this operation")
  expect(frame).toContain("2 Allow once · this request only")
})

test("a permission whose saved rules differ from the command lists every rule once", async () => {
  const { screen } = await dashboard(permission(["make *", "make test"]))
  const frame = await screen("Permission request")
  expect(frame).toContain("Allow always saves 2 rules:")
  expect(frame).toContain("• make *")
  expect(frame).toContain("• make test")
  expect(frame).toContain("3 Allow always · saves the 2 rules above")
})

test("permission hints drop whole entries at 60x24 and the transcript stays visible", async () => {
  const { view, screen } = await dashboard(permission(["make"]))
  view.resize(60, 24)
  await screen("3 Allow always")
  const frame = await screen("Esc close")
  expect(frame).toContain("PgUp/PgDn scroll")
  expect(frame).toContain("main says hello")
})

// Questions

test("a question shows each option's description under it, and a single choice does not use checkboxes", async () => {
  const { screen } = await dashboard(question())
  const frame = await screen("Which colour?")
  const rows = lines(frame)
  const red = rows.findIndex((line) => line.includes("( ) Red"))
  expect(red).toBeGreaterThan(-1)
  expect(rows[red + 1]).toMatch(/^\s+A warm colour/)
  expect(frame).not.toContain("[ ] Red")
  expect(count(frame, "A warm colour")).toBe(1)
})

test("a multiple-choice question keeps checkboxes", async () => {
  const { screen } = await dashboard(question({ multiple: true }))
  expect(await screen("Which colour?")).toContain("[ ] Red")
})

test("the custom answer box does not repeat its label as a placeholder", async () => {
  const { view, screen } = await dashboard(question())
  await screen("Which colour?")
  view.mockInput.pressKey("3")
  view.mockInput.pressEnter()
  const frame = await screen("save custom answer")
  expect(frame).toContain("Your answer")
  // The empty field is boxed and its placeholder differs from the label, so neither reads as typed text.
  expect(frame).toContain("[ Type your answer")
})

// Slash list

test("the slash list leads with the client's commands and counts its rows", async () => {
  const { view, screen } = await dashboard(commands(["init", "review", "customize-forge", "zeta"]))
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/")
  const frame = await screen("▶ /help")
  expect(frame).not.toContain("▶ /init")
  expect(frame).toMatch(/\d+ of \d+/)
  expect(frame).not.toMatch(/\b1\/\d+\b/)
})

test("a complete command typed before the list has loaded runs on one Enter", async () => {
  const gate = Promise.withResolvers<void>()
  const { view, screen } = await dashboard({
    "GET /api/command": async () => {
      await gate.promise
      return { location, data: [] }
    },
  })
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/tools")
  await screen("Loading commands")
  view.mockInput.pressEnter()
  gate.resolve()
  await screen("─ Tools ─")
})

// @ mentions

test("a one-character file query asks for more instead of reporting a failure", async () => {
  const { server, view, screen } = await dashboard({})
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("@a")
  const frame = await screen("Type 2 or more characters to search files")
  expect(frame).not.toContain("File search unavailable")
  expect(server.paths().filter((path) => path.includes("find"))).toEqual([])
})

// Queued messages

const queued = (id: string, text: string, seq: number, created: number) => ({
  admittedSeq: seq,
  id,
  sessionID: "ses_main",
  prompt: { text },
  delivery: "queue",
  timeCreated: created,
})

test("queued messages show a short message once, a 24-hour stamp and a hint that breaks between keys", async () => {
  const created = new Date(2026, 9, 7, 19, 59).getTime()
  const { view, screen } = await dashboard({
    "GET /api/session/ses_main/input": () => ({
      data: [queued("msg_1", "first short", 1, created), queued("msg_2", "second\nwith two lines", 2, created)],
    }),
  })
  view.mockInput.pressKey("u")
  const frame = await screen("Ctrl+R refresh")
  expect(count(frame, "first short")).toBe(1)
  expect(frame).toContain("2026-10-07 19:59")
  expect(frame).not.toMatch(/[AP]M\b/)
  expect(lines(frame).find((line) => line.includes("Ctrl+R refresh"))).toMatch(/^Ctrl\+R refresh · Esc close/)
})

// Rewind, compact, kill

const message = (id: string, text: string, created: number) => ({ id, type: "user", text, time: { created } })
const history = {
  "GET /api/session/ses_main/message": () => ({
    data: [message("msg_a", "Latest real prompt", 2), message("msg_b", "First prompt", 1)],
    cursor: {},
  }),
}

test("undo puts file consequences by the file-mode choice and shows a visible confirmation field", async () => {
  const { view, screen, palette } = await dashboard(history)
  await screen("main task")
  await palette("Undo conversation turn")
  const frame = await screen("Confirmation (type undo)")
  const rows = lines(frame)
  expect(rows.findIndex((line) => line.includes("File mode"))).toBeGreaterThan(-1)
  expect(frame).toContain("Conversation + files · restores affected files now")
  expect(frame).not.toContain("File mode restores affected files NOW")
  expect(frame).toContain("For: main task")
  expect(frame).toContain("Session: ses_main")
  expect(frame).toContain("Directory: /srv/main")
  expect(frame).not.toContain("»")
  // The empty field is boxed and shows no placeholder that could read as the typed word.
  expect(rows[rows.findIndex((line) => line.includes("Confirmation (type undo)")) + 1]).toMatch(/^\[ +\]/)
  view.mockInput.pressTab()
  await view.renderOnce()
  expect(count(view.captureCharFrame(), "▶ File mode")).toBe(1)
})

test("a rewound prompt picked from /rewind is titled rewind", async () => {
  const { view, screen } = await dashboard({ ...history, ...commands([]) })
  await screen("main task")
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/rewind")
  await screen("/rewind")
  view.mockInput.pressEnter()
  await screen("▶ Latest real prompt")
  view.mockInput.pressArrow("down")
  await screen("▶ First prompt")
  view.mockInput.pressEnter()
  const frame = await screen("Confirmation (type rewind)")
  expect(frame).toContain("Rewind conversation?")
  expect(frame).not.toContain("Undo conversation?")
})

test("compact labels its session and directory rows like the other confirmations", async () => {
  const { view, screen } = await dashboard(commands([]))
  await screen("main task")
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/compact")
  await screen("/compact")
  view.mockInput.pressEnter()
  const frame = await screen("Compact session?")
  expect(frame).toContain("Session: ses_main")
  expect(frame).toContain("Directory: /srv/main")
})

test("kill asks for its word once", async () => {
  const { view, screen } = await dashboard(commands([]))
  await screen("main task")
  view.mockInput.pressKey("f")
  await screen("Typing")
  await view.mockInput.typeText("/kill")
  await screen("/kill")
  view.mockInput.pressEnter()
  const frame = await screen("Confirmation (type kill)")
  expect(frame).toContain("Session: ses_main")
  expect(frame).toContain("Directory: /srv/main")
  expect(frame).not.toContain("Type kill, then Ctrl+S to confirm.")
})
