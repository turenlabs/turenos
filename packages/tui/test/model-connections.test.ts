import { afterEach, expect, test } from "bun:test"
import { InputRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDialogs } from "../src/dialogs"
import { createLayout } from "../src/layout"
import { createModelConnections } from "../src/model-connections"
import { createProviders, type AuthMethod } from "../src/providers"
import { connect } from "../src/server"
import { createDashboardState } from "../src/state"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture(
  options: {
    methods?: AuthMethod[]
    authMissing?: boolean
    mode?: "auto" | "code"
    callback?: Promise<void>
    failConfig?: boolean
    failAuth?: boolean
    failCatalogAfterSave?: boolean
  } = {},
) {
  const requests: { path: string; method: string; directory: string | null; body?: unknown }[] = []
  let saved = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({
        path: url.pathname,
        method: request.method,
        directory: url.searchParams.get("directory"),
        body: request.method === "GET" ? undefined : await request.json(),
      })
      if (url.pathname === "/provider") {
        if (saved && options.failCatalogAfterSave) return new Response(null, { status: 503 })
        return Response.json({ all: [{ id: "test", name: "Test Provider", models: {} }], connected: [] })
      }
      if (url.pathname === "/provider/auth")
        return Response.json(
          options.authMissing ? {} : { test: options.methods ?? [{ type: "api", label: "Use API key" }] },
        )
      if (url.pathname === "/provider/test/oauth/authorize")
        return Response.json({
          url: "https://auth.example.test/device?state=fixture-state",
          instructions: "Use device code TEST-1234 in your browser.",
          method: options.mode ?? "auto",
        })
      if (url.pathname === "/provider/test/oauth/callback") {
        await options.callback
        saved = true
        return Response.json(true)
      }
      if (url.pathname.startsWith("/auth/")) {
        if (options.failAuth) return new Response("fixture-key-do-not-display", { status: 401 })
        saved = true
        return Response.json(true)
      }
      if (url.pathname === "/global/config") {
        if (request.method === "GET") return Response.json({})
        if (options.failConfig) return new Response("fixture-key-do-not-display", { status: 500 })
        saved = true
        return new Response("full config with fixture-key-do-not-display")
      }
      return new Response("Unexpected route", { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  const controller = new AbortController()
  const connection = Object.assign(connect({ url: server.url.href }), {
    address: server.url.origin,
    providers: createProviders({ url: server.url, headers: new Headers(), signal: controller.signal }),
  })
  cleanup.push(connection.close, () => controller.abort())
  const view = await createTestRenderer({ width: 100, height: 36, kittyKeyboard: true })
  cleanup.push(() => view.renderer.destroy())
  const state = createDashboardState()
  view.renderer.once("destroy", () => {
    state.closed = true
  })
  const ui = createLayout(view.renderer, state)
  const notices: { message: string; error?: boolean }[] = []
  const say = (message: string, error?: boolean) => {
    notices.push({ message, error })
  }
  let submissions = 0
  const dialogs = createDialogs(view.renderer, state, ui, {
    rememberPosition: () => {},
    cancelPosition: () => {},
    changed: () => {},
    submitted: async () => {
      submissions++
    },
    say,
  })
  view.renderer.keyInput.on("keypress", (key: KeyEvent) => dialogs.keypress(key))
  view.renderer.keyInput.on("paste", dialogs.paste)
  const connections = createModelConnections(view.renderer, state, connection, dialogs, say)
  let returns = 0
  const open = () =>
    connections.open("/srv/original directory", () => {
      returns++
      dialogs.open("Model picker")
    })
  async function screen(text: string) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await view.renderOnce()
      if (view.captureCharFrame().includes(text)) return view.captureCharFrame()
      await Bun.sleep(5)
    }
    throw new Error(`Missing ${text}:\n${view.captureCharFrame()}`)
  }
  async function provider() {
    open()
    await screen("Connect a provider")
    await view.mockInput.typeText("test")
    view.mockInput.pressEnter()
    await screen("Connect Test Provider")
  }
  function input(index = 0) {
    const field = state.modal?.fields.at(index)
    if (!(field instanceof InputRenderable)) throw new Error("Expected input")
    return field
  }
  return {
    view,
    state,
    dialogs,
    connection,
    requests,
    notices,
    open,
    screen,
    provider,
    input,
    returns: () => returns,
    submissions: () => submissions,
  }
}

