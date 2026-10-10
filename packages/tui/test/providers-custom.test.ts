import { expect, test } from "bun:test"
import { fixture, catalog, custom } from "./providers-fixture"

test("custom providers keep keys in auth, slash model IDs intact, and use their explicit directory", async () => {
  const requests: { path: string; method: string; directory: string | null; body: unknown }[] = []
  const { providers } = fixture(async (request) => {
    const url = new URL(request.url)
    requests.push({
      path: url.pathname,
      method: request.method,
      directory: url.searchParams.get("directory"),
      body: request.method === "GET" ? undefined : await request.json(),
    })
    if (url.pathname === "/provider") return Response.json(catalog())
    if (url.pathname === "/global/config" && request.method === "GET")
      return Response.json({ provider: { unrelated: { options: { apiKey: "must-not-retain-config-secret" } } } })
    if (url.pathname === "/global/config") return new Response("full config with secrets; deliberately not JSON")
    return Response.json(true)
  })
  await providers.list("/srv/other")
  await providers.addCustom({ ...custom, key: "fixture-provider-secret" }, "/srv/selected")
  expect(requests.map((request) => [request.method, request.path])).toEqual([
    ["GET", "/provider"],
    ["GET", "/provider"],
    ["GET", "/global/config"],
    ["PATCH", "/global/config"],
    ["PUT", "/auth/my-gateway"],
  ])
  expect(requests[1]?.directory).toBe("/srv/selected")
  expect(requests[2]?.directory).toBeNull()
  expect(requests[4]?.body).toEqual({ type: "api", key: "fixture-provider-secret" })
  expect(requests[3]?.body).toEqual({
    provider: {
      "my-gateway": {
        npm: "@ai-sdk/openai-compatible",
        name: "My Gateway",
        options: { baseURL: custom.baseURL },
        models: { "org/model:v1": { name: "My Model" } },
      },
    },
  })
  expect(JSON.stringify(requests[3])).not.toContain("fixture-provider-secret")
  expect(JSON.stringify(requests)).not.toContain("must-not-retain-config-secret")
})

test("custom provider setup without a key only patches config, accepting runtime-supported endpoints", async () => {
  const methods: string[] = []
  const { providers } = fixture((request) => {
    methods.push(request.method)
    return Response.json(new URL(request.url).pathname === "/provider" ? catalog() : {})
  })
  for (const baseURL of [
    "https://gateway.example.test/v1",
    "http://localhost:1234/v1",
    "http://127.0.0.1/v1",
    "http://[::1]/v1",
    "http://10.1.2.3/v1",
    "http://172.16.0.1/v1",
    "http://172.31.255.255/v1",
    "http://192.168.1.2/v1",
  ]) {
    await providers.addCustom({ ...custom, baseURL }, "/srv")
  }
  expect(methods).toEqual(new Array(8).fill(["GET", "GET", "PATCH"]).flat())
})

test("invalid custom URLs, IDs, labels, and keys are rejected before any request", async () => {
  let requests = 0
  const { providers } = fixture(() => {
    requests++
    return Response.json(catalog())
  })
  for (const baseURL of [
    "not a URL",
    "file:///tmp/model",
    "http://public.example.test/v1",
    "http://172.32.0.1/v1",
    "http://127.0.0.2/v1",
    "http://[fc00::1]/v1",
    "https://user:fixture-secret@example.test/v1",
    "https://example.test/v1?api_key=fixture-secret",
    "https://example.test/v1#fragment",
    "https://example.test/v1?",
    "https://example.test/v1#",
    "https://example.test/\npath",
  ]) {
    await expect(providers.addCustom({ ...custom, baseURL, key: "fixture-secret" }, "/srv")).rejects.toThrow()
  }
  for (const providerID of ["__proto__", "prototype", "constructor", "../openai", "a/b", "a?key=x", "x".repeat(257)]) {
    await expect(providers.addCustom({ ...custom, providerID }, "/srv")).rejects.toThrow()
    await expect(providers.connectKey(providerID, "fixture-secret")).rejects.toThrow()
  }
  for (const input of [
    { modelID: "__proto__" },
    { modelID: "constructor" },
    { modelName: "bad\u202e" },
    { name: "" },
    { key: "" },
    { key: "fixture\nsecret" },
    { key: "x".repeat(8193) },
  ]) {
    await expect(providers.addCustom({ ...custom, ...input }, "/srv")).rejects.toThrow()
  }
  await expect(providers.addCustom(custom, "relative/fixture-secret")).rejects.toThrow("absolute directory")
  await expect(providers.addCustom(custom, "/srv/\u001bfixture-secret")).rejects.toThrow("absolute directory")
  expect(requests).toBe(0)
})

