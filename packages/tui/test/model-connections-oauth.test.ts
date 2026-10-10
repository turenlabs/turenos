import { expect, test } from "bun:test"
import { fixture, cleanup } from "./model-connections-fixture"

test("OAuth code flow preserves advertised method index, prompts, and originating directory", async () => {
  const app = await fixture({
    mode: "code",
    methods: [
      { type: "api", label: "Key" },
      { type: "oauth", label: "Browser" },
      {
        type: "oauth",
        label: "Headless",
        prompts: [
          {
            type: "select",
            key: "deployment",
            message: "Deployment",
            options: [{ label: "Private", value: "private" }],
          },
          { type: "text", key: "tenant", message: "Tenant", when: { key: "deployment", op: "eq", value: "private" } },
        ],
      },
    ],
  })
  await app.provider()
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  await app.screen("Deployment")
  app.view.mockInput.pressEnter()
  await app.screen("Tenant")
  await app.view.mockInput.typeText("fixture-tenant")
  app.view.mockInput.pressEnter()
  await app.screen("Complete OAuth")
  app.state.modal!.form.scrollTo(0)
  const frame = await app.screen("TEST-1234")
  expect(frame).toContain("https://auth.example.test/device")
  expect(frame).toContain("headless")
  await app.view.mockInput.pasteBracketedText("fixture-oauth-code")
  expect(app.input().value).toBe("*".repeat("fixture-oauth-code".length))
  app.view.mockInput.pressEnter()
  await app.screen("Model picker")
  expect(app.requests.filter((request) => request.method === "POST")).toEqual([
    {
      path: "/provider/test/oauth/authorize",
      method: "POST",
      directory: "/srv/original directory",
      body: { method: 2, inputs: { deployment: "private", tenant: "fixture-tenant" } },
    },
    {
      path: "/provider/test/oauth/callback",
      method: "POST",
      directory: "/srv/original directory",
      body: { method: 2, code: "fixture-oauth-code" },
    },
  ])
  expect(JSON.stringify(app.notices)).not.toContain("fixture-oauth-code")
})

test("Escape aborts waiting automatic OAuth immediately and ignores late completion", async () => {
  const pending = Promise.withResolvers<void>()
  cleanup.push(() => pending.resolve())
  const app = await fixture({ callback: pending.promise, methods: [{ type: "oauth", label: "Device login" }] })
  let signal: AbortSignal | undefined
  const complete = app.connection.providers.complete
  app.connection.providers.complete = (...args) => {
    signal = args[4]
    return complete(...args)
  }
  await app.provider()
  app.view.mockInput.pressEnter()
  await app.screen("Waiting for OAuth")
  expect(app.state.modal?.busy).toBe(false)
  expect(signal?.aborted).toBe(false)
  app.view.mockInput.pressEscape()
  expect(signal?.aborted).toBe(true)
  await app.screen("Model picker")
  pending.resolve()
  await Bun.sleep(30)
  await app.screen("Model picker")
  expect(app.returns()).toBe(1)
  expect(app.notices.some((notice) => notice.message.startsWith("Provider saved"))).toBe(false)
})

test("Escape aborts in-flight OAuth authorize call immediately", async () => {
  const pending = Promise.withResolvers<{ url: string; method: "auto" | "code"; instructions: string }>()
  cleanup.push(() => pending.resolve({ url: "https://login.example.test/auth", method: "auto", instructions: "Go" }))
  const app = await fixture({ methods: [{ type: "oauth", label: "Device login" }] })
  let signal: AbortSignal | undefined
  app.connection.providers.authorize = (...args) => {
    signal = args[4]
    return pending.promise
  }
  await app.provider()
  app.view.mockInput.pressEnter()
  await app.screen("Starting OAuth")
  expect(app.state.modal?.busy).toBe(false)
  expect(signal?.aborted).toBe(false)
  app.view.mockInput.pressEscape()
  expect(signal?.aborted).toBe(true)
  await app.screen("Model picker")
  pending.resolve({ url: "https://login.example.test/auth", method: "auto", instructions: "Go" })
  await Bun.sleep(30)
  expect(app.returns()).toBe(1)
})

