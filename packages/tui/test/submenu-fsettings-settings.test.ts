import { expect, test } from "bun:test"
import { dashboard } from "./support"

const openai = { id: "openai", name: "OpenAI", models: { gpt: { id: "gpt", providerID: "openai", name: "GPT" } } }

/** Opens Settings with `,` and walks to a section by pressing Down `steps` times. */
async function settings(routes: Parameters<typeof dashboard>[0], steps: number) {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < steps; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  return app
}

test("sections name Settings as their parent in the title", async () => {
  const { screen } = await settings({ "GET /provider": () => ({ all: [openai], connected: ["openai"] }) }, 0)
  const frame = await screen("● OpenAI")
  expect(frame).toContain("Settings › Providers")
  expect(frame).toContain("Enter open")
})

test("a provider that stays connected after Disconnect is reported, not announced as disconnected", async () => {
  const { view, screen } = await settings(
    {
      "GET /provider": () => ({ all: [openai], connected: ["openai"] }),
      "DELETE /auth/openai": () => true,
      "POST /global/dispose": () => true,
    },
    0,
  )
  await screen("● OpenAI")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Disconnect")
  view.mockInput.pressEnter()
  await screen("Sessions using it fail until it is reconnected.")
  view.mockInput.pressKey("s", { ctrl: true })
  const frame = await screen("is still connected")
  expect(frame).not.toContain("OpenAI disconnected.")
})

test("a provider the server still lists as connected after Remove is reported", async () => {
  const { view, screen } = await settings(
    {
      "GET /provider": () => ({ all: [openai], connected: ["openai"] }),
      "DELETE /provider/openai": () => true,
      "POST /global/dispose": () => true,
    },
    0,
  )
  await screen("● OpenAI")
  view.mockInput.pressArrow("down")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Remove")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Its configuration is deleted from the server.")
  view.mockInput.pressKey("s", { ctrl: true })
  const frame = await screen("still lists OpenAI as connected")
  expect(frame).not.toContain("OpenAI removed.")
})

test("a failed Usage and limits load offers a Refresh row that asks again", async () => {
  let calls = 0
  const { server, view, screen } = await settings(
    {
      "GET /provider/usage": () => {
        calls++
        if (calls === 1) return new Response("{}", { status: 500 })
        return { start: 0, end: 1, providers: [], quotas: [] }
      },
    },
    1,
  )
  const failed = await screen("unavailable")
  expect(failed).toContain("Refresh")
  view.mockInput.pressEnter()
  await screen("No usage recorded.")
  expect(server.paths().filter((path) => path === "/provider/usage")).toHaveLength(2)
})

test("an agent's saved default shows in the list that follows", async () => {
  let model: string | undefined
  const { view, screen } = await settings(
    {
      "GET /provider": () => ({ all: [openai], connected: ["openai"] }),
      "GET /api/agent": (_, url) => ({
        location: { directory: url.searchParams.get("location[directory]") },
        data: [
          {
            id: "build",
            mode: "primary",
            hidden: false,
            request: { headers: {}, body: {} },
            permissions: [],
          },
        ],
      }),
      "PATCH /global/config": () => {
        model = "openai/gpt"
        return {}
      },
      // The v2 agent list omits a model saved in the config; the original route carries it.
      "GET /agent": () => [{ name: "build", ...(model ? { model: { providerID: "openai", modelID: "gpt" } } : {}) }],
    },
    4,
  )
  const defaultRow = /^\s*│\s+default\s+│/m
  expect(await screen("build · primary")).toMatch(defaultRow)
  view.mockInput.pressEnter()
  await screen("OpenAI · GPT")
  view.mockInput.pressEnter()
  await screen("Use GPT for build?")
  view.mockInput.pressKey("s", { ctrl: true })
  expect(await screen("openai/gpt")).not.toMatch(defaultRow)
})

test("turning permission checks on applies at once, and off still asks", async () => {
  let enforced = false
  const { server, view, screen } = await settings(
    {
      "GET /global/permission-checks": () => ({ enforced }),
      "PUT /global/permission-checks": () => {
        enforced = true
        return { enforced }
      },
      "GET /api/permission/saved": () => ({ data: [] }),
    },
    5,
  )
  await screen("Permission checks: off")
  view.mockInput.pressEnter()
  await screen("Permission checks on.")
  expect(server.requests.find((item) => item.method === "PUT")?.body).toEqual({ enforced: true })
  await screen("Permission checks: on")
})

test("Appearance rows say what Enter does", async () => {
  const { screen } = await settings({}, 7)
  expect(await screen("Settings › Appearance")).toContain("Enter toggle")
})
