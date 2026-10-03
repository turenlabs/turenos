import { afterEach, expect, test } from "bun:test"
import { createProviders, type AuthMethod } from "../src/providers"

const servers: ReturnType<typeof Bun.serve>[] = []
const controllers: AbortController[] = []

afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.abort())
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

function fixture(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch })
  const controller = new AbortController()
  servers.push(server)
  controllers.push(controller)
  const headers = new Headers({ Authorization: "Bearer fixture-server-credential" })
  return {
    server,
    controller,
    providers: createProviders({ url: server.url, headers, signal: controller.signal }),
  }
}

function catalog() {
  return {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        key: "must-not-retain-provider-key",
        options: { apiKey: "must-not-retain-option-key", headers: { Authorization: "must-not-retain-header" } },
        models: {
          "org/model:v1": {
            id: "org/model:v1",
            providerID: "openai",
            name: "Model One",
            headers: { Authorization: "must-not-retain-model-header" },
            options: { apiKey: "must-not-retain-model-key" },
          },
        },
      },
      {
        id: "offline",
        name: "Disconnected",
        models: { hidden: { id: "hidden", providerID: "offline", name: "Unavailable" } },
      },
    ],
    connected: ["openai"],
    default: { openai: "org/model:v1" },
  }
}

const custom = {
  providerID: "my-gateway",
  name: "My Gateway",
  baseURL: "https://gateway.example.test/v1",
  modelID: "org/model:v1",
  modelName: "My Model",
}

test("list projects only display metadata and connected models with the selected location", async () => {
  const requests: { path: string; directory: string | null; authorization: string | null }[] = []
  const { providers } = fixture((request) => {
    const url = new URL(request.url)
    requests.push({
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      authorization: request.headers.get("authorization"),
    })
    return Response.json(catalog())
  })
  const result = await providers.list("/srv/project with spaces & symbols/#test")
  expect(result).toEqual({
    providers: [
      { id: "openai", name: "OpenAI", connected: true },
      { id: "offline", name: "Disconnected", connected: false },
    ],
    models: [{ providerID: "openai", id: "org/model:v1", name: "Model One", providerName: "OpenAI" }],
  })
  expect(JSON.stringify(result)).not.toContain("must-not-retain")
  expect(requests).toEqual([
    {
      path: "/provider",
      directory: "/srv/project with spaces & symbols/#test",
      authorization: "Bearer fixture-server-credential",
    },
  ])
  await providers.list("C:\\project")
  expect(requests[1]?.directory).toBe("C:\\project")
  await expect(providers.list("relative/path")).rejects.toThrow("absolute directory")
  await expect(providers.list("/srv/\u001b[31m")).rejects.toThrow()
  expect(requests).toHaveLength(2)
})

test("malformed and overly complex JSON never echoes remote content", async () => {
  let body = '{"echoed-key":"fixture-secret",bad}'
  const { providers } = fixture(() => new Response(body))
  await expect(providers.list("/srv")).rejects.toThrow("Invalid server response (JSON)")
  body = "[".repeat(65) + "0" + "]".repeat(65)
  await expect(providers.list("/srv")).rejects.toThrow("JSON complexity limit")
  body = "[" + "{},".repeat(50000) + "{}]"
  await expect(providers.list("/srv")).rejects.toThrow("JSON complexity limit")
})

test("streamed and compressed decoded bodies are bounded before JSON parsing", async () => {
  let compressed = false
  const oversized = new Uint8Array(8 * 1024 * 1024 + 1).fill(32)
  const { providers } = fixture(() =>
    compressed
      ? new Response(Bun.gzipSync(oversized), { headers: { "Content-Encoding": "gzip" } })
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized.subarray(0, 4 * 1024 * 1024))
              controller.enqueue(oversized.subarray(4 * 1024 * 1024))
              controller.close()
            },
          }),
        ),
  )
  await expect(providers.list("/srv")).rejects.toThrow("8 MiB")
  compressed = true
  await expect(providers.list("/srv")).rejects.toThrow("8 MiB")
})

