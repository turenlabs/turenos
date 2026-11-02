import { describe, expect, test } from "bun:test"
import { createForgeClient } from "@turenlabs/sdk/v2/client"
import type { TranslationKey } from "@/context/language"
import { dict } from "@/i18n/en"
import { localProviders } from "@/hooks/provider-visibility"
import { localCliConnections, refreshLocalCliProvider } from "./dialog-connect-provider"

const english = new Map<TranslationKey, string>(Object.entries(dict))

function clientFor(fetcher: (request: Request) => Promise<Response>) {
  return createForgeClient({
    baseUrl: "http://localhost:3000",
    fetch: Object.assign((input: RequestInfo | URL) => fetcher(input instanceof Request ? input : new Request(input)), {
      preconnect: () => {},
    }),
  })
}

describe("local CLI setup", () => {
  test.each([
    ["claude-code", "Claude Code (local)", "claude auth login"],
    ["muse-code", "Muse Code (local)", "muse login"],
    ["devin-cli", "Devin CLI (local)", "devin auth login"],
  ])("uses the local login flow for %s", (id, name, command) => {
    const setup = localCliConnections.get(id)
    expect(setup).toMatchObject({ name, command })
    expect(english.get(setup!.descriptionKey)).toContain(name.replace(" (local)", ""))
    expect(english.get(setup!.notReadyKey)).toBeTruthy()
  })

  test("routes only built-in CLI providers to local login", () => {
    expect([...localCliConnections.keys()]).toEqual(
      localProviders.filter((item) => item.kind === "cli").map((item) => item.id),
    )
    expect(localCliConnections.has("openai")).toBe(false)
    expect(localCliConnections.has("ollama")).toBe(false)
    expect(localCliConnections.has("constructor")).toBe(false)
  })

  test("explains Devin sign-in without requesting an API key", () => {
    const setup = localCliConnections.get("devin-cli")!
    expect(english.get(setup.descriptionKey)).toContain("Devin CLI manages your sign-in.")
    expect(english.get(setup.descriptionKey)).toContain("TurenOS stores no API key.")
    expect(english.get(setup.notReadyKey)).toContain("devin auth login")
  })
})

describe("refreshLocalCliProvider", () => {
  test.each([true, false])("checks Devin readiness after discovery: %s", async (ready) => {
    const calls: string[] = []
    const providers: string[] = ["openai"]
    const client = clientFor(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
      return Response.json(true)
    })

    expect(
      await refreshLocalCliProvider({
        providerID: "devin-cli",
        client,
        enable: async (id) => {
          calls.push(`enable ${id}`)
        },
        refresh: async () => {
          calls.push("refresh")
          if (ready) providers.push("devin-cli")
        },
        connected: () => {
          calls.push("connected")
          return providers
        },
      }),
    ).toBe(ready)
    expect(calls).toEqual(["enable devin-cli", "POST /global/dispose", "refresh", "connected"])
  })

  test("does not report readiness when discovery fails", async () => {
    const failure = new Error("Provider discovery failed")
    const checked = { value: false }

    await expect(
      refreshLocalCliProvider({
        providerID: "devin-cli",
        client: clientFor(async () => Response.json(true)),
        enable: async () => {},
        refresh: async () => {
          throw failure
        },
        connected: () => {
          checked.value = true
          return ["devin-cli"]
        },
      }),
    ).rejects.toBe(failure)
    expect(checked.value).toBe(false)
  })
})