test("custom setup refuses connected and disconnected built-in IDs before saving credentials", async () => {
  const methods: string[] = []
  const { providers } = fixture((request) => {
    methods.push(request.method)
    return Response.json(catalog())
  })
  for (const providerID of ["openai", "offline"]) {
    await expect(providers.addCustom({ ...custom, providerID, key: "fixture-secret" }, "/srv")).rejects.toThrow(
      "already exists",
    )
  }
  expect(methods).toEqual(["GET", "GET"])
})

test("global configuration reserves provider, providers, and disabled IDs hidden from the directory catalog", async () => {
  let config: unknown = {}
  const requests: string[] = []
  const { providers } = fixture((request) => {
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/provider") return Response.json(catalog())
    expect(url.search).toBe("")
    return Response.json(config)
  })
  for (const value of [
    { provider: { "my-gateway": { options: { apiKey: "fixture-global-secret" } } } },
    { providers: { "my-gateway": { auth: { key: "fixture-global-secret" } } } },
    { disabled_providers: ["my-gateway"], unrelated: "fixture-global-secret" },
  ]) {
    config = value
    const error = await providers
      .addCustom({ ...custom, key: "fixture-key" }, "/srv/filtered")
      .catch((error: unknown) => error)
    expect(error).toMatchObject({
      message: "Provider ID already exists. Connect it with a key, or choose a new custom provider ID.",
    })
    expect(String(error)).not.toContain("fixture-global-secret")
    expect(error).not.toHaveProperty("cause")
  }
  expect(requests).toEqual(new Array(3).fill(["GET /provider", "GET /global/config"]).flat())
})

test("global preflight rejects invalid or excessive configuration without exposing config or starting writes", async () => {
  let response = () => Response.json({})
  const requests: string[] = []
  const { providers } = fixture((request) => {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    return path === "/provider" ? Response.json(catalog()) : response()
  })
  for (const body of [
    () => new Response('{"fixture-global-secret":broken}'),
    () => Response.json(null),
    () => Response.json({ provider: [] }),
    () => Response.json({ providers: "fixture-global-secret" }),
    () => Response.json({ provider: { constructor: "fixture-global-secret" } }),
    () => Response.json({ providers: Object.fromEntries([["__proto__", "fixture-global-secret"]]) }),
    () => Response.json({ disabled_providers: ["bad\u001bfixture-global-secret"] }),
    () =>
      Response.json({ provider: Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`p${index}`, {}])) }),
    () => Response.json({ disabled_providers: new Array(1025).fill("fixture-provider") }),
    () => new Response('{"unused":' + "[".repeat(65) + '"fixture-global-secret"' + "]".repeat(65) + "}"),
    () =>
      new Response(Bun.gzipSync(new Uint8Array(8 * 1024 * 1024 + 1).fill(32)), {
        headers: { "Content-Encoding": "gzip" },
      }),
    () => new Response("fixture-global-secret", { status: 500, statusText: "fixture-global-secret" }),
  ]) {
    response = body
    const error = await providers.addCustom({ ...custom, key: "fixture-key" }, "/srv").catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain("fixture-global-secret")
    expect(error).not.toHaveProperty("cause")
  }
  expect(requests).toEqual(new Array(12).fill(["GET /provider", "GET /global/config"]).flat())
})

test("global preflight refuses redirects without forwarding credentials or starting writes", async () => {
  let redirected = 0
  const target = fixture(() => {
    redirected++
    return Response.json({})
  })
  const requests: string[] = []
  const { providers } = fixture((request) => {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    return path === "/provider" ? Response.json(catalog()) : Response.redirect(target.server.url.href, 307)
  })
  await expect(providers.addCustom(custom, "/srv")).rejects.toThrow("redirects are not permitted")
  expect(requests).toEqual(["GET /provider", "GET /global/config"])
  expect(redirected).toBe(0)
})

test("cancelled custom saves start neither preflight reads nor mutations", async () => {
  let requests = 0
  const { providers } = fixture(() => {
    requests++
    return Response.json(catalog())
  })
  const controller = new AbortController()
  controller.abort(new Error("fixture-secret cancellation reason"))
  for (const input of [custom, { ...custom, key: "fixture-key" }]) {
    await expect(providers.addCustom(input, "/srv", controller.signal)).rejects.toThrow(
      "Provider request cancelled or timed out.",
    )
  }
  expect(requests).toBe(0)
})
