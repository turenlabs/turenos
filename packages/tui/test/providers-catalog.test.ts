import { expect, test } from "bun:test"
import { createProviders } from "../src/providers"
import { fixture, catalog, custom } from "./providers-fixture"

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
    defaults: { openai: "org/model:v1" },
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

test("catalog keeps valid release dates and defaults and drops malformed ones without rejecting the catalog", async () => {
  const dated = (id: string, release_date: unknown) => ({ id, providerID: "openai", name: id, release_date })
  const { providers } = fixture(() =>
    Response.json({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            good: dated("good", "2026-02-03"),
            stamp: dated("stamp", "2026-02-03T10:00:00Z"),
            month: dated("month", "2026-13-01"),
            text: dated("text", "yesterday"),
            number: dated("number", 20260203),
          },
        },
      ],
      connected: ["openai"],
      default: { openai: "good", "bad id!": "x", other: 5, constructor: "x" },
    }),
  )
  const result = await providers.list("/srv")
  expect(result.models.map((item) => item.release)).toEqual([
    "2026-02-03",
    "2026-02-03",
    undefined,
    undefined,
    undefined,
  ])
  expect(result.defaults).toEqual({ openai: "good" })
})

test("catalog keeps a valid family and status and drops bad ones without rejecting the catalog", async () => {
  const { providers } = fixture(() =>
    Response.json({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            good: { id: "good", providerID: "openai", name: "good", family: "gpt", status: "deprecated" },
            odd: { id: "odd", providerID: "openai", name: "odd", family: "gp\u001bt", status: "retired" },
            number: { id: "number", providerID: "openai", name: "number", family: 5, status: 5 },
            long: { id: "long", providerID: "openai", name: "long", family: "x".repeat(129) },
          },
        },
      ],
      connected: ["openai"],
      default: {},
    }),
  )
  const result = await providers.list("/srv")
  expect(result.models.map((item) => [item.family, item.status])).toEqual([
    ["gpt", "deprecated"],
    [undefined, undefined],
    [undefined, undefined],
    [undefined, undefined],
  ])
})
