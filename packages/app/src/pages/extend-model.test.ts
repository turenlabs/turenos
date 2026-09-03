import { describe, expect, test } from "bun:test"
import type { ExtensionContribution, ExtensionItem } from "@turenlabs/sdk/v2/client"
import {
  extensionAction,
  extensionCategory,
  extensionCategoryLabel,
  dataForgeExtension,
  directOAuthConnect,
  filterExtensionItems,
  sortExtensionItems,
} from "./extend-model"
import { yolkExtension } from "@/utils/extension-surface"

const item = (id: string, contribution: ExtensionContribution, enabled = false): ExtensionItem => ({
  manifest: {
    schemaVersion: 1,
    id: `turenlabs/${id}`,
    name: contribution.name,
    description: contribution.description,
    version: "1.0.0",
    publisher: "Turen Labs",
    trust: "official",
    contributions: [contribution],
  },
  origin: "catalog",
  mutable: true,
  enabled,
  status: enabled ? "available" : "disabled",
  secretsSet: {},
  configurationSet: {},
})

const data = item("osv", {
  type: "data",
  id: "osv",
  name: "OSV",
  description: "Open source vulnerabilities",
  instructions: "Use OSV for vulnerability research.",
  adapter: "security:osv",
  secrets: [],
  tools: { allow: [], write: [] },
  defaultEnabled: true,
})
const mcp = item(
  "notion",
  {
    type: "mcp",
    id: "notion",
    name: "Notion",
    description: "Workspace pages",
    instructions: "Search before editing pages.",
    adapter: "mcp:notion",
    secrets: [],
    defaultEnabled: false,
    upstreamPolicy: "static",
    deployment: { type: "hosted", url: "https://mcp.notion.com/mcp" },
    authentication: "oauth",
    localOnly: true,
    tools: { allow: ["notion-search"], write: [] },
  },
  true,
)

const tool = item("gitleaks", {
  type: "tool",
  id: "gitleaks",
  name: "Gitleaks",
  description: "Secret scanning",
  instructions: "Scan only the selected workspace.",
  adapter: "security:gitleaks",
  secrets: [],
  commands: ["gitleaks"],
  configuration: [],
  tools: { allow: [], write: [] },
  defaultEnabled: true,
})

const yolk = item("yolk", {
  type: "tool",
  id: "yolk",
  name: "Yolk Change Intelligence",
  description: "Semantic change intelligence",
  instructions: "Inspect before edits and compare after writes.",
  adapter: "builtin:yolk",
  secrets: [],
  group: "code-intelligence",
  commands: [],
  configuration: [],
  tools: { allow: ["inspect_change"], write: [] },
  defaultEnabled: false,
})

