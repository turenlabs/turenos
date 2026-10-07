import { describe, expect, test } from "bun:test"
import type { ExtensionContribution, ExtensionItem } from "@turenlabs/sdk/v2/client"
import {
  catalogHomepage,
  extensionAction,
  extensionCategory,
  extensionCategoryLabel,
  dataForgeExtension,
  directOAuthConnect,
  extensionTabs,
  extensionWriteTools,
  filterExtensionItems,
  selectedExtensionTab,
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
  endpoints: { api: "https://api.osv.dev/v1" },
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
  defaultEnabled: false,
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

describe("Extend tabs", () => {
  test("offers installed, disabled scanners through the Tools tab and existing enable action", () => {
    expect(extensionTabs).toMatchObject({ tools: { label: "Tools", kind: "tool" } })
    const scanner = { ...tool, installed: true }
    const tab = selectedExtensionTab("tools", undefined)
    expect(tab).toBe("tools")
    const visible = filterExtensionItems([data, mcp, scanner, yolk], {
      installed: false,
      kind: extensionTabs[tab].kind,
      search: "",
    })
    expect(visible).toEqual([scanner])
    expect(extensionAction(visible[0], {})).toEqual({
      label: "Enable",
      missingRequired: false,
      payload: { enabled: true },
    })
    expect(scanner.enabled).toBe(false)
  })

  test.each([
    ["skills", "skill"],
    ["mcp", "mcp"],
    ["data", "data"],
    ["tools", "tool"],
  ] as const)("maps the %s tab and legacy kind query to %s contributions", (tab, kind) => {
    expect(selectedExtensionTab(tab, undefined)).toBe(tab)
    expect(selectedExtensionTab(undefined, kind)).toBe(tab)
    expect(extensionTabs[tab].kind).toBe(kind)
  })

  test("defaults unknown or missing queries to Skills / Subagents", () => {
    expect(selectedExtensionTab(undefined, undefined)).toBe("skills")
    expect(selectedExtensionTab("unknown", "unknown")).toBe("skills")
  })

  test("keeps installed scanners discoverable with Tools search, focus, and status filters", () => {
    const scanner = { ...tool, installed: true }
    const missing = { ...tool, installed: false }
    const enabled = { ...scanner, enabled: true, status: "available" as const }
    const options = {
      installed: true,
      kind: extensionTabs.tools.kind,
      search: "gitleaks",
      category: "application-security" as const,
      status: "available" as const,
    }
    expect(filterExtensionItems([scanner, missing, enabled, data, mcp, yolk], options)).toEqual([scanner])
    expect(filterExtensionItems([scanner, enabled], { ...options, status: "connected" })).toEqual([enabled])
    expect(extensionAction(enabled, {})).toEqual({
      label: "Disable",
      missingRequired: false,
      payload: { enabled: false },
    })
  })

  test("lists missing scanner commands in the catalog without allowing installation or write opt-in", () => {
    const scanner = { ...tool, installed: false }
    const visible = filterExtensionItems([scanner, data, mcp, yolk], {
      installed: false,
      kind: extensionTabs.tools.kind,
      search: "",
    })
    expect(visible).toEqual([scanner])
    expect(extensionAction(visible[0], { "turenlabs/gitleaks:writeTools": "enabled" })).toEqual({
      label: "Not installed",
      missingRequired: false,
      blocked: true,
      payload: { enabled: false },
    })
    expect(
      extensionAction({ ...scanner, installed: true }, { "turenlabs/gitleaks:writeTools": "enabled" })?.payload,
    ).toEqual({ enabled: true })
  })

  test("keeps settings-owned Yolk hidden in both Tools views even when enabled", () => {
    const enabled = { ...yolk, installed: true, enabled: true, status: "available" as const }
    expect(filterExtensionItems([enabled], { installed: false, kind: extensionTabs.tools.kind, search: "" })).toEqual(
      [],
    )
    expect(filterExtensionItems([enabled], { installed: true, kind: extensionTabs.tools.kind, search: "" })).toEqual([])
  })
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
        ["turenlabs/capec", "security-knowledge"],
        ["turenlabs/mcp-security-review", "application-security"],
        ["turenlabs/slsa-provenance-review", "supply-chain"],
        ["turenlabs/agentic-prompt-injection-review", "application-security"],
        ["turenlabs/oauth-security-review", "application-security"],
        ["turenlabs/tenant-isolation-review", "application-security"],
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
      ["security-knowledge", "security-knowledge"],
      ["application-security", "application-security"],
      ["supply-chain", "supply-chain"],
      ["application-security", "application-security"],
      ["application-security", "application-security"],
      ["application-security", "application-security"],
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

  test("sends the write-tool opt-in only for MCP extensions that declare write tools", () => {
    const base = mcp.manifest.contributions[0]
    if (base.type !== "mcp") throw new Error("Expected MCP fixture")
    const writable: ExtensionItem = {
      ...mcp,
      manifest: {
        ...mcp.manifest,
        contributions: [
          { ...base, tools: { allow: ["notion-search", "notion-update-page"], write: ["notion-update-page"] } },
        ],
      },
    }
    expect(extensionWriteTools(writable)).toEqual(["notion-update-page"])
    expect(extensionAction(writable, { "turenlabs/notion:writeTools": "enabled" })?.payload).toEqual({
      enabled: true,
      configuration: { writeTools: "enabled" },
    })
    expect(extensionAction(writable, { "turenlabs/notion:writeTools": "" })?.payload).toEqual({
      enabled: true,
      configuration: { writeTools: "" },
    })
    expect(extensionWriteTools(mcp)).toEqual([])
    expect(extensionAction(mcp, { "turenlabs/notion:writeTools": "enabled" })?.payload).toEqual({ enabled: false })
  })

  test("installs hosted MCP manifests", () => {
    const external = { ...mcp, enabled: false, installed: false }
    expect(extensionAction(external, {})).toMatchObject({
      label: "Install & Enable",
      payload: { enabled: true, manifest: external.manifest },
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

  test("offers a reconnect for a failed-but-enabled extension, not just Disable", () => {
    const failed = { ...mcp, status: "failed" as const }
    expect(extensionAction(failed, {})).toEqual({
      label: "Retry",
      missingRequired: false,
      payload: { enabled: true, connect: true },
    })
    // A draft still takes precedence — saving new values reconciles anyway.
    const base = mcp.manifest.contributions[0]
    if (!base || base.type !== "mcp") throw new Error("Expected MCP fixture")
    const writable = {
      ...failed,
      manifest: {
        ...failed.manifest,
        contributions: [{ ...base, tools: { allow: ["notion-search", "notion-update"], write: ["notion-update"] } }],
      },
    }
    expect(extensionAction(writable, { "turenlabs/notion:writeTools": "enabled" })?.label).toBe("Save")
    // Failed while disabled stays an ordinary Enable.
    expect(extensionAction({ ...mcp, enabled: false, status: "failed" }, {})?.label).toBe("Enable")
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

describe("catalogHomepage", () => {
  test("allows credential-free HTTP links and rejects active or local schemes", () => {
    expect(catalogHomepage("https://docs.example.test/mcp")).toBe("https://docs.example.test/mcp")
    expect(catalogHomepage("http://localhost:8080/docs")).toBe("http://localhost:8080/docs")
    expect(catalogHomepage("https://user:secret@docs.example.test")).toBeUndefined()
    expect(catalogHomepage("javascript:alert(document.domain)")).toBeUndefined()
    expect(catalogHomepage("file:///etc/passwd")).toBeUndefined()
  })
})
