import { expect, test } from "bun:test"
import { dashboard } from "./support"

const models = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) => [
    `m${index}`,
    { id: `m${index}`, providerID: "test", name: `Model ${index}` },
  ]),
)
const routes = {
  "GET /global/permission-checks": () => ({ enforced: true }),
  "GET /provider": () => ({ all: [{ id: "test", name: "Test", models }], connected: ["test"], default: {} }),
}
// A pending request opens by itself, so each lives in its own route set.
const permission = {
  "GET /api/session/ses_main/permission": () => ({
    data: [
      {
        id: "per_one",
        sessionID: "ses_main",
        action: "bash",
        resources: ["echo marker && ls"],
        save: ["echo marker && ls"],
      },
    ],
  }),
}
const question = {
  "GET /api/session/ses_main/question": () => ({
    data: [
      {
        id: "que_one",
        sessionID: "ses_main",
        questions: [
          {
            header: "Toppings",
            question: "Which toppings?",
            multiple: true,
            options: ["Cheese", "Olives", "Basil"].map((label) => ({ label, description: `${label} on top` })),
          },
        ],
      },
    ],
  }),
}

/** Rows of the dialog frame titled `title` in a captured frame. */
function frameRows(frame: string, title: string) {
  const lines = frame.split("\n")
  const top = lines.findIndex((line) => line.includes(`╭─ ${title} `))
  const bottom = lines.findIndex((line, index) => index > top && line.includes("╰─"))
  return bottom - top + 1
}

async function opened(
  size: readonly [number, number],
  open: (app: Awaited<ReturnType<typeof dashboard>>) => unknown,
  extra = {},
) {
  const app = await dashboard({ ...routes, ...extra })
  app.view.resize(...size)
  await app.view.renderOnce()
  await open(app)
  return app
}

for (const size of [
  [80, 24],
  [60, 24],
] as const) {
  test(`Settings lists every item at ${size.join("x")}`, async () => {
    const app = await opened(size, (app) => app.view.mockInput.pressKey(","))
    const frame = await app.screen("Appearance")
    expect(frame).toContain("Permissions")
    expect(frame).toContain("Providers")
  })

  test(`the model picker shows several models above a compact header at ${size.join("x")}`, async () => {
    const app = await opened(size, (app) => app.view.mockInput.pressKey("m"))
    // Models are alphabetical by name, as in the desktop picker (Model 10 sorts before Model 2).
    const frame = await app.screen("Model 1")
    expect((frame.match(/Model \d+/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect(frame).toContain("Current:")
    expect(frame).not.toContain("ses_main")
  })

  test(`a permission shows Allow always and names what Ctrl+S does at ${size.join("x")}`, async () => {
    const app = await opened(size, () => {}, permission)
    const frame = await app.screen("3 Allow always")
    expect(frame).toContain("Allow always")
    expect(frame).toContain("Ctrl+S Reject")
    app.view.mockInput.pressArrow("down")
    await app.screen("Ctrl+S Allow once")
  })
}

test("a short dialog is as tall as its content on a tall terminal, and help fills the screen", async () => {
  const settings = await opened([160, 48], (app) => app.view.mockInput.pressKey(","))
  expect(frameRows(await settings.screen("Appearance"), "Settings")).toBeLessThan(26)
  settings.view.mockInput.pressEscape()
  const help = await opened([160, 48], (app) => app.view.mockInput.pressKey("?"))
  const frame = await help.screen("SESSION VIEWS")
  expect(frameRows(frame, "Keyboard shortcuts")).toBeGreaterThan(40)
  expect(frame).toContain("More below · PgUp/PgDn scroll")
})

test("help says where it continues and pages with PgDn", async () => {
  const app = await opened([80, 24], (app) => app.view.mockInput.pressKey("?"))
  await app.screen("More below")
  app.view.mockInput.pressKey("\x1b[6~")
  const frame = await app.screen("TERMINALS AND AUTOMATIONS")
  expect(frame).not.toContain("ESSENTIALS")
})

test("the palette is as tall as its matches", async () => {
  const app = await opened([160, 48], (app) => app.view.mockInput.pressKey("p", { ctrl: true }))
  await app.screen("Find a command")
  await app.view.mockInput.typeText("archive")
  await app.screen("1/4 ·")
  // The scroll box settles on the frame after the list changes.
  await app.view.renderOnce()
  expect(frameRows(app.view.captureCharFrame(), "Commands")).toBeLessThan(14)
})

test("a multi-select lists every option without a stray scroll thumb", async () => {
  const app = await opened([80, 24], () => {}, question)
  const frame = await app.screen("Basil")
  expect(frame).toContain("Olives")
  expect(frame).not.toContain("█")
  expect(frame).toContain("Cheese on top")
})
