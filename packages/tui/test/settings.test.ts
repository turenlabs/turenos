import { expect, test } from "bun:test"
import { dashboard } from "./support"

const catalog = {
  all: [{ id: "openai", name: "OpenAI", models: { gpt: { id: "gpt", providerID: "openai", name: "GPT" } } }],
  connected: ["openai"],
}

/** Opens Settings with `,` and walks to a section by pressing Down `steps` times. */
async function settings(routes: Parameters<typeof dashboard>[0], steps: number) {
  const app = await dashboard(routes)
  app.view.mockInput.pressKey(",")
  await app.screen("Usage and limits")
  for (let step = 0; step < steps; step++) app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  return app
}

test("disconnecting a provider deletes its credential, then retires cached clients", async () => {
  let connected = ["openai"]
  const { server, view, screen } = await settings(
    {
      "GET /provider": () => ({ ...catalog, connected }),
      "DELETE /auth/openai": () => {
        connected = []
        return true
      },
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
  await screen("OpenAI disconnected.")
  expect(server.paths().filter((path) => ["/auth/openai", "/global/dispose"].includes(path))).toEqual([
    "/auth/openai",
    "/global/dispose",
  ])
})

test("usage shows the last seven days and plan quota windows", async () => {
  const { screen } = await settings(
    {
      "GET /provider/usage": () => ({
        start: 0,
        end: 1,
        providers: [
          {
            providerID: "openai",
            turns: 4,
            cost: 1.5,
            // Cached prompt tokens count toward the total, as on the desktop usage page.
            tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 9000, write: 0 } },
          },
        ],
        quotas: [
          {
            providerID: "openai",
            status: "available",
            source: "provider",
            plan: "Plus",
            windows: [{ label: "5 hours", usedPercent: 42 }],
          },
        ],
      }),
    },
    1,
  )
  expect(await screen("openai: 4 turns · 11k tokens · $1.50")).toContain("5 hours: 42% used")
})

test("an agent's default model is saved to the global config", async () => {
  const { server, view, screen } = await settings(
    {
      "GET /provider": () => catalog,
      "GET /api/agent": (_, url) => ({
        location: { directory: url.searchParams.get("location[directory]") },
        data: [{ id: "build", mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [] }],
      }),
      "PATCH /global/config": () => ({}),
    },
    4,
  )
  await screen("build · primary")
  view.mockInput.pressEnter()
  await screen("OpenAI · GPT")
  view.mockInput.pressEnter()
  await screen("Use GPT for build?")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("build now defaults to GPT.")
  expect(server.requests.find((item) => item.method === "PATCH")?.body).toEqual({
    agent: { build: { model: "openai/gpt" } },
  })
})

test("permission checks toggle, and saved rules can be removed", async () => {
  const { server, view, screen } = await settings(
    {
      "GET /global/permission-checks": () => ({ enforced: true }),
      "PUT /global/permission-checks": () => ({ enforced: false }),
      "GET /api/permission/saved": () => ({
        data: [{ id: "psv_1", projectID: "p", action: "bash", resource: "npm *" }],
      }),
      "DELETE /api/permission/saved/psv_1": () => new Response(null, { status: 204 }),
    },
    5,
  )
  await screen("Permission checks: on")
  view.mockInput.pressEnter()
  await screen("will run tools without asking")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Permission checks off.")
  expect(server.requests.find((item) => item.method === "PUT")?.body).toEqual({ enforced: false })
  // Confirming returns to the Permissions section, now listing the saved rule.
  await screen("bash · npm *")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  await screen("Remove this saved rule?")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("Saved rule removed.")
  expect(server.sent("/api/permission/saved/psv_1")[0]?.method).toBe("DELETE")
})

