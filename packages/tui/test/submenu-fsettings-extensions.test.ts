import { afterEach, expect, test } from "bun:test"
import { cleanup, dashboard } from "./support"

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

function extension(id: string, name: string, contribution: Record<string, unknown> = {}, enabled = false) {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name,
      description: `${name} description`,
      version: "1",
      publisher: "turen",
      trust: "verified",
      contributions: [{ type: "mcp", id, name: `${name} MCP`, description: "Tools", ...contribution }],
    },
    origin: "catalog",
    mutable: true,
    enabled,
    status: enabled ? "connected" : "needs-auth",
    secretsSet: {},
    configurationSet: {},
  }
}

const long = "Datadog Security and Incident Response"
const list = () => [
  extension("github", "GitHub", { secrets: [{ id: "token", label: "Token", required: true }] }),
  extension("plain", "Plain Skill"),
  extension("datadog", long, { authentication: "oauth" }),
]

async function fromSettings(routes: Parameters<typeof dashboard>[0]) {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < 2; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  return app
}

test("Extensions opened from Settings names its parent and shows whole names", async () => {
  const app = await fromSettings({ "GET /extension": list })
  const frame = await app.screen(long)
  expect(frame).toContain("Settings › Extensions")
})

test("the hint offers s, c and o only for what the selected extension has", async () => {
  const app = await fromSettings({ "GET /extension": list })
  await app.screen("GitHub")
  // Sorted by name: Datadog first (sign-in only), then GitHub (secrets), then Plain.
  let frame = await app.screen("o sign in")
  expect(frame).not.toContain("s secret")
  app.view.mockInput.pressArrow("down")
  frame = await app.screen("s secret")
  expect(frame).not.toContain("o sign in")
  app.view.mockInput.pressArrow("down")
  await app.screen("Plain Skill description")
  frame = app.view.captureCharFrame()
  expect(frame).not.toContain("s secret")
  expect(frame).not.toContain("o sign in")
  expect(frame).not.toContain("c setting")
})

test("/ filters the list, and Esc clears the filter before leaving", async () => {
  const app = await fromSettings({ "GET /extension": list })
  await app.screen("Plain Skill")
  app.view.mockInput.pressKey("/")
  await app.view.mockInput.typeText("plain")
  let frame = await app.screen("1 shown")
  expect(frame).not.toContain("GitHub description")
  app.view.mockInput.pressKey("ESCAPE")
  frame = await app.screen("GitHub")
  expect(frame).toContain("Settings › Extensions")
  expect(frame).not.toContain("Filter:")
  app.view.mockInput.pressKey("ESCAPE")
  await app.screen("Usage and limits")
})

test("saving a secret says so on the list it returns to, and turns the extension on", async () => {
  const app = await fromSettings({
    "GET /extension": list,
    "PATCH /extension/github": () => list().map((item) => ({ ...item, enabled: true })),
  })
  await app.screen("GitHub")
  app.view.mockInput.pressArrow("down")
  await app.screen("s secret")
  app.view.mockInput.pressKey("s")
  await app.screen("Token · required")
  app.view.mockInput.pressEnter()
  await app.view.mockInput.typeText("sekrit")
  app.view.mockInput.pressKey("s", { ctrl: true })
  const frame = await app.screen("saved")
  expect(frame).toContain("turned on")
})

test("o on an extension without sign-in does not turn it on", async () => {
  const app = await fromSettings({ "GET /extension": list })
  await app.screen("Plain Skill")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressArrow("down")
  await app.screen("Plain Skill description")
  app.view.mockInput.pressKey("o")
  await app.screen("no sign-in")
  expect(app.server.requests.some((item) => item.method === "PATCH")).toBe(false)
})
