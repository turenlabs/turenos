import { expect, test } from "bun:test"
import { fixture, catalog, custom } from "./providers-fixture"

test("cancellation during preflight prevents writes and after sending config prevents the key write", async () => {
  const stages = ["GET /provider", "GET /global/config", "PATCH /global/config"]
  for (const stage of stages) {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const requests: string[] = []
    const { providers } = fixture(async (request) => {
      const path = new URL(request.url).pathname
      const action = `${request.method} ${path}`
      requests.push(action)
      if (request.method === "PATCH") await request.json()
      if (action === stage) {
        entered.resolve()
        await release.promise
      }
      return Response.json(path === "/provider" ? catalog() : request.method === "PUT" ? true : {})
    })
    const controller = new AbortController()
    const operation = providers
      .addCustom({ ...custom, key: "fixture-key" }, "/srv", controller.signal)
      .catch((error: unknown) => error)
    try {
      await entered.promise
      controller.abort(new Error("fixture-secret cancellation reason"))
      release.resolve()
      expect(await operation).toMatchObject({
        message:
          stage === "PATCH /global/config"
            ? "Provider configuration could not be confirmed. Refresh providers before retrying."
            : "Provider request cancelled or timed out.",
      })
      expect(requests).toEqual(stages.slice(0, stages.indexOf(stage) + 1))
      expect(requests).not.toContain("PUT /auth/my-gateway")
    } finally {
      release.resolve()
    }
  }
})

test("connectKey preserves metadata as its third argument and accepts cancellation as its fourth", async () => {
  const bodies: unknown[] = []
  const { providers } = fixture(async (request) => {
    bodies.push(await request.json())
    return Response.json(true)
  })
  const controller = new AbortController()
  await providers.connectKey("openai", "fixture-key", { accountId: "fixture-account" }, controller.signal)
  controller.abort("fixture-secret")
  await expect(
    providers.connectKey("openai", "fixture-key", { accountId: "fixture-account" }, controller.signal),
  ).rejects.toThrow("Provider request cancelled or timed out.")
  expect(bodies).toEqual([{ type: "api", key: "fixture-key", metadata: { accountId: "fixture-account" } }])
})

test("config failures prevent auth writes and auth failures explain the saved configuration", async () => {
  const methods: string[] = []
  let failConfig = true
  const { providers } = fixture((request) => {
    methods.push(request.method)
    if (request.method === "GET") return Response.json(new URL(request.url).pathname === "/provider" ? catalog() : {})
    if (request.method === "PATCH" && !failConfig) return Response.json({})
    return new Response("fixture-secret\u001b[31m internal config and credential details", {
      status: 500,
      statusText: "fixture-secret",
    })
  })
  await expect(providers.addCustom({ ...custom, key: "fixture-secret" }, "/srv")).rejects.toMatchObject({
    message: "Provider configuration could not be confirmed. Refresh providers before retrying.",
  })
  expect(methods).toEqual(["GET", "GET", "PATCH"])
  failConfig = false
  await expect(providers.addCustom({ ...custom, key: "fixture-secret" }, "/srv")).rejects.toMatchObject({
    message:
      "Provider configuration was saved, but the API key could not be confirmed. Refresh providers and reconnect this provider before retrying.",
  })
  expect(methods).toEqual(["GET", "GET", "PATCH", "GET", "GET", "PATCH", "PUT"])
  failConfig = true
  await expect(providers.addCustom(custom, "/srv")).rejects.toMatchObject({
    message: "Provider configuration could not be confirmed. Refresh providers before retrying.",
  })
  expect(methods).toEqual(["GET", "GET", "PATCH", "GET", "GET", "PATCH", "PUT", "GET", "GET", "PATCH"])
})

test("native config omitted from both preflights rejects PATCH without replacing existing credentials", async () => {
  let savedKey = "fixture-existing-key"
  const requests: string[] = []
  const { providers } = fixture(async (request) => {
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/provider") return Response.json({ all: [], connected: [], default: {} })
    if (request.method === "GET") return Response.json({})
    if (request.method === "PUT") {
      savedKey = ((await request.json()) as { key: string }).key
      return Response.json(true)
    }
    return new Response("Native V2 configuration cannot accept this patch: fixture-existing-key", { status: 400 })
  })
  await expect(
    providers.addCustom({ ...custom, providerID: "native-hidden", key: "fixture-replacement-key" }, "/srv/filtered"),
  ).rejects.toMatchObject({
    message: "Provider configuration could not be confirmed. Refresh providers before retrying.",
  })
  expect(requests).toEqual(["GET /provider", "GET /global/config", "PATCH /global/config"])
  expect(savedKey).toBe("fixture-existing-key")
})

test("writes require true acknowledgements and never expose malformed success bodies", async () => {
  let response: unknown = { key: "fixture-secret" }
  const { providers } = fixture(() => Response.json(response))
  for (const value of [false, null, { key: "fixture-secret" }]) {
    response = value
    await expect(providers.connectKey("openai", "fixture-secret")).rejects.toThrow("API key acknowledgement")
    await expect(providers.complete("/srv", "openai", 0, "fixture-secret")).rejects.toThrow("OAuth acknowledgement")
  }
})