test("catalog validates identities, collections, lengths, controls, and prototype keys", async () => {
  let response: unknown = null
  const { providers } = fixture(() => Response.json(response))
  const all = catalog().all
  for (const value of [
    null,
    { all: [], connected: ["missing"] },
    { all: [all[0], all[0]], connected: [] },
    { all: [{ ...all[0], id: "__proto__" }], connected: [] },
    { all: [{ ...all[0], id: "constructor" }], connected: [] },
    { all: [{ ...all[0], name: "bad\u001b[31m" }], connected: [] },
    { all: [{ ...all[0], name: "x".repeat(513) }], connected: [] },
    {
      all: [{ id: "one", name: "One", models: { wrong: { id: "different", providerID: "one", name: "Model" } } }],
      connected: [],
    },
    {
      all: [{ id: "one", name: "One", models: { model: { id: "model", providerID: "another", name: "Model" } } }],
      connected: [],
    },
    {
      all: [
        { id: "one", name: "One", models: { constructor: { id: "constructor", providerID: "one", name: "Model" } } },
      ],
      connected: [],
    },
    { all: new Array(1025).fill(all[0]), connected: [] },
  ]) {
    response = value
    await expect(providers.list("/srv")).rejects.toThrow()
  }
})

test("redirects never forward server credentials or provider keys", async () => {
  let redirected = 0
  const target = fixture(() => {
    redirected++
    return Response.json(true)
  })
  const authorization: (string | null)[] = []
  const { providers } = fixture((request) => {
    authorization.push(request.headers.get("authorization"))
    return Response.redirect(target.server.url.href, 307)
  })
  await expect(providers.list("/srv")).rejects.toThrow("redirects are not permitted")
  await expect(providers.connectKey("openai", "fixture-provider-key")).rejects.toThrow("redirects are not permitted")
  expect(authorization).toEqual(["Bearer fixture-server-credential", "Bearer fixture-server-credential"])
  expect(redirected).toBe(0)
})

test("provider secrets require encrypted or canonical numeric loopback transport even without server auth", async () => {
  for (const address of [
    "http://example.test",
    "http://192.168.1.2",
    "http://localhost",
    "http://127.0.0.2",
    "http://127.0.0.1.example.test",
    "http://0.0.0.0",
    "http://[::]",
    "http://[::ffff:127.0.0.1]",
  ]) {
    const providers = createProviders({
      url: new URL(address),
      headers: new Headers(),
      signal: new AbortController().signal,
    })
    await expect(providers.connectKey("openai", "fixture-provider-key")).rejects.toThrow("require HTTPS")
    await expect(providers.authorize("/srv", "openai", 0, { token: "fixture-input" })).rejects.toThrow("require HTTPS")
    await expect(providers.complete("/srv", "openai", 0, "fixture-code")).rejects.toThrow("require HTTPS")
    await expect(providers.addCustom(custom, "/srv")).rejects.toThrow("require HTTPS")
    await expect(providers.addCustom({ ...custom, key: "fixture-provider-key" }, "/srv")).rejects.toThrow(
      "require HTTPS",
    )
  }
})

test("factory rejects unsafe server URLs and snapshots the URL and headers", async () => {
  for (const value of [
    "ftp://example.test",
    "https://user:password@example.test",
    "https://example.test/api",
    "https://example.test?key=secret",
    "https://example.test#secret",
    "https://example.test?",
    "https://example.test#",
  ]) {
    expect(() =>
      createProviders({ url: new URL(value), headers: new Headers(), signal: new AbortController().signal }),
    ).toThrow()
  }
  const seen: (string | null)[] = []
  const { server } = fixture((request) => {
    seen.push(request.headers.get("authorization"))
    return Response.json(true)
  })
  const url = new URL(server.url)
  const headers = new Headers({ Authorization: "Bearer original-fixture-credential" })
  const providers = createProviders({ url, headers, signal: new AbortController().signal })
  url.hostname = "example.test"
  headers.set("Authorization", "Bearer changed-fixture-credential")
  await providers.connectKey("openai", "fixture-key")
  expect(seen).toEqual(["Bearer original-fixture-credential"])
})

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