test("providers without plugin auth hooks offer a generic API key connection", async () => {
  const app = await fixture({ authMissing: true })
  await app.provider()
  await app.screen("API key")
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  await app.view.mockInput.typeText("fixture-generic-key")
  app.view.mockInput.pressEnter()
  await app.screen("Model picker")
  expect(app.requests.filter((request) => request.method === "PUT")).toEqual([
    { path: "/auth/test", method: "PUT", directory: null, body: { type: "api", key: "fixture-generic-key" } },
  ])
})

test("search, key entry, and save keep native buffers masked and return to the originating picker", async () => {
  const app = await fixture()
  app.open()
  const frame = await app.screen("Connect a provider")
  expect(frame).toContain("Server-global")
  expect(frame).toContain(app.connection.address)
  await app.view.mockInput.typeText("nothing-matches")
  await app.screen("No matches")
  app.view.mockInput.pressArrow("down")
  app.view.mockInput.pressEnter()
  app.view.mockInput.pressKey("u", { ctrl: true })
  await app.view.mockInput.typeText("test")
  app.view.mockInput.pressEnter()
  await app.screen("Use API key")
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  expect(app.state.modal?.save).toBeUndefined()
  expect(app.state.modal?.submit).toBeUndefined()
  const field = app.input()
  const native: string[] = []
  const setText = field.setText.bind(field)
  field.setText = (text) => {
    native.push(text)
    setText(text)
  }
  await app.view.mockInput.typeText("fixture-key")
  await app.view.mockInput.pasteBracketedText("-paste")
  app.view.mockInput.pressBackspace()
  expect(field.value).toBe("*".repeat("fixture-key-past".length))
  field.setSelection(0, field.value.length)
  expect(field.getSelectedText()).toMatch(/^\*+$/)
  field.clearSelection()
  app.view.mockInput.pressKey("u", { ctrl: true })
  expect(field.plainText).toBe("")
  await app.view.mockInput.typeText("fixture-key-do-not-display")
  app.view.mockInput.pressKey("z", { ctrl: true })
  expect(field.plainText).toBe("*".repeat("fixture-key-do-not-display".length))
  await app.view.renderOnce()
  expect(app.view.captureCharFrame()).not.toContain("fixture-key")
  expect(native.every((value) => /^\**$/.test(value))).toBe(true)
  app.view.mockInput.pressEnter()
  app.view.mockInput.pressEnter()
  await app.screen("Model picker")
  expect(field.isDestroyed).toBe(true)
  expect(app.returns()).toBe(1)
  expect(app.submissions()).toBe(0)
  expect(app.requests.filter((request) => request.method !== "GET")).toEqual([
    { path: "/auth/test", method: "PUT", directory: null, body: { type: "api", key: "fixture-key-do-not-display" } },
  ])
  expect(
    app.requests
      .filter((request) => request.method === "GET")
      .every((request) => request.directory === "/srv/original directory"),
  ).toBe(true)
  expect(app.notices.at(-1)?.message).toContain("not an upstream key test")
  expect(JSON.stringify(app.notices)).not.toContain("fixture-key")
})

