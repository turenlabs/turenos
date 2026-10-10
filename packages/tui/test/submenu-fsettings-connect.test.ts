import { expect, test } from "bun:test"
import { dashboard, until } from "./support"

const routes = {
  "GET /provider": () => ({ all: [{ id: "test", name: "Test Provider", models: {} }], connected: [] }),
  "GET /provider/auth": () => ({ test: [{ type: "api", label: "Use API key" }] }),
  "PUT /auth/test": () => true,
}

async function connect() {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  app.view.mockInput.pressEnter()
  await app.screen("Connect a provider…")
  app.view.mockInput.pressEnter()
  await app.screen("Find a provider")
  return app
}

test("Esc steps back one level through provider setup", async () => {
  const app = await connect()
  expect(await app.screen("▶ + Add custom provider")).toContain("Connect a provider")
  await app.view.mockInput.typeText("test")
  app.view.mockInput.pressEnter()
  await app.screen("Connect Test Provider")
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  await app.view.mockInput.typeText("fixture-key")
  app.view.mockInput.pressEscape()
  await app.screen("Connect Test Provider")
  app.view.mockInput.pressEscape()
  await app.screen("Find a provider")
  app.view.mockInput.pressEscape()
  await app.screen("Connect a provider…")
})

test("the API key saves with Ctrl+S as well as Enter", async () => {
  const app = await connect()
  await app.view.mockInput.typeText("test")
  app.view.mockInput.pressEnter()
  await app.screen("Connect Test Provider")
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  await app.view.mockInput.typeText("fixture-key")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await until(() => app.server.sent("/auth/test").length === 1)
})

test("the custom provider form keeps typed text through Esc and clears a stale error on edit", async () => {
  const app = await connect()
  app.view.mockInput.pressEnter()
  await app.screen("Provider ID")
  await app.view.mockInput.typeText("my-gw")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.screen("Fill in all provider")
  await app.view.mockInput.typeText("2")
  expect(await app.screen("Tab fields")).not.toContain("Fill in all provider")
  app.view.mockInput.pressEscape()
  await app.screen("Find a provider")
  app.view.mockInput.pressEnter()
  await app.screen("my-gw2")
})