test("OAuth auth methods project prompts, options, and conditions without arbitrary metadata", async () => {
  const methods = {
    openai: [
      { type: "api", label: "API key" },
      {
        type: "oauth",
        label: "Browser",
        prompts: [
          {
            type: "select",
            key: "mode",
            message: "Account type",
            options: [{ label: "Work", value: "work", hint: "Organization account" }],
          },
          {
            type: "text",
            key: "tenant",
            message: "Tenant",
            placeholder: "example",
            when: { key: "mode", op: "eq", value: "work" },
          },
        ],
      },
    ],
  } satisfies Record<string, AuthMethod[]>
  const { providers } = fixture((request) => {
    const url = new URL(request.url)
    expect(url.pathname).toBe("/provider/auth")
    expect(url.searchParams.get("directory")).toBe("/srv/oauth")
    return Response.json({
      openai: methods.openai.map((method) => ({ ...method, headers: { authorization: "fixture-secret" } })),
    })
  })
  expect(await providers.auth("/srv/oauth")).toEqual(methods)
})

test("OAuth authorize and complete match shipped payloads for code and automatic flows", async () => {
  const requests: { path: string; directory: string | null; body: unknown }[] = []
  let method: "auto" | "code" = "code"
  const { providers } = fixture(async (request) => {
    const url = new URL(request.url)
    requests.push({ path: url.pathname, directory: url.searchParams.get("directory"), body: await request.json() })
    return Response.json(
      url.pathname.endsWith("/authorize")
        ? {
            url: "https://login.example.test/authorize?state=fixture",
            method,
            instructions: "Open the browser.\nThen continue.",
            key: "must-not-retain",
          }
        : true,
    )
  })
  expect(await providers.authorize("/srv/oauth", "openai", 1, { tenant: "fixture-tenant" })).toEqual({
    url: "https://login.example.test/authorize?state=fixture",
    method: "code",
    instructions: "Open the browser.\nThen continue.",
  })
  await providers.complete("/srv/oauth", "openai", 1, "fixture-code")
  method = "auto"
  expect((await providers.authorize("/srv/oauth", "openai", 0)).method).toBe("auto")
  await providers.complete("/srv/oauth", "openai", 0)
  expect(requests).toEqual([
    {
      path: "/provider/openai/oauth/authorize",
      directory: "/srv/oauth",
      body: { method: 1, inputs: { tenant: "fixture-tenant" } },
    },
    { path: "/provider/openai/oauth/callback", directory: "/srv/oauth", body: { method: 1, code: "fixture-code" } },
    { path: "/provider/openai/oauth/authorize", directory: "/srv/oauth", body: { method: 0 } },
    { path: "/provider/openai/oauth/callback", directory: "/srv/oauth", body: { method: 0 } },
  ])
})

test("OAuth rejects malformed metadata, unsafe browser URLs, invalid inputs, and unsafe instructions", async () => {
  let response: unknown = null
  let requests = 0
  const { providers } = fixture(() => {
    requests++
    return Response.json(response)
  })
  for (const value of [
    null,
    { constructor: [] },
    { openai: [{ type: "other", label: "Broken" }] },
    { openai: [{ type: "oauth", label: "Bad\u001b" }] },
    { openai: [{ type: "oauth", label: "Browser", prompts: [{ type: "text", key: "__proto__", message: "Key" }] }] },
  ]) {
    response = value
    await expect(providers.auth("/srv")).rejects.toThrow()
  }
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/secret",
    "http://login.example.test",
    "https://user:fixture-secret@login.example.test",
    "https://login.example.test/\u001b",
  ]) {
    response = { url, method: "auto", instructions: "Continue" }
    await expect(providers.authorize("/srv", "openai", 0)).rejects.toThrow()
  }
  for (const value of [
    null,
    { url: "https://login.example.test", method: "other", instructions: "Continue" },
    { url: "https://login.example.test", method: "auto", instructions: "\u001b]52;clipboard" },
  ]) {
    response = value
    await expect(providers.authorize("/srv", "openai", 0)).rejects.toThrow()
  }
  const before = requests
  for (const method of [-1, 0.5, NaN, Infinity, 32]) {
    await expect(providers.authorize("/srv", "openai", method)).rejects.toThrow()
    await expect(providers.complete("/srv", "openai", method)).rejects.toThrow()
  }
  await expect(providers.authorize("/srv", "openai", 0, { constructor: "fixture-secret" })).rejects.toThrow()
  await expect(providers.authorize("/srv", "openai", 0, { tenant: "x".repeat(4097) })).rejects.toThrow()
  await expect(providers.complete("/srv", "openai", 0, "fixture\ncode")).rejects.toThrow()
  expect(requests).toBe(before)
})

