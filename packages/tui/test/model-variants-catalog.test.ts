import { expect, test } from "bun:test"
import { fixture } from "./model-variants-fixture"

test("catalog retains only bounded variant names, not bodies; absent metadata stays absent", async () => {
  const app = await fixture({
    variants: { low: { secret: "fixture-private" }, high: { disabled: true, config: "fixture-private" } },
  })
  const catalog = await app.connection.providers.list("/srv/project")
  expect(catalog.models[0]?.variants).toEqual(["low", "high"])
  expect(JSON.stringify(catalog)).not.toContain("fixture-private")
  expect(JSON.stringify(catalog)).not.toContain("disabled")
  const absent = await fixture({ absent: true })
  expect((await absent.connection.providers.list("/srv/project")).models[0]).toEqual({
    providerID: "test",
    id: "org/model",
    name: "Fixture model",
    providerName: "Test",
  })
  const bounded = await fixture({ variants: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`v${i}`, {}])) })
  expect((await bounded.connection.providers.list("/srv/project")).models[0]?.variants).toHaveLength(128)
})

for (const variants of [
  null,
  [],
  "high",
  { "": {} },
  { " high": {} },
  { "bad\u001b": {} },
  { "a\u202eb": {} },
  { constructor: {} },
  { ["a".repeat(513)]: {} },
  Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`v${i}`, {}])),
]) {
  test(`rejects invalid variant metadata ${JSON.stringify(variants).slice(0, 70)}`, async () => {
    const app = await fixture({ variants })
    await expect(app.connection.providers.list("/srv/project")).rejects.toThrow()
  })
}

test("captured identity and model survive selection changes; acknowledgement is verified with GET", async () => {
  const app = await fixture()
  app.state.inspected = app.state.snapshot!.sessions[0]
  app.variants.open()
  await app.ready()
  app.state.selected = "ses_elsewhere"
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.requests.map((request) => [request.method, request.path])).toEqual([
    ["GET", "/provider"],
    ["GET", "/api/session/ses_variant"],
    ["POST", "/api/session/ses_variant/model"],
    ["GET", "/api/session/ses_variant"],
  ])
  expect(app.requests[0]?.directory).toBe("/srv/project")
  expect(app.writes()[0]?.body).toEqual({ model: { providerID: "test", id: "org/model", variant: "low" } })
  expect(app.updates[0]?.model?.variant).toBe("low")
  expect(app.state.inspected?.model?.variant).toBe("low")
  expect(app.notices.at(-1)).toContain("Variant confirmed")
})

test("a definitely refused variant switch can be retried instead of freezing the choice", async () => {
  const app = await fixture()
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressArrow("up")
  app.remote.postStatus = 400
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("Rejected by the server"))
  app.remote.postStatus = 204
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(2)
  expect(app.notices.at(-1)).toContain("Variant confirmed")
})

test("Ctrl+S clears to Model default with no variant member; unchanged choice sends no POST", async () => {
  const app = await fixture()
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toEqual([])
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()[0]?.body).toEqual({ model: { providerID: "test", id: "org/model" } })
  expect(app.remote.session.model?.variant).toBeUndefined()
})

test("60x24 picker labels unadvertised current choice and launch choices are local", async () => {
  const app = await fixture({ width: 60, height: 24 })
  const choices: (string | undefined)[] = []
  let cancelled = 0
  const target = {
    directory: "/srv/project",
    model: { providerID: "test", id: "org/model" },
    current: "custom",
    choose: (variant: string | undefined) => {
      choices.push(variant)
    },
    cancel: () => {
      cancelled++
    },
  }
  app.variants.pick(target)
  const frame = await app.ready()
  expect(frame).toContain("Model default")
  expect(frame).toContain("custom")
  expect(frame).toContain("Ctrl+S select")
  expect(app.state.modal?.save).toBeUndefined()
  app.view.mockInput.pressArrow("up", { ctrl: true })
  app.view.mockInput.pressEnter({ shift: true })
  await app.view.renderOnce()
  expect(choices).toEqual([])
  expect(app.select().getSelectedIndex()).toBe(3)
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("no longer advertised"))
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(choices).toEqual(["high"])
  expect(app.requests.every((request) => request.method === "GET" && request.path === "/provider")).toBe(true)
  app.variants.pick(target)
  await app.ready()
  app.view.mockInput.pressEscape()
  expect(cancelled).toBe(1)
})
