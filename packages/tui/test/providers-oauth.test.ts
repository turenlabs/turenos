import { expect, test } from "bun:test"
import type { AuthMethod } from "../src/providers"
import { fixture } from "./providers-fixture"

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