test("connection cancellation and per-completion cancellation abort in-flight response reads without leaking reasons", async () => {
  for (const completion of [false, true]) {
    const entered = Promise.withResolvers<void>()
    const { providers, controller } = fixture(
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(" "))
              entered.resolve()
            },
          }),
        ),
    )
    const local = new AbortController()
    const operation = completion
      ? providers.complete("/srv", "openai", 0, undefined, local.signal)
      : providers.list("/srv")
    await entered.promise
    await Bun.sleep(20)
    const cancellation = completion ? local : controller
    cancellation.abort(new Error("fixture-secret cancellation reason"))
    await expect(operation).rejects.toThrow("Provider request cancelled or timed out.")
    if (completion) expect(controller.signal.aborted).toBe(false)
  }
})

test("an already cancelled connection sends no provider key", async () => {
  let requests = 0
  const { providers, controller } = fixture(() => {
    requests++
    return Response.json(true)
  })
  controller.abort("fixture-secret")
  await expect(providers.connectKey("openai", "fixture-secret")).rejects.toThrow("cancelled or timed out")
  expect(requests).toBe(0)
})

test("stalled response bodies have a per-request deadline independent of connection cancellation", async () => {
  const { providers, controller } = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(" "))
          },
        }),
      ),
  )
  await expect(providers.list("/srv")).rejects.toThrow("Provider request cancelled or timed out.")
  expect(controller.signal.aborted).toBe(false)
}, 15000)

test("HTTP and transport failures contain no remote body, status text, secret, or cause", async () => {
  let status = 400
  const { providers, server } = fixture(
    () => new Response("fixture-provider-secret", { status, statusText: "fixture-provider-secret" }),
  )
  for (const code of [400, 500]) {
    status = code
    const error = await providers.connectKey("openai", "fixture-provider-secret").catch((error: unknown) => error)
    expect(error).toMatchObject({ message: `Provider request failed (HTTP ${code}).` })
    expect(String(error)).not.toContain("fixture-provider-secret")
    expect(error).not.toHaveProperty("cause")
  }
  await server.stop(true)
  const error = await providers.connectKey("openai", "fixture-provider-secret").catch((error: unknown) => error)
  expect(error).toMatchObject({
    message: "Provider request failed. Check the server connection; redirects are not permitted.",
  })
  expect(String(error)).not.toContain("fixture-provider-secret")
  expect(error).not.toHaveProperty("cause")
})

test("numeric loopback key requests bypass inherited shell proxies", async () => {
  let direct = 0
  let proxied = 0
  const target = fixture(() => {
    direct++
    return Response.json(true)
  })
  const proxy = fixture(() => {
    proxied++
    return Response.json(true)
  })
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { createProviders } from ${JSON.stringify(new URL("../src/providers.ts", import.meta.url).href)};
     await createProviders({url: new URL(process.env.TUI_TEST_URL), headers: new Headers(), signal: new AbortController().signal}).connectKey("openai", "fixture-provider-secret");`,
    ],
    {
      env: {
        ...process.env,
        TUI_TEST_URL: target.server.url.href,
        HTTP_PROXY: proxy.server.url.href,
        HTTPS_PROXY: proxy.server.url.href,
        ALL_PROXY: proxy.server.url.href,
        http_proxy: proxy.server.url.href,
        https_proxy: proxy.server.url.href,
        all_proxy: proxy.server.url.href,
        NO_PROXY: "",
        no_proxy: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(direct).toBe(1)
  expect(proxied).toBe(0)
})
