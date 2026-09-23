import { afterEach, describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { ExtensionCatalog } from "@turenlabs/extensions"
import { Extension } from "@turenlabs/schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { localExtensionRequest } from "../../src/server/routes/instance/httpapi/handlers/extension"
import { mcpRuntimeObservation } from "../../src/extension"
import { McpIntegration } from "@/mcp/integration"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)
type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const request = (handler: TestHandler, path: string, directory: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set("x-forge-directory", directory)
  if (init?.body) headers.set("content-type", "application/json")
  return Effect.promise(() =>
    Promise.resolve(handler.handler(new Request(`http://localhost${path}`, { ...init, headers }), context)),
  )
}

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

afterEach(() => McpIntegration.sync(ExtensionCatalog.manifests))

describe("Extension HttpApi", () => {
  it.effect("aggregates multi-contribution MCP runtime status", () =>
    Effect.sync(() => {
      expect(mcpRuntimeObservation([{ status: "connected" }])).toEqual({ status: "connected" })
      expect(mcpRuntimeObservation([{ status: "needs_auth" }])).toEqual({ status: "needs-auth" })
      expect(mcpRuntimeObservation([{ status: "needs_client_registration", error: "client required" }])).toEqual({
        status: "needs-auth",
      })
      expect(mcpRuntimeObservation([{ status: "connected" }, undefined])).toEqual({ status: "connecting" })
      expect(mcpRuntimeObservation([{ status: "connecting" }])).toEqual({ status: "connecting" })
      expect(mcpRuntimeObservation([{ status: "needs_auth" }, undefined])).toEqual({ status: "needs-auth" })
      expect(
        mcpRuntimeObservation([{ status: "needs_client_registration", error: "client required" }, undefined]),
      ).toEqual({ status: "needs-auth" })
      expect(mcpRuntimeObservation([{ status: "failed", error: "upstream failed" }, undefined])).toEqual({
        status: "failed",
        detail: "upstream failed",
      })
      expect(mcpRuntimeObservation([{ status: "connected" }, { status: "failed", error: "upstream failed" }])).toEqual({
        status: "failed",
        detail: "upstream failed",
      })
    }),
  )

  it.effect("allows local extension updates only for implicit local placement", () =>
    Effect.sync(() => {
      expect(localExtensionRequest({ inProcess: true })).toBe(true)
      expect(localExtensionRequest({ inProcess: false, remoteAddress: "127.0.0.1" })).toBe(true)
      expect(localExtensionRequest({ inProcess: false, remoteAddress: "::ffff:127.0.0.1" })).toBe(true)
      expect(localExtensionRequest({ inProcess: false, remoteAddress: "203.0.113.10" })).toBe(false)
      expect(localExtensionRequest({ workspaceID: "remote", inProcess: true })).toBe(false)
    }),
  )

  it.instance("lists the complete catalog and persists skill activation", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const directory = tmp.directory

      const listed = yield* request(handler, "/extension", directory)
      expect(listed.status, yield* Effect.promise(() => listed.clone().text())).toBe(200)
      const catalog = yield* json<
        Array<{
          manifest: { id: string; contributions: unknown[] }
          origin: string
          mutable: boolean
          enabled: boolean
        }>
      >(listed)
      expect(catalog).toHaveLength(ExtensionCatalog.manifests.length)
      expect(catalog.every((item) => item.origin === "catalog" && item.mutable)).toBe(true)
      expect(catalog.map((item) => item.manifest.id)).toContain("turenlabs/notion")
      expect(catalog.map((item) => item.manifest.id)).toContain("turenlabs/customize-forge")
      for (const id of [
        "turenlabs/cloudflare-audit-logs",
        "turenlabs/cloudflare-casb",
        "turenlabs/datadog-security",
        "turenlabs/elastic-security",
        "turenlabs/github-security",
        "turenlabs/jfrog-xray",
        "turenlabs/microsoft-graph-enterprise",
        "turenlabs/microsoft-sentinel",
        "turenlabs/pagerduty",
        "turenlabs/sentry",
        "turenlabs/sonarqube-cloud-security",
      ]) {
        expect(catalog.map((item) => item.manifest.id)).toContain(id)
      }
      expect(
        catalog.find((item) => item.manifest.id === "turenlabs/microsoft-sentinel")?.manifest.contributions,
      ).toHaveLength(2)

      const disabledMcp = yield* request(handler, "/extension/turenlabs%2Fcloudflare-audit-logs", directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }).pipe(Effect.timeout("1 second"))
      expect(disabledMcp.status, yield* Effect.promise(() => disabledMcp.clone().text())).toBe(200)
      expect(
        (yield* json<Array<{ manifest: { id: string }; status: string }>>(disabledMcp)).find(
          (item) => item.manifest.id === "turenlabs/cloudflare-audit-logs",
        )?.status,
      ).toBe("disabled")

      const enabledMcp = yield* request(handler, "/extension/turenlabs%2Fcloudflare-audit-logs", directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      }).pipe(Effect.timeout("1 second"))
      expect(enabledMcp.status, yield* Effect.promise(() => enabledMcp.clone().text())).toBe(200)
      expect(
        (yield* json<Array<{ manifest: { id: string }; status: string }>>(enabledMcp)).find(
          (item) => item.manifest.id === "turenlabs/cloudflare-audit-logs",
        )?.status,
      ).toBe("connecting")

      const disabled = yield* request(handler, "/extension/turenlabs%2Fcustomize-forge", directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      })
      expect(disabled.status).toBe(200)
      expect(
        (yield* json<Array<{ manifest: { id: string }; enabled: boolean }>>(disabled)).find(
          (item) => item.manifest.id === "turenlabs/customize-forge",
        )?.enabled,
      ).toBe(false)
      const disabledCatalog = yield* request(handler, "/extension", directory)
      expect(
        (yield* json<Array<{ manifest: { id: string }; enabled: boolean }>>(disabledCatalog)).find(
          (item) => item.manifest.id === "turenlabs/customize-forge",
        )?.enabled,
      ).toBe(false)

      const restored = yield* request(handler, "/extension/turenlabs%2Fcustomize-forge", directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      })
      expect(restored.status).toBe(200)
      const restoredCatalog = yield* request(handler, "/extension", directory)
      expect(
        (yield* json<Array<{ manifest: { id: string }; enabled: boolean }>>(restoredCatalog)).find(
          (item) => item.manifest.id === "turenlabs/customize-forge",
        )?.enabled,
      ).toBe(true)
    }),
  )

  it.instance("rejects unknown extensions", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const response = yield* request(handler, "/extension/turenlabs%2Funknown", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(400)
    }),
  )

  it.instance("rejects route and manifest identity mismatches before admission work", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(HttpApiApp.webHandler(), "/extension/community%2Fwrong-id", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false, manifest: ExtensionCatalog.get("turenlabs/chainguard-docs") }),
      })
      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => response.text())).toContain("Route id does not match manifest id")
    }),
  )

  it.instance("installs a generic hosted MCP manifest and keeps it after a fresh list", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const manifest = new Extension.Manifest({
        schemaVersion: 1,
        id: Extension.ID.make("community", "hosted-search"),
        name: "Hosted Search",
        description: "Search a hosted service",
        version: "1.0.0",
        publisher: "Community",
        trust: "community",
        contributions: [
          {
            type: "mcp",
            id: Extension.ContributionID.make("hosted-search"),
            name: "Hosted Search",
            description: "Search a hosted service",
            instructions: "Keep usage read-only.",
            adapter: "mcp:hosted-search",
            secrets: [],
            defaultEnabled: false,
            upstreamPolicy: "static",
            deployment: { type: "hosted", url: "https://mcp.example.test/mcp" },
            authentication: "none",
            localOnly: false,
            mcpContext: { maxLoadedTools: 2, unloadAfterIdleTurns: 3 },
            tools: { allow: ["search"], write: [] },
          },
        ],
      })
      const installed = yield* request(handler, `/extension/${encodeURIComponent(manifest.id)}`, tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false, manifest }),
      })
      expect(installed.status, yield* Effect.promise(() => installed.clone().text())).toBe(200)
      expect(
        (yield* json<Array<{ manifest: { id: string }; enabled: boolean; installed?: boolean; mutable: boolean }>>(
          installed,
        )).find((item) => item.manifest.id === manifest.id),
      ).toMatchObject({ enabled: false, installed: true, mutable: true })

      const listed = yield* request(handler, "/extension", tmp.directory)
      expect(
        (yield* json<Array<{ manifest: { id: string; version: string }; installed?: boolean }>>(listed)).find(
          (item) => item.manifest.id === manifest.id,
        ),
      ).toMatchObject({ manifest: { version: "1.0.0" }, installed: true })

      const enabled = yield* request(handler, `/extension/${encodeURIComponent(manifest.id)}`, tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      })
      expect(enabled.status, yield* Effect.promise(() => enabled.clone().text())).toBe(200)
      const item = (yield* json<
        Array<{ manifest: { id: string }; enabled: boolean; status: string; installed?: boolean }>
      >(enabled)).find((item) => item.manifest.id === manifest.id)
      expect(item).toMatchObject({ enabled: true, installed: true })
      if (!item) throw new Error("Installed hosted MCP was not listed")
      expect(["connecting", "failed"]).toContain(item.status)
    }),
  )

  it.instance("rejects dynamic manifests that claim native adapter authority", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const trivy = ExtensionCatalog.get("turenlabs/trivy")!
      const response = yield* request(HttpApiApp.webHandler(), "/extension/community%2Funtrusted-tool", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: false,
          manifest: {
            ...trivy,
            id: "community/untrusted-tool",
            publisher: "Community",
            trust: "community",
          },
        }),
      })
      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => response.text())).toContain("cannot select a privileged tool adapter")
    }),
  )

  it.instance("requires PagerDuty client registration before connection", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(HttpApiApp.webHandler(), "/extension/turenlabs%2Fpagerduty", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      })
      expect(response.status).toBe(200)
      const pagerduty = (yield* json<Array<{ manifest: { id: string }; status: string; detail?: string }>>(
        response,
      )).find((item) => item.manifest.id === "turenlabs/pagerduty")
      expect(pagerduty).toMatchObject({ status: "needs-config" })
      expect(pagerduty?.detail).toContain("required connection configuration")
    }),
  )

  it.instance("reports required endpoint, static OAuth, and header configuration before connecting", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const update = (id: string, body: unknown) =>
        request(handler, `/extension/${encodeURIComponent(id)}`, tmp.directory, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      const status = (items: Array<{ manifest: { id: string }; status: string }>, id: string) =>
        items.find((item) => item.manifest.id === id)?.status

      const datadog = yield* update("turenlabs/datadog-security", { enabled: true })
      expect(datadog.status).toBe(200)
      expect(
        status(yield* json<Array<{ manifest: { id: string }; status: string }>>(datadog), "turenlabs/datadog-security"),
      ).toBe("needs-config")

      const graph = yield* update("turenlabs/microsoft-graph-enterprise", { enabled: true })
      expect(graph.status).toBe(200)
      expect(
        status(
          yield* json<Array<{ manifest: { id: string }; status: string }>>(graph),
          "turenlabs/microsoft-graph-enterprise",
        ),
      ).toBe("needs-config")

      const sonar = yield* update("turenlabs/sonarqube-cloud-security", {
        enabled: true,
        configuration: { organization: "turen" },
      })
      expect(sonar.status).toBe(200)
      expect(
        status(
          yield* json<Array<{ manifest: { id: string }; status: string }>>(sonar),
          "turenlabs/sonarqube-cloud-security",
        ),
      ).toBe("needs-auth")
    }),
  )

  it.instance("updates the shared Batou activation read by both runtimes", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(HttpApiApp.webHandler(), "/extension/turenlabs%2Fbatou", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      })

      expect(response.status).toBe(200)
      expect(
        (yield* json<Array<{ manifest: { id: string }; enabled: boolean }>>(response)).find(
          (item) => item.manifest.id === "turenlabs/batou",
        )?.enabled,
      ).toBe(true)
    }),
  )

  it.instance("enables a local tool without waiting for global instance disposal", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(HttpApiApp.webHandler(), "/extension/turenlabs%2Ftrivy", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      }).pipe(Effect.timeout("1 second"))

      expect(response.status).toBe(200)
      const trivy = (yield* json<Array<{ manifest: { id: string }; enabled: boolean; status: string }>>(response)).find(
        (item) => item.manifest.id === "turenlabs/trivy",
      )
      expect(trivy).toMatchObject({ enabled: true, status: "needs-install" })
    }),
  )

  it.instance("rejects undeclared inputs without exposing raw causes or secret values", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const secret = "extension-secret-canary"
      const response = yield* request(handler, "/extension/turenlabs%2Fcustomize-forge", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true, secrets: { LINEAR_API_KEY: secret } }),
      })
      const body = yield* Effect.promise(() => response.text())

      expect(response.status).toBe(400)
      expect(body).toContain("Undeclared secret: [redacted]")
      expect(body).not.toContain(secret)
      expect(body).not.toContain("Cause(")
      expect(body).not.toContain("/Users/")

      const configuration = yield* request(handler, "/extension/turenlabs%2Fnotion", tmp.directory, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false, configuration: { customerEndpoint: "https://attacker.example" } }),
      })
      expect(configuration.status).toBe(400)
      expect(yield* Effect.promise(() => configuration.text())).toContain("Undeclared configuration: customerEndpoint")
    }),
  )

  it.instance("stores the write-tool opt-in only for MCP extensions that declare write tools", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const patch = (id: string, writeTools: string) =>
        request(handler, `/extension/${encodeURIComponent(id)}`, tmp.directory, {
          method: "PATCH",
          body: JSON.stringify({ enabled: false, configuration: { writeTools } }),
        })
      const tenable = (response: Response) =>
        json<Array<{ manifest: { id: string }; configurationSet: Record<string, boolean> }>>(response).pipe(
          Effect.map((items) => items.find((item) => item.manifest.id === "turenlabs/tenable")),
        )

      // Tenable, not Datadog: disabling an extension here marks its MCP runtime disabled process-wide.
      const enabled = yield* patch("turenlabs/tenable", "enabled")
      expect(enabled.status).toBe(200)
      expect((yield* tenable(enabled))?.configurationSet.writeTools).toBe(true)

      const cleared = yield* patch("turenlabs/tenable", "")
      expect(cleared.status).toBe(200)
      expect((yield* tenable(cleared))?.configurationSet.writeTools).toBeUndefined()

      const invalid = yield* patch("turenlabs/tenable", "all")
      expect(invalid.status).toBe(400)
      expect(yield* Effect.promise(() => invalid.text())).toContain("Write tool access must be enabled or cleared")

      const readOnly = yield* patch("turenlabs/sentry", "enabled")
      expect(readOnly.status).toBe(400)
      expect(yield* Effect.promise(() => readOnly.text())).toContain("Undeclared configuration: writeTools")
    }),
  )

  it.instance(
    "ignores workspace skill files outside the managed Extension catalog",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* request(HttpApiApp.webHandler(), "/extension", tmp.directory)
        const items = yield* json<
          Array<{
            manifest: { id: string; name: string; contributions: Array<{ source?: { type: string } }> }
            origin: string
            mutable: boolean
            enabled: boolean
          }>
        >(response)
        expect(response.status).toBe(200)
        expect(items.length).toBeGreaterThanOrEqual(ExtensionCatalog.manifests.length)
        expect(items.every((item) => item.origin === "catalog" && item.mutable)).toBe(true)
        expect(items.find((item) => item.manifest.name === "review-work")).toBeUndefined()
        expect(JSON.stringify(items)).not.toContain(tmp.directory)
      }),
    {
      init: (directory) =>
        Effect.promise(async () => {
          const skill = path.join(directory, ".forge", "skills", "review-work")
          await mkdir(skill, { recursive: true })
          await Bun.write(
            path.join(skill, "SKILL.md"),
            "---\nname: review-work\ndescription: Review the current workspace\n---\n# Review\n",
          )
        }),
    },
  )
})