for (const [name, enter] of [
  ["keypad Enter", "\x1b[57414u"],
  ["linefeed", "\n"],
] as const) {
  test(`${name} works throughout provider selection and saving; extra modifiers never select or save`, async () => {
    const app = await fixture()
    app.open()
    await app.screen("Connect a provider")
    await app.view.mockInput.typeText("test")
    const provider = app.state.modal
    for (const modifier of ["ctrl", "shift", "meta", "super", "hyper"] as const) {
      app.view.mockInput.pressEnter({ [modifier]: true })
      expect(app.state.modal).toBe(provider)
    }
    expect(app.requests.some((request) => request.path === "/provider/auth")).toBe(false)
    await app.view.mockInput.pressKeys([enter])
    await app.screen("Use API key")
    // Focus the native selector as well, so modified Enter cannot bypass dialog.key.
    app.state.modal!.fields[0]!.focus()
    for (const modifier of ["ctrl", "shift", "meta", "super", "hyper"] as const)
      app.view.mockInput.pressEnter({ [modifier]: true })
    expect(app.state.modal?.frame.title).toContain("Connect Test Provider")
    await app.view.mockInput.pressKeys([enter])
    await app.screen("Save API key")
    await app.view.mockInput.typeText("fixture-key")
    for (const modifier of ["shift", "meta", "super", "hyper"] as const) {
      app.view.mockInput.pressKey("u", { ctrl: true, [modifier]: true })
      expect(app.input().value).toBe("*".repeat("fixture-key".length))
    }
    for (const modifier of ["ctrl", "shift", "meta", "super", "hyper"] as const)
      app.view.mockInput.pressEnter({ [modifier]: true })
    expect(app.requests.every((request) => request.method === "GET")).toBe(true)
    await app.view.mockInput.pressKeys([enter])
    await app.screen("Model picker")
    expect(app.requests.filter((request) => request.method === "PUT")).toEqual([
      { path: "/auth/test", method: "PUT", directory: null, body: { type: "api", key: "fixture-key" } },
    ])
  })
}

test("secret input rejects oversized and control-bearing pastes atomically and Escape leaves no draft", async () => {
  const app = await fixture()
  await app.provider()
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  await app.view.mockInput.typeText("keep")
  for (const text of ["x".repeat(8193), "x".repeat(32769), "bad\nvalue", "bad\u001b[31mvalue", "bad\u202evalue"]) {
    await app.view.mockInput.pasteBracketedText(text)
    expect(app.input().value).toBe("****")
    await app.screen(text.length > 32000 ? "Paste a shorter message" : "Input rejected")
  }
  app.view.mockInput.pressKey("u", { ctrl: true })
  await app.view.mockInput.pasteBracketedText("a".repeat(8192))
  expect(app.input().plainText).toBe("*".repeat(8192))
  app.view.mockInput.pressKey("x")
  expect(app.input().plainText).toBe("*".repeat(8192))
  const field = app.input()
  app.view.mockInput.pressEscape()
  await app.screen("Model picker")
  expect(field.isDestroyed).toBe(true)
  expect(app.requests.every((request) => request.method === "GET")).toBe(true)
  app.dialogs.close(false)
  await app.provider()
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  expect(app.input().value).toBe("")
})

test("API method prompts preserve conditional text/select answers in auth metadata", async () => {
  const app = await fixture({
    methods: [
      {
        type: "api",
        label: "Gateway key",
        prompts: [
          {
            type: "select",
            key: "deployment",
            message: "Deployment",
            options: [{ label: "Enterprise", value: "enterprise" }],
          },
          {
            type: "text",
            key: "skipped",
            message: "Must skip",
            when: { key: "deployment", op: "eq", value: "public" },
          },
          {
            type: "text",
            key: "missing",
            message: "Must also skip",
            when: { key: "absent", op: "neq", value: "public" },
          },
          {
            type: "text",
            key: "accountId",
            message: "Account ID",
            when: { key: "deployment", op: "eq", value: "enterprise" },
          },
          {
            type: "select",
            key: "region",
            message: "Region",
            when: { key: "deployment", op: "neq", value: "public" },
            options: [{ label: "Europe", value: "eu", hint: "EU gateway" }],
          },
        ],
      },
    ],
  })
  await app.provider()
  app.view.mockInput.pressEnter()
  await app.screen("Deployment")
  app.view.mockInput.pressEnter()
  await app.screen("Account ID")
  await app.view.mockInput.typeText("fixture-account")
  app.view.mockInput.pressEnter()
  await app.screen("EU gateway")
  app.view.mockInput.pressEnter()
  await app.screen("Save API key")
  await app.view.mockInput.typeText("fixture-key")
  app.view.mockInput.pressEnter()
  await app.screen("Model picker")
  expect(app.requests.find((request) => request.method === "PUT")?.body).toEqual({
    type: "api",
    key: "fixture-key",
    metadata: { deployment: "enterprise", accountId: "fixture-account", region: "eu" },
  })
  expect(JSON.stringify(app.notices)).not.toContain("fixture-account")
})

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
  const originalAuthorize = app.connection.providers.authorize
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
