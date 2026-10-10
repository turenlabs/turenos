import { expect, test } from "bun:test"
import { assistant, dashboard, session, until } from "./support"

const day = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * day).toISOString().slice(0, 10)

const model = (providerID: string, id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  providerID,
  name,
  ...extra,
})

// openai is listed first on purpose: the popular-provider order must put claude-code ahead of it.
const catalog = {
  all: [
    {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-5": model("openai", "gpt-5", "GPT-5", { family: "gpt", release_date: ago(30) }),
        "gpt-4": model("openai", "gpt-4", "GPT-4", { family: "gpt", release_date: ago(500) }),
      },
    },
    {
      id: "claude-code",
      name: "Claude Code (local)",
      models: {
        "claude-sonnet-5-5": model("claude-code", "claude-sonnet-5-5", "Claude Sonnet 5.5", {
          family: "sonnet",
          release_date: ago(40),
        }),
        "claude-opus-5-5": model("claude-code", "claude-opus-5-5", "Claude Opus 5.5", {
          family: "opus",
          release_date: ago(20),
        }),
        "claude-opus-4": model("claude-code", "claude-opus-4", "Claude Opus 4", {
          family: "opus",
          release_date: ago(400),
        }),
        "claude-sonnet-4": model("claude-code", "claude-sonnet-4", "Claude Sonnet 4", {
          family: "sonnet",
          release_date: ago(300),
        }),
        opus: model("claude-code", "opus", "Claude Opus (latest)"),
        "claude-3": model("claude-code", "claude-3", "Claude Three", {
          family: "claude",
          release_date: ago(10),
          status: "deprecated",
        }),
      },
    },
  ],
  connected: ["openai", "claude-code"],
  default: {},
}

const routes = (current?: string) => ({
  "GET /provider": () => catalog,
  "GET /api/session": () => ({
    data: [{ ...session(), ...(current ? { model: { providerID: "claude-code", id: current } } : {}) }],
    cursor: {},
  }),
  "GET /api/session/ses_main": () => ({
    data: { ...session(), ...(current ? { model: { providerID: "claude-code", id: current } } : {}) },
  }),
  "GET /api/session/ses_main/message": () => ({ data: [assistant("main", "hi")], cursor: {} }),
})

async function openPicker(current?: string) {
  const app = await dashboard(routes(current))
  await app.screen("main task")
  app.view.mockInput.pressEnter()
  await app.screen("Typing")
  app.view.mockInput.pressEscape()
  await until(() => !app.view.captureCharFrame().includes("Typing"))
  app.view.mockInput.pressKey("m")
  return app
}

async function openDraft() {
  const app = await dashboard(routes())
  await app.screen("main task")
  app.view.mockInput.pressKey("n")
  await app.screen("What would you like to do?")
  app.view.mockInput.pressKey("l", { ctrl: true })
  return app
}

/** Positions of each text in the frame; fails when one is missing. */
const places = (frame: string, texts: string[]) =>
  texts.map((text) => {
    const index = frame.indexOf(text)
    expect(index, `${text}\n${frame}`).toBeGreaterThanOrEqual(0)
    return index
  })

test("rows follow the popular-provider order, alphabetical inside a group, and older releases stay hidden", async () => {
  const app = await openPicker()
  const frame = await app.screen("Show all models")
  const order = ["claude-code/opus", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-5", "Show all models (3 hidden)"]
  const found = places(frame, order)
  expect(found).toEqual(found.toSorted((a, b) => a - b))
  for (const hidden of ["Claude Opus 4", "Claude Sonnet 4", "GPT-4", "Claude Three"]) expect(frame).not.toContain(hidden)
  expect(frame).toContain("claude-code/opus · latest · Claude Code (local)")
  expect(frame).toContain(`claude-code/claude-opus-5-5 · ${ago(20)}`)
  expect(frame).not.toContain("(latest)")
  expect(frame).not.toContain("· default")
})

test("Show all models lists the older releases, still never a deprecated one, and Show fewer hides them again", async () => {
  const app = await openPicker()
  await app.screen("Show all models")
  for (let i = 0; i < 5; i++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  const all = await app.screen("Show fewer models")
  for (const shown of ["Claude Opus 4", "Claude Sonnet 4", "GPT-4"]) expect(all).toContain(shown)
  expect(all).not.toContain("Claude Three")
  const order = ["claude-code/opus", "Claude Opus 4", "Claude Opus 5.5", "Claude Sonnet 4", "Claude Sonnet 5.5", "GPT-4"]
  const found = places(all, order)
  expect(found).toEqual(found.toSorted((a, b) => a - b))
})

test("the current model shows even when its release is old, and a hidden count leaves it out", async () => {
  const app = await openPicker("claude-opus-4")
  const frame = await app.screen("Show all models")
  expect(frame).toContain("* Claude Opus 4")
  expect(frame).toContain("Show all models (2 hidden)")
})

test("search uses the normalised match across name, id and provider", async () => {
  const app = await openPicker()
  await app.screen("Show all models")
  await app.view.mockInput.typeText("opus55")
  const frame = await app.screen("Esc clear search")
  expect(frame).toContain("Claude Opus 5.5")
  expect(frame).not.toContain("GPT-5")
  expect(frame).not.toContain("Claude Sonnet 5.5")
})

test("search reaches hidden releases through the toggle row", async () => {
  const app = await openPicker()
  await app.screen("Show all models")
  await app.view.mockInput.typeText("opus4")
  const frame = await app.screen("Show all models (1 hidden)")
  expect(frame).not.toContain("claude-code/claude-opus-4")
})

test("a chosen model leads the next open under Recent and leaves its provider group", async () => {
  const app = await openDraft()
  await app.screen("Show all models")
  for (let i = 0; i < 4; i++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await until(() => !app.view.captureCharFrame().includes("Choose model"))
  app.view.mockInput.pressKey("l", { ctrl: true })
  const frame = await app.screen("Recent · OpenAI")
  const found = places(frame, ["Server default", "GPT-5", "claude-code/opus"])
  expect(found).toEqual(found.toSorted((a, b) => a - b))
  expect(frame.split("GPT-5").length - 1).toBe(1)
  await app.view.mockInput.typeText("gpt")
  const searched = await app.screen("Esc clear search")
  expect(searched).not.toContain("Recent ·")
  expect(searched).toContain("GPT-5")
})
