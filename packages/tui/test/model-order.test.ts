import { expect, test } from "bun:test"
import { orderModels } from "../src/models/order"
import { assistant, dashboard, until } from "./support"

const model = (providerID: string, id: string, name: string, release_date?: unknown) => ({
  id,
  providerID,
  name,
  ...(release_date === undefined ? {} : { release_date }),
})

const catalog = {
  all: [
    {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-5": model("openai", "gpt-5", "GPT-5", "2025-08-07"),
        "gpt-6-luna": model("openai", "gpt-6-luna", "GPT-6 Luna", "2026-09-01"),
      },
    },
    {
      id: "claude-code",
      name: "Claude Code (local)",
      models: {
        "claude-opus-4": model("claude-code", "claude-opus-4", "Claude Opus 4", "2025-05-22"),
        "claude-opus-5-5": model("claude-code", "claude-opus-5-5", "Claude Opus 5.5", "2026-08-01"),
        "claude-sonnet-5-5": model("claude-code", "claude-sonnet-5-5", "Claude Sonnet 5.5", "2026-07-01"),
        "claude-fable-5-1": model("claude-code", "claude-fable-5-1", "Claude Fable 5.1", "2026-09-15"),
        fable: model("claude-code", "fable", "Claude Fable"),
        opus: model("claude-code", "opus", "Claude Opus"),
        odd: model("claude-code", "odd", "Claude Odd", "2026-13-45"),
      },
    },
  ],
  connected: ["openai", "claude-code"],
  default: { openai: "gpt-6-luna", "claude-code": "fable" },
}

const routes = (reply = true) => ({
  "GET /provider": () => catalog,
  "GET /api/session/ses_main/message": () => ({
    data: reply ? [assistant("main", "hi", { model: { providerID: "claude-code", id: "fable" } })] : [],
    cursor: {},
  }),
})

async function openPicker(reply: boolean) {
  const app = await dashboard(routes(reply))
  await app.screen("main task")
  app.view.mockInput.pressEnter()
  await app.screen("Typing")
  app.view.mockInput.pressEscape()
  await until(() => !app.view.captureCharFrame().includes("Typing"))
  app.view.mockInput.pressKey("m")
  return app
}

const at = (frame: string, text: string) => {
  const index = frame.indexOf(text)
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

test("the picker opens on the provider the session's replies ran on: aliases, then newest first, then the other provider", async () => {
  const app = await openPicker(true)
  const frame = await app.screen("Claude Fable 5.1")
  const order = ["fable ·", "opus ·", "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-4 "]
  const places = order.map((id) => at(frame, `claude-code/${id}`))
  expect(places).toEqual(places.toSorted((a, b) => a - b))
  expect(frame).toContain("Current: server default (last reply used claude-code/fable)")
  expect(frame).toContain("Claude Fable · default")
  expect(frame).toContain("claude-code/claude-fable-5-1 · 2026-09-15 · Claude Code")
  expect(frame).not.toContain("(Claude Code (local))")
})

test("without a session model or reply the server's first default provider leads, and a bad date keeps the model", async () => {
  const app = await openPicker(false)
  const frame = await app.screen("GPT-6 Luna")
  expect(frame).toContain("GPT-6 Luna · default")
  expect(at(frame, "GPT-6 Luna")).toBeLessThan(at(frame, "GPT-5"))
  expect(frame).toContain("Current: Server default")
  app.view.mockInput.pressEscape()
})

test("the second line aligns with the model name", async () => {
  const app = await openPicker(true)
  const lines = (await app.screen("Claude Fable ·")).split("\n")
  const name = lines.findIndex((line) => line.includes("Claude Fable ·"))
  expect(lines[name]?.indexOf("Claude Fable")).toBe(lines[name + 1]?.indexOf("claude-code/fable"))
})

test("the hint names the two-step Esc only while the search has text", async () => {
  const app = await openPicker(true)
  expect(await app.screen("Esc back")).not.toContain("Esc clear search")
  await app.view.mockInput.typeText("opus")
  expect(await app.screen("Esc clear search · Esc again back")).toContain("Claude Opus 5.5")
})

test("the New session form's model field uses the same order and rows", async () => {
  const app = await dashboard(routes(false))
  await app.screen("main task")
  app.view.mockInput.pressKey("n")
  await app.screen("What would you like to do?")
  app.view.mockInput.pressKey("l", { ctrl: true })
  const frame = await app.screen("GPT-6 Luna")
  expect(frame).toContain("GPT-6 Luna · default")
  expect(frame).toContain("openai/gpt-6-luna · 2026-09-01 · OpenAI")
})

test("orderModels tolerates a missing effective provider and malformed input order", () => {
  const rows = [
    { providerID: "a", id: "old", name: "Old", release: "2024-01-01" },
    { providerID: "b", id: "alias", name: "Alias" },
    { providerID: "a", id: "new", name: "New", release: "2025-01-01" },
    { providerID: "a", id: "tie", name: "Tie", release: "2025-01-01" },
  ]
  expect(orderModels(rows, {}, "").map((row) => row.id)).toEqual(["new", "tie", "old", "alias"])
  expect(orderModels(rows, {}, "b/alias").map((row) => row.id)).toEqual(["alias", "new", "tie", "old"])
  expect(orderModels(rows, { zzz: "x", b: "alias" }, "").map((row) => row.id)).toEqual(["alias", "new", "tie", "old"])
})