describe("filterExtensionItems", () => {
  test("uses reviewed manifest IDs for security focus without inferring unknown entries", () => {
    const sentinel = { ...mcp, manifest: { ...mcp.manifest, id: "turenlabs/microsoft-sentinel" } }
    const unknown = { ...mcp, manifest: { ...mcp.manifest, id: "constructor" } }

    expect(
      [
        ["turenlabs/microsoft-sentinel", "security-operations"],
        ["turenlabs/datadog-security", "security-operations"],
        ["turenlabs/elastic-security", "security-operations"],
        ["turenlabs/atlassian-security-context", "incident-response"],
        ["turenlabs/cloudflare-casb", "cloud-security"],
        ["turenlabs/github-security", "application-security"],
        ["turenlabs/gitlab-devsecops", "application-security"],
        ["turenlabs/sonarqube-cloud-security", "application-security"],
        ["turenlabs/jfrog-xray", "supply-chain"],
        ["turenlabs/microsoft-graph-enterprise", "identity-access"],
        ["turenlabs/grafana-cloud-security", "observability"],
        ["turenlabs/incident-io", "incident-response"],
        ["turenlabs/sentry", "observability"],
      ].map(([id, category]) => [extensionCategory({ ...sentinel, manifest: { ...sentinel.manifest, id } }), category]),
    ).toEqual([
      ["security-operations", "security-operations"],
      ["security-operations", "security-operations"],
      ["security-operations", "security-operations"],
      ["incident-response", "incident-response"],
      ["cloud-security", "cloud-security"],
      ["application-security", "application-security"],
      ["application-security", "application-security"],
      ["application-security", "application-security"],
      ["supply-chain", "supply-chain"],
      ["identity-access", "identity-access"],
      ["observability", "observability"],
      ["incident-response", "incident-response"],
      ["observability", "observability"],
    ])
    expect(extensionCategory({ ...sentinel, manifest: { ...sentinel.manifest, id: "turenlabs/euvd" } })).toBe(
      "vulnerability-intelligence",
    )
    expect(extensionCategory({ ...sentinel, manifest: { ...sentinel.manifest, id: "turenlabs/tweetfeed" } })).toBe(
      "threat-intelligence",
    )
    expect(extensionCategory({ ...sentinel, manifest: { ...sentinel.manifest, id: "turenlabs/attack" } })).toBe(
      "security-knowledge",
    )
    expect(extensionCategory(unknown)).toBe("other")
    expect(
      filterExtensionItems([unknown], {
        installed: false,
        kind: "mcp",
        search: "",
        category: "other",
      }),
    ).toEqual([unknown])
    expect(extensionCategoryLabel("security-operations")).toBe("Security Operations / SIEM & Detection")
  })

  test("composes focus and status filters with kind and search", () => {
    const github = {
      ...mcp,
      enabled: false,
      status: "available" as const,
      manifest: { ...mcp.manifest, id: "turenlabs/github-security", name: "GitHub Security" },
    }
    const sentinel = {
      ...mcp,
      enabled: true,
      manifest: { ...mcp.manifest, id: "turenlabs/microsoft-sentinel", name: "Microsoft Sentinel" },
    }
    const pagerduty = {
      ...mcp,
      enabled: true,
      status: "needs-auth" as const,
      manifest: { ...mcp.manifest, id: "turenlabs/pagerduty", name: "PagerDuty" },
    }

    expect(
      filterExtensionItems([github, sentinel], {
        installed: false,
        kind: "mcp",
        search: "security",
        category: "application-security",
        status: "available",
      }),
    ).toEqual([github])
    expect(
      filterExtensionItems([github, sentinel, pagerduty], {
        installed: false,
        kind: "mcp",
        search: "",
        category: "security-operations",
        status: "connected",
      }),
    ).toEqual([sentinel])
    expect(
      filterExtensionItems([github, sentinel, pagerduty], {
        installed: false,
        kind: "mcp",
        search: "",
        category: "incident-response",
        status: "needs-attention",
      }),
    ).toEqual([pagerduty])
  })

  test("sorts without mutating or losing runtime state", () => {
    const sentry = {
      ...mcp,
      enabled: true,
      status: "connected" as const,
      secretsSet: { SENTRY_TOKEN: true },
      manifest: { ...mcp.manifest, id: "turenlabs/sentry", name: "Sentry" },
    }
    const github = {
      ...mcp,
      enabled: false,
      status: "available" as const,
      manifest: { ...mcp.manifest, id: "turenlabs/github-security", name: "GitHub Security" },
    }
    const items = [sentry, github]

    expect(sortExtensionItems(items, "category")).toEqual([github, sentry])
    expect(sortExtensionItems(items, "recommended")).toEqual([github, sentry])
    expect(sortExtensionItems(items, "status")).toEqual([sentry, github])
    expect(sortExtensionItems(items, "alphabetical")).toEqual([github, sentry])
    expect(items).toEqual([sentry, github])
    expect(sortExtensionItems(items, "status")[0]).toBe(sentry)
  })

  test("General Settings owns Yolk, so Extend never lists it", () => {
    expect(yolkExtension([tool, yolk])).toBe(yolk)
    expect(filterExtensionItems([tool, yolk], { installed: false, kind: "all", search: "" })).toEqual([tool])
    expect(
      filterExtensionItems([{ ...yolk, enabled: true }], { installed: true, kind: "all", search: "yolk" }),
    ).toEqual([])
  })

  test("Data carries only security data contributions", () => {
    expect(filterExtensionItems([data, mcp, tool], { installed: false, kind: "data", search: "" })).toEqual([data])
    expect(dataForgeExtension(data)).toBe(true)
    expect(
      dataForgeExtension({
        ...data,
        manifest: {
          ...data.manifest,
          contributions: [{ ...data.manifest.contributions[0]!, adapter: "websearch:exa" }],
        },
      }),
    ).toBe(false)
  })

  test("filters by contribution kind", () => {
    expect(filterExtensionItems([data, mcp], { installed: false, kind: "mcp", search: "" })).toEqual([mcp])
  })

  test("Installed contains enabled extensions only", () => {
    expect(filterExtensionItems([data, mcp], { installed: true, kind: "all", search: "" })).toEqual([mcp])
  })

  test("searches manifest metadata without inspecting skill content or secrets", () => {
    expect(filterExtensionItems([data, mcp], { installed: false, kind: "all", search: "vulnerabilities" })).toEqual([
      data,
    ])
    expect(filterExtensionItems([data, mcp], { installed: false, kind: "all", search: "notion-search" })).toEqual([])
  })

  test("keeps configured and discovered instances out of the distributable catalog", () => {
    const configured = { ...mcp, origin: "configuration" as const, mutable: false, enabled: false }
    expect(filterExtensionItems([data, configured], { installed: false, kind: "all", search: "" })).toEqual([data])
    expect(filterExtensionItems([data, configured], { installed: true, kind: "all", search: "" })).toEqual([configured])
  })

  test("keeps needs-auth credential saves enabled", () => {
    const linear = item(
      "linear",
      {
        type: "mcp",
        id: "linear",
        name: "Linear",
        description: "Issues",
        instructions: "Search before changing issues.",
        adapter: "security:linear",
        secrets: [{ id: "LINEAR_API_KEY", label: "API key", required: true }],
        defaultEnabled: false,
        upstreamPolicy: "audited-linear-dynamic-v1",
        deployment: { type: "hosted", url: "https://example.test" },
        authentication: "key",
        localOnly: true,
        tools: { allow: ["linear_call"], write: ["linear_call"] },
      },
      true,
    )
    linear.status = "needs-auth"
    expect(extensionAction(linear, {})).toMatchObject({ label: "Connect", missingRequired: true })
    expect(extensionAction(linear, { "turenlabs/linear:LINEAR_API_KEY": "key" })).toEqual({
      label: "Connect",
      missingRequired: false,
      payload: { enabled: true, connect: true, secrets: { LINEAR_API_KEY: "key" } },
    })
  })

  test("directly connects only fieldless hosted OAuth extensions that need auth", () => {
    const needsAuth = { ...mcp, status: "needs-auth" as const }
    const contribution = needsAuth.manifest.contributions[0]
    if (contribution?.type !== "mcp") throw new Error("Expected MCP fixture")
    expect(directOAuthConnect(needsAuth)).toBe(true)
    expect(directOAuthConnect({ ...needsAuth, status: "available" })).toBe(false)
    expect(
      directOAuthConnect({
        ...needsAuth,
        manifest: {
          ...needsAuth.manifest,
          contributions: [
            {
              ...contribution,
              configuration: [{ id: "tenant", label: "Tenant", required: true }],
            },
          ],
        },
      }),
    ).toBe(false)
  })

  test("builds customer endpoint save payloads without disabling active extensions", () => {
    const customer = {
      ...mcp,
      manifest: {
        ...mcp.manifest,
        contributions: [
          {
            ...mcp.manifest.contributions[0]!,
            deployment: { type: "customer-url" as const, path: "/mcp", privateNetwork: true },
          },
        ],
      },
    }
    expect(extensionAction(customer, { "turenlabs/notion:endpoint": "https://mcp.internal.example" })).toEqual({
      label: "Save",
      missingRequired: false,
      payload: { enabled: true, configuration: { endpoint: "https://mcp.internal.example" } },
    })
  })

  test("installs external hosted MCP manifests and offers later updates", () => {
    const external = { ...mcp, enabled: false, installed: false }
    expect(extensionAction(external, {})).toMatchObject({
      label: "Install & Enable",
      payload: { enabled: true, manifest: external.manifest },
    })
    const update = { ...mcp, installed: true, updateAvailable: true }
    expect(extensionAction(update, {})).toMatchObject({
      label: "Update",
      payload: { enabled: true, manifest: update.manifest },
    })
  })

  test("aggregates configuration and secrets across multiple MCP contributions", () => {
    const base = mcp.manifest.contributions[0]
    if (base.type !== "mcp") throw new Error("Expected MCP fixture")
    const multi: ExtensionItem = {
      ...mcp,
      enabled: false,
      status: "disabled",
      manifest: {
        ...mcp.manifest,
        id: "turenlabs/multi",
        contributions: [
          {
            ...base,
            id: "data",
            adapter: "mcp:data",
            configuration: [{ id: "tenantId", label: "Tenant", required: true }],
          },
          {
            ...base,
            id: "triage",
            adapter: "mcp:triage",
            secrets: [{ id: "CLIENT_SECRET", label: "Client secret", required: true }],
          },
        ],
      },
    }

    expect(
      extensionAction(multi, {
        "turenlabs/multi:tenantId": "tenant",
        "turenlabs/multi:CLIENT_SECRET": "secret",
      }),
    ).toEqual({
      label: "Save",
      missingRequired: false,
      payload: {
        enabled: true,
        configuration: { tenantId: "tenant" },
        secrets: { CLIENT_SECRET: "secret" },
      },
    })
    expect(filterExtensionItems([multi], { installed: false, kind: "mcp", search: "triage" })).toEqual([multi])
  })
})