for (const withKey of [false, true]) {
  test(`custom provider saves only config${withKey ? " and separate auth" : " without an API key"}`, async () => {
    const app = await fixture()
    if (withKey) app.view.resize(60, 24)
    app.open()
    await app.screen("Connect a provider")
    app.view.mockInput.pressEnter()
    await app.screen("Add OpenAI-compatible provider")
    for (const value of ["gateway", "My Gateway", "https://gateway.example.test/v1", "org/model:v1", "My Model"]) {
      await app.view.mockInput.pasteBracketedText(value)
      app.view.mockInput.pressTab()
    }
    if (withKey) await app.view.mockInput.pasteBracketedText("fixture-key-do-not-display")
    await app.view.renderOnce()
    expect(app.view.captureCharFrame()).toContain("Server-global")
    expect(app.view.captureCharFrame()).not.toContain("fixture-key")
    app.view.mockInput.pressEnter()
    await app.screen("Model picker")
    const writes = app.requests.filter((request) => request.method !== "GET")
    expect(writes.map((request) => request.path)).toEqual(
      withKey ? ["/global/config", "/auth/gateway"] : ["/global/config"],
    )
    expect(writes[0]?.body).toEqual({
      provider: {
        gateway: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Gateway",
          options: { baseURL: "https://gateway.example.test/v1" },
          models: { "org/model:v1": { name: "My Model" } },
        },
      },
    })
    expect(JSON.stringify(writes[0])).not.toContain("fixture-key")
    expect(app.returns()).toBe(1)
  })
}

for (const failConfig of [false, true]) {
  test(`custom ${failConfig ? "config failure never sends a key" : "auth failure reports saved configuration"} without displaying response secrets`, async () => {
    const app = await fixture({ failConfig, failAuth: !failConfig })
    app.open()
    await app.screen("Connect a provider")
    app.view.mockInput.pressEnter()
    await app.screen("Add OpenAI-compatible provider")
    for (const value of ["gateway", "My Gateway", "https://gateway.example.test/v1", "model", "My Model"]) {
      await app.view.mockInput.pasteBracketedText(value)
      app.view.mockInput.pressTab()
    }
    await app.view.mockInput.pasteBracketedText("fixture-key-do-not-display")
    app.view.mockInput.pressEnter()
    const frame = await app.screen(failConfig ? "could not be confirmed" : "configuration was saved")
    expect(frame).not.toContain("fixture-key")
    expect(app.requests.filter((request) => request.method === "PUT")).toHaveLength(failConfig ? 0 : 1)
    app.view.mockInput.pressEscape()
    await app.screen("Model picker")
    expect(app.notices.some((notice) => notice.message.startsWith("Provider saved"))).toBe(false)
  })
}

test("failed catalog refresh after save is not represented as key validation", async () => {
  const app = await fixture({ failCatalogAfterSave: true })
  await app.provider()
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  await app.view.mockInput.typeText("fixture-key")
  app.view.mockInput.pressEnter()
  await app.screen("Model picker")
  expect(app.notices.at(-1)).toEqual({
    message: "Provider saved; catalog refresh failed. The upstream key was not tested.",
    error: true,
  })
})

test("auth errors cannot expose secrets and metadata validation rejects unsafe fields before writes", async () => {
  const app = await fixture({ failAuth: true })
  await app.provider()
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  await app.view.mockInput.typeText("fixture-key-do-not-display")
  app.view.mockInput.pressEnter()
  const frame = await app.screen("could not be confirmed")
  expect(frame).not.toContain("fixture-key")
  expect(JSON.stringify(app.notices)).not.toContain("fixture-key")
  const count = app.requests.length
  for (const metadata of [
    Object.fromEntries([["__proto__", "value"]]),
    { account: "bad\nvalue" },
    { account: "x".repeat(4097) },
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, "value"])),
  ])
    await expect(app.connection.providers.connectKey("test", "fixture-key", metadata)).rejects.toThrow()
  expect(app.requests).toHaveLength(count)
})
