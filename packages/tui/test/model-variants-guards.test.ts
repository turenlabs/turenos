import { expect, test } from "bun:test"
import { fixture } from "./model-variants-fixture"

for (const options of [{ missing: true }, { catalogStatus: 503 }]) {
  test(`unavailable catalog fails closed ${JSON.stringify(options)}`, async () => {
    const app = await fixture(options)
    app.variants.open()
    await app.waitFor((frame) => frame.includes("Cannot load variants"))
    app.view.mockInput.pressEnter()
    await app.waitFor(() => !app.state.modal?.busy)
    expect(app.writes()).toEqual([])
  })
}

for (const change of ["provider", "model", "workspace", "created", "lookup", "owned"]) {
  test(`preflight rejects changed ${change} without mutation`, async () => {
    const app = await fixture()
    app.variants.open()
    await app.ready()
    if (change === "provider")
      app.remote.session = { ...app.remote.session, model: { ...app.remote.session.model!, providerID: "other" } }
    if (change === "model")
      app.remote.session = { ...app.remote.session, model: { ...app.remote.session.model!, id: "other" } }
    if (change === "workspace")
      app.remote.session = { ...app.remote.session, location: { ...app.remote.session.location, workspaceID: "other" } }
    if (change === "created")
      app.remote.session = { ...app.remote.session, time: { ...app.remote.session.time, created: 3 } }
    if (change === "lookup") app.remote.lookupStatus = 404
    if (change === "owned") app.remote.owned = true
    app.view.mockInput.pressArrow("up")
    app.view.mockInput.pressEnter()
    await app.waitFor((frame) => frame.includes("Ctrl+S retry"))
    expect(app.writes()).toEqual([])
    expect(app.updates).toEqual([])
  })
}

for (const apply of [true, false]) {
  test(`ambiguous POST freezes choice and retries GET only (applied=${apply})`, async () => {
    const app = await fixture()
    app.remote.postStatus = 503
    app.remote.apply = apply
    app.variants.open()
    await app.ready()
    app.view.mockInput.pressArrow("up")
    app.view.mockInput.pressEnter()
    await app.waitFor((frame) => frame.includes("Choice frozen"))
    app.view.mockInput.pressArrow("up")
    app.view.mockInput.pressKey("s", { ctrl: true })
    if (apply) await app.waitFor(() => !app.state.modal)
    else await app.waitFor((frame) => frame.includes("Variant not confirmed"))
    expect(app.writes()).toHaveLength(1)
    expect(app.writes()[0]?.body).toEqual({ model: { providerID: "test", id: "org/model", variant: "low" } })
    expect(app.updates).toHaveLength(apply ? 1 : 0)
  })
}

test("failed post-acknowledgement GET does not announce success or resend", async () => {
  const app = await fixture()
  app.remote.verificationFails = true
  app.variants.open()
  await app.ready()
  app.view.mockInput.pressArrow("up")
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("Ctrl+S retry"))
  expect(app.updates).toEqual([])
  app.remote.lookupStatus = 0
  app.view.mockInput.pressKey("s", { ctrl: true })
  await app.waitFor(() => !app.state.modal)
  expect(app.writes()).toHaveLength(1)
  expect(app.updates[0]?.model?.variant).toBe("low")
})

test("known task ownership and unknown session model block opening without network work", async () => {
  const app = await fixture()
  app.remote.owned = true
  app.variants.open()
  expect(app.state.modal).toBeUndefined()
  expect(app.notices.at(-1)).toContain("Task-owned")
  app.remote.owned = false
  app.state.snapshot!.sessions = app.state.snapshot!.sessions.map((session) => ({ ...session, model: undefined }))
  app.variants.open()
  expect(app.notices.at(-1)).toContain("Press m")
  expect(app.requests).toEqual([])
})

test.each([false, true])("unadvertised current variant is retained only while unchanged (%s)", async (changed) => {
  const app = await fixture({ variants: { low: {} } })
  app.variants.open()
  await app.ready()
  expect(app.view.captureCharFrame()).toContain("current only")
  if (changed)
    app.remote.session = { ...app.remote.session, model: { providerID: "test", id: "org/model", variant: "low" } }
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => (changed ? frame.includes("no longer current") : !app.state.modal))
  expect(app.writes()).toHaveLength(0)
})

test("new draft cannot choose an unadvertised retained variant and can select default instead", async () => {
  const app = await fixture({ variants: { low: {} } })
  const chosen: (string | undefined)[] = []
  app.variants.pick({
    directory: "/srv/project",
    model: { providerID: "test", id: "org/model" },
    current: "high",
    choose: (variant) => {
      chosen.push(variant)
    },
  })
  await app.ready()
  app.view.mockInput.pressEnter()
  await app.waitFor((frame) => frame.includes("no longer advertised"))
  expect(chosen).toEqual([])
  app.select().setSelectedIndex(0)
  app.view.mockInput.pressEnter()
  await app.waitFor(() => !app.state.modal)
  expect(chosen).toEqual([undefined])
  expect(app.writes()).toHaveLength(0)
})