describe("extensionAction", () => {
  test("installs and enables downloadable skills in one action", () => {
    const skill = item("evidence-triage", {
      type: "skill",
      id: "evidence-triage",
      name: "Evidence Triage",
      description: "Triage supplied evidence",
      instructions: "Use defensively.",
      adapter: "skill:evidence-triage",
      secrets: [],
      defaultEnabled: false,
      source: { type: "catalog", content: "Report evidence-supported findings only." },
      requires: ["read"],
    })
    const action = extensionAction({ ...skill, installed: false, status: "available" }, {})

    expect(action).toMatchObject({ label: "Install & Enable", payload: { enabled: true, manifest: skill.manifest } })
  })

  test("builds enable and disable payloads for a simple catalog tool", () => {
    expect(extensionAction(tool, {})).toEqual({
      label: "Enable",
      missingRequired: false,
      payload: { enabled: true },
    })
    expect(extensionAction({ ...tool, enabled: true, status: "available" }, {})).toEqual({
      label: "Disable",
      missingRequired: false,
      payload: { enabled: false },
    })
  })

  test("blocks local tool enablement when its command is unavailable", () => {
    expect(extensionAction({ ...tool, installed: false }, {})).toEqual({
      label: "Not installed",
      missingRequired: false,
      blocked: true,
      payload: { enabled: false },
    })
  })

  test("allows unavailable or needs-install extensions to be disabled but not enabled", () => {
    for (const status of ["unavailable", "needs-install"] as const) {
      expect(extensionAction({ ...mcp, status }, {})).toEqual({
        label: "Disable",
        missingRequired: false,
        payload: { enabled: false },
      })
      expect(extensionAction({ ...mcp, enabled: false, status }, {})).toEqual({
        label: "Enable",
        missingRequired: false,
        blocked: true,
        payload: { enabled: true },
      })
    }
  })
})
