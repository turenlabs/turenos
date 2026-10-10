import { expect, test } from "bun:test"
import { fixture } from "./model-connections-fixture"

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
  expect(app.state.modal?.send).toBeUndefined()
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
  // A key copied with its line ending pastes as the key.
  await app.view.mockInput.pasteBracketedText("trailing-newline\r\n")
  expect(app.input().plainText).toBe("*".repeat("trailing-newline".length))
  app.view.mockInput.pressKey("u", { ctrl: true })
  await app.view.mockInput.pasteBracketedText("a".repeat(8192))
  expect(app.input().plainText).toBe("*".repeat(8192))
  app.view.mockInput.pressKey("x")
  expect(app.input().plainText).toBe("*".repeat(8192))
  const field = app.input()
  app.view.mockInput.pressEscape()
  await app.screen("Connect Test Provider")
  expect(field.isDestroyed).toBe(true)
  app.view.mockInput.pressEscape()
  await app.screen("Connect a provider")
  app.view.mockInput.pressEscape()
  await app.screen("Model picker")
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
