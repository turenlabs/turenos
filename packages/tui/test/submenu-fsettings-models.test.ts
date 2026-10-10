import { expect, test } from "bun:test"
import { assistant, dashboard, session, until } from "./support"

const catalog = {
  all: [
    {
      id: "test",
      name: "Test Provider",
      models: {
        "org/model": { id: "org/model", providerID: "test", name: "Catalog Model" },
        "org/other": { id: "org/other", providerID: "test", name: "Other Model" },
      },
    },
  ],
  connected: ["test"],
  default: {},
}

const withModel = (id: string) => ({
  "GET /provider": () => catalog,
  "GET /api/session": () => ({ data: [{ ...session(), model: { providerID: "test", id } }], cursor: {} }),
  "GET /api/session/ses_main": () => ({ data: { ...session(), model: { providerID: "test", id } } }),
})

async function open(routes: Parameters<typeof dashboard>[0]) {
  const app = await dashboard(routes)
  await app.screen("main task")
  app.view.mockInput.pressEnter()
  // Opening a session opens its reply editor; Esc leaves it so `m` is the model shortcut.
  await app.screen("Typing")
  app.view.mockInput.pressEscape()
  await until(() => !app.view.captureCharFrame().includes("Typing"))
  return app
}

test("the model picker starts on the session's current model", async () => {
  const app = await open(withModel("org/other"))
  app.view.mockInput.pressKey("m")
  expect(await app.screen("▶ * Other Model")).toContain("Choose model")
})

test("Esc in the model picker clears the filter first, then closes", async () => {
  const app = await open(withModel("org/model"))
  app.view.mockInput.pressKey("m")
  await app.screen("Catalog Model")
  await app.view.mockInput.typeText("zzz")
  await app.screen("No matching models")
  app.view.mockInput.pressEscape()
  await app.screen("Other Model")
  expect(await app.screen("Choose model")).not.toContain("zzz")
  app.view.mockInput.pressEscape()
  await Bun.sleep(50)
  await app.view.renderOnce()
  expect(app.view.captureCharFrame()).not.toContain("Choose model")
})

test("/effort uses the model of the latest reply when the session has none", async () => {
  const app = await open({
    "GET /provider": () => ({
      ...catalog,
      all: [
        {
          id: "test",
          name: "Test",
          models: { model: { id: "model", providerID: "test", name: "M", variants: { low: {} } } },
        },
      ],
    }),
    "GET /api/session/ses_main/message": () => ({ data: [assistant("main", "hi")], cursor: {} }),
  })
  await app.screen("build · test/model")
  await app.palette("effort")
  const frame = await app.screen("Model variant")
  expect(frame).not.toContain("no known model")
  expect(frame).toContain("test/model")
})

test("/effort with no model anywhere names the m key", async () => {
  const app = await open({
    "GET /provider": () => catalog,
    "GET /api/session/ses_main/message": () => ({ data: [], cursor: {} }),
  })
  await app.screen("server default")
  await app.palette("effort")
  await app.screen("Press m")
})