test("extensions turn on and take secrets without showing them", async () => {
  const item = (enabled: boolean) => ({
    manifest: {
      schemaVersion: 1,
      id: "github",
      name: "GitHub",
      description: "Issues and pull requests",
      version: "1",
      publisher: "turen",
      trust: "verified",
      contributions: [
        {
          type: "mcp",
          id: "github",
          name: "GitHub MCP",
          description: "Repository tools",
          secrets: [{ id: "token", label: "Token", required: true }],
          authentication: "key",
        },
      ],
    },
    origin: "catalog",
    mutable: true,
    enabled,
    status: enabled ? "connected" : "needs-auth",
    secretsSet: { token: enabled },
    configurationSet: {},
  })
  let enabled = false
  const { server, view, screen, palette } = await dashboard({
    "GET /extension": () => [item(enabled)],
    "PATCH /extension/github": () => {
      enabled = true
      return [item(true)]
    },
  })
  await palette("Extensions")
  await screen("Needs: Token (s)")
  view.mockInput.pressEnter()
  await screen("Turned on.")
  expect(server.requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ enabled: true })
  view.mockInput.pressKey("s")
  await screen("Token · required")
  view.mockInput.pressEnter()
  await view.mockInput.typeText("sekrit")
  expect(view.captureCharFrame()).not.toContain("sekrit")
  view.mockInput.pressKey("s", { ctrl: true })
  await screen("GitHub · enabled, connected")
  expect(server.requests.filter((request) => request.method === "PATCH")[1]?.body).toMatchObject({
    enabled: true,
    secrets: { token: "sekrit" },
  })
})

test("Intel lists advisories, switches to known-exploited CVEs, and toggles feeds", async () => {
  const feed = { id: "kev", name: "CISA KEV", kind: "kev", url: "https://cisa.gov/kev", enabled: true }
  const { server, view, screen } = await dashboard({
    "GET /api/intel/advisories": () => ({
      items: [
        {
          id: "GHSA-1",
          title: "Parser overflow",
          severity: "critical",
          cvss: 9.8,
          publishedAt: 1,
          updatedAt: 1,
          source: "github",
          summary: "Heap overflow in the parser.",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    }),
    "GET /api/intel/kev": () => ({
      items: [{ cveID: "CVE-2026-1", vendor: "Acme", product: "Gateway", name: "Auth bypass", dateAdded: 1 }],
      total: 1,
      page: 1,
      pageSize: 50,
    }),
    "GET /api/intel/feeds": () => [feed],
    "PATCH /api/intel/feeds/kev": () => {
      feed.enabled = false
      return feed
    },
  })
  view.mockInput.pressKey("I")
  expect(await screen("Heap overflow in the parser.")).toContain("CRIT Parser overflow")
  view.mockInput.pressKey("m")
  await screen("CVE-2026-1 Auth bypass")
  view.mockInput.pressKey("f")
  await screen("● CISA KEV · on")
  view.mockInput.pressEnter()
  await screen("○ CISA KEV · off")
  expect(server.requests.find((item) => item.method === "PATCH")?.body).toEqual({ enabled: false })
})

test("memories are browsed by wing and room, and added with a kind and title", async () => {
  const memory = {
    id: "drw_1",
    wingID: "wng_1",
    roomID: "rom_1",
    kind: "decision",
    title: "Use pinned bun",
    body: "Global bun is too old.",
    anchor: {},
    provenance: { assertedBy: "build", source: "agent" },
    timeValidFrom: 1,
    timeCreated: 1,
    timeUpdated: 5,
  }
  const { server, view, screen, palette, confirm } = await dashboard({
    "GET /api/memory/wing": () => [
      { id: "wng_1", kind: "project", key: "turen", name: "turen", timeCreated: 1, timeUpdated: 1 },
    ],
    "GET /api/memory/room": () => [
      { id: "rom_1", wingID: "wng_1", slug: "tooling", name: "Tooling", timeCreated: 1, timeUpdated: 1 },
    ],
    "GET /api/memory": () => [memory],
    "POST /api/memory": () => ({ ...memory, id: "drw_2" }),
  })
  await palette("Memories")
  await screen("project · turen")
  view.mockInput.pressEnter()
  await screen("All rooms")
  view.mockInput.pressArrow("down")
  view.mockInput.pressEnter()
  expect(await screen("Global bun is too old.")).toContain("[decision] Use pinned bun")
  view.mockInput.pressKey("a")
  await screen("New memory")
  await view.mockInput.typeText("Run tests alone")
  view.mockInput.pressTab()
  await confirm("The suite flakes when run in parallel.")
  // Saving returns to the room.
  await screen("Memories › turen › Tooling")
  expect(server.requests.find((item) => item.method === "POST")?.body).toMatchObject({
    wingID: "wng_1",
    roomID: "rom_1",
    kind: "note",
    title: "Run tests alone",
    body: "The suite flakes when run in parallel.",
  })
})
