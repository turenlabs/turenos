import { describe, expect, test } from "bun:test"
import { Extension } from "@turenlabs/schema"
import { ExtensionCatalog, ExtensionManifestPolicy } from "@turenlabs/extensions"
import { Schema } from "effect"

const expected = [
  "turenlabs/atlassian-security-context",
  "turenlabs/attack",
  "turenlabs/automox",
  "turenlabs/automox-local",
  "turenlabs/bandit",
  "turenlabs/batou",
  "turenlabs/certfr-misp",
  "turenlabs/chainguard-docs",
  "turenlabs/checkov",
  "turenlabs/circl-hashlookup",
  "turenlabs/cloudflare-audit-logs",
  "turenlabs/cloudflare-casb",
  "turenlabs/crowdstrike-falcon",
  "turenlabs/customize-forge",
  "turenlabs/cwe",
  "turenlabs/d3fend",
  "turenlabs/datadog-malicious",
  "turenlabs/datadog-security",
  "turenlabs/depsdev",
  "turenlabs/elastic-security",
  "turenlabs/epss",
  "turenlabs/euvd",
  "turenlabs/exploitdb",
  "turenlabs/ghsa",
  "turenlabs/github-security",
  "turenlabs/gitlab-devsecops",
  "turenlabs/gitleaks",
  "turenlabs/grafana-cloud-security",
  "turenlabs/grype",
  "turenlabs/gtfobins",
  "turenlabs/hibp",
  "turenlabs/incident-io",
  "turenlabs/jfrog-xray",
  "turenlabs/kev",
  "turenlabs/linear",
  "turenlabs/lolbas",
  "turenlabs/microsoft-graph-enterprise",
  "turenlabs/microsoft-sentinel",
  "turenlabs/native-audit",
  "turenlabs/notion",
  "turenlabs/nvd",
  "turenlabs/onepassword",
  "turenlabs/opengrep",
  "turenlabs/osv",
  "turenlabs/osv-scanner",
  "turenlabs/pagerduty",
  "turenlabs/phishing-database",
  "turenlabs/scorecard",
  "turenlabs/semgrep-hosted",
  "turenlabs/sentry",
  "turenlabs/socket",
  "turenlabs/sonarqube-cloud-security",
  "turenlabs/tenable",
  "turenlabs/tor-exit",
  "turenlabs/trivy",
  "turenlabs/tweetfeed",
  "turenlabs/websearch-exa",
  "turenlabs/websearch-parallel",
  "turenlabs/yolk",
]

const decode = Schema.decodeUnknownSync(Extension.Manifest)
const remoteContribution = (input: object = {}) => ({
  type: "mcp",
  id: "search",
  name: "Acme Search",
  description: "Search an Acme workspace",
  instructions: "Use search before requesting a workspace mutation.",
  adapter: "mcp:search",
  secrets: [],
  defaultEnabled: false,
  upstreamPolicy: "static",
  deployment: { type: "hosted", url: "https://mcp.acme.example/mcp" },
  authentication: "none",
  localOnly: false,
  tools: { allow: ["search"], write: [] },
  ...input,
})
const remoteManifest = (input: object = {}) =>
  decode({
    schemaVersion: 1,
    id: "acme/search",
    name: "Acme Search",
    description: "Search an Acme workspace",
    version: "1.0.0",
    publisher: "Acme",
    trust: "community",
    contributions: [remoteContribution()],
    ...input,
  })

describe("ExtensionCatalog", () => {
  test("ships Yolk as an opt-in native change intelligence tool", () => {
    const manifest = ExtensionCatalog.get("turenlabs/yolk")
    const contribution = manifest?.contributions[0]

    expect(manifest?.name).toBe("Yolk Change Intelligence")
    expect(contribution).toMatchObject({
      type: "tool",
      adapter: "builtin:yolk",
      defaultEnabled: false,
      commands: [],
      tools: { allow: ["inspect_change"], write: [] },
    })
  })

  test("contains the complete Extension v1 built-in catalog", () => {
    expect(ExtensionCatalog.manifests.map((item) => String(item.id)).toSorted()).toEqual(expected)
    expect(new Set(ExtensionCatalog.manifests.map((item) => item.id)).size).toBe(expected.length)
  })

  test("uses one unique runtime adapter per contribution", () => {
    const contributions = ExtensionCatalog.manifests.flatMap((manifest) => manifest.contributions)
    expect(new Set(contributions.map((item) => item.adapter)).size).toBe(contributions.length)
    expect(contributions.every((item) => item.secrets.every((secret) => /^[A-Z][A-Z0-9_]*$/.test(secret.id)))).toBe(
      true,
    )
  })

  test("keeps every Data contribution read-only", () => {
    const data = ExtensionCatalog.manifests.flatMap((manifest) =>
      manifest.contributions.filter((contribution) => contribution.type === "data"),
    )
    expect(data.length).toBeGreaterThan(0)
    expect(data.every((contribution) => contribution.tools.write.length === 0)).toBe(true)
  })

  test("rejects invalid or duplicate executable declarations", () => {
    const grype = ExtensionCatalog.get("turenlabs/grype")!
    const contribution = grype.contributions[0]!
    if (contribution.type !== "tool") throw new Error("Expected Grype to be a tool contribution")
    for (const commands of [["grype", "grype"], [" grype"]]) {
      expect(() =>
        ExtensionManifestPolicy.validateManifestPolicy(
          new Extension.Manifest({
            ...grype,
            contributions: [{ ...contribution, commands }],
          }),
        ),
      ).toThrow("executable declaration")
    }
  })

  test("derives write confirmation actions from MCP manifests", () => {
    expect(ExtensionCatalog.writeToolActions).not.toContain("onepassword_create_environment")
    expect(ExtensionCatalog.writeToolActions).toContain("notion_notion-create-pages")
    expect(ExtensionCatalog.writeToolActions).toContain("forge-security_linear_call")
    expect(ExtensionCatalog.writeToolActions).not.toContain("notion_notion-search")
  })

  test("pins the sole audited dynamic upstream policy to Linear's exact broker boundary", () => {
    const linear = ExtensionCatalog.get("turenlabs/linear")!
    const contribution = linear.contributions[0]!
    if (contribution.type !== "mcp") throw new Error("Expected Linear to be an MCP contribution")
    expect(() => ExtensionManifestPolicy.validateManifestPolicy(linear)).not.toThrow()

    for (const mutation of [
      { adapter: "security:not-linear" },
      { deployment: { type: "hosted" as const, url: "https://attacker.example/mcp" } },
      { authentication: "oauth" as const },
      { localOnly: false },
      { secrets: [] },
      { tools: { allow: ["linear_tools"], write: [] } },
      { tools: { allow: ["linear_tools", "linear_call"], write: [] } },
      { upstreamPolicy: "static" as const },
    ]) {
      expect(() =>
        ExtensionManifestPolicy.validateManifestPolicy(
          new Extension.Manifest({
            ...linear,
            contributions: [{ ...contribution, ...mutation }],
          }),
        ),
      ).toThrow()
    }
  })

  test("permits generic remote MCP manifest contributions", () => {
    expect(() => ExtensionManifestPolicy.validateManifestPolicy(remoteManifest())).not.toThrow()
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({
          contributions: [
            remoteContribution({
              deployment: { type: "customer-url", path: "/mcp", privateNetwork: true },
              authentication: "oauth",
              localOnly: true,
            }),
          ],
        }),
      ),
    ).not.toThrow()
  })

  test("permits prompt-only catalog skills and fixed-profile subagents", () => {
    const manifest = new Extension.Manifest({
      schemaVersion: 1,
      id: Extension.ID.make("community", "incident-responder"),
      name: "Incident Responder",
      description: "Read-only incident response",
      version: "1.0.0",
      publisher: "Community",
      trust: "community",
      contributions: [
        {
          type: "skill",
          id: Extension.ContributionID.make("incident-responder"),
          name: "Incident Responder",
          description: "Review supplied evidence",
          instructions: "Use for defensive incident review.",
          adapter: "skill:incident-responder",
          secrets: [],
          defaultEnabled: false,
          source: { type: "catalog", content: "Review supplied evidence without changing files." },
          requires: ["read", "grep"],
          agent: { profile: "read", steps: 8 },
        },
      ],
    })
    expect(() => ExtensionManifestPolicy.validateManifestPolicy(manifest)).not.toThrow()

    const contribution = manifest.contributions[0]!
    if (contribution.type !== "skill") throw new Error("Expected skill contribution")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        new Extension.Manifest({
          ...manifest,
          contributions: [{ ...contribution, id: Extension.ContributionID.make("build"), adapter: "skill:build" }],
        }),
      ),
    ).toThrow("reserved id")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        new Extension.Manifest({
          ...manifest,
          contributions: [{ ...contribution, source: { type: "embedded", name: "privileged" } }],
        }),
      ),
    ).toThrow("prompt-only")
  })

  test("rejects unaudited runtime authority in manifest-only contributions", () => {
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({
          contributions: [
            remoteContribution({ deployment: { type: "local", command: "malware", platforms: ["linux"] } }),
          ],
        }),
      ),
    ).toThrow("cannot execute a local MCP command")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({ contributions: [remoteContribution({ authentication: "key" })] }),
      ),
    ).toThrow("cannot inject MCP credentials")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({ contributions: [remoteContribution({ adapter: "forge-security" })] }),
      ),
    ).toThrow("must use its generic MCP adapter")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({
          contributions: [remoteContribution({ tools: { allow: ["search"], write: ["delete-everything"] } })],
        }),
      ),
    ).toThrow("write tool is not allowed")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({
          contributions: [remoteContribution(), remoteContribution({ id: "second", adapter: "mcp:second" })],
        }),
      ),
    ).not.toThrow()
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({
          contributions: [remoteContribution({ tools: { allow: ["search", "delete-all"], write: [] } })],
        }),
      ),
    ).toThrow("mutating tool must be declared writable")
    expect(() => ExtensionManifestPolicy.validateManifestPolicy(remoteManifest({ trust: "official" }))).toThrow(
      "Only the turenlabs namespace",
    )
  })

  test("assigns each catalog secret to one audited extension", () => {
    expect(() => ExtensionManifestPolicy.validateCatalogPolicy(ExtensionCatalog.manifests)).not.toThrow()
    const ghsa = ExtensionCatalog.get("turenlabs/ghsa")!
    const nvd = ExtensionCatalog.get("turenlabs/nvd")!
    expect(() =>
      ExtensionManifestPolicy.validateCatalogPolicy([
        ghsa,
        new Extension.Manifest({
          ...nvd,
          contributions: [
            {
              ...nvd.contributions[0]!,
              secrets: [{ id: "GITHUB_TOKEN", label: "Duplicate", required: false }],
            },
          ],
        }),
      ]),
    ).toThrow("declared by both")
  })

  test("keeps Sentinel's two runtime identities and broker policies distinct", () => {
    const sentinel = ExtensionCatalog.get("turenlabs/microsoft-sentinel")!
    expect(sentinel.contributions.map((item) => String(item.id))).toEqual([
      "microsoft-sentinel-data-exploration",
      "microsoft-sentinel-triage",
    ])
    expect(sentinel.contributions.map((item) => item.adapter)).toEqual([
      "mcp:microsoft-sentinel-data-exploration",
      "mcp:microsoft-sentinel-triage",
    ])
    expect(sentinel.contributions.map((item) => (item.type === "mcp" ? item.mcpContext?.maxLoadedTools : 0))).toEqual([
      3, 8,
    ])
  })

  test("requires PagerDuty's pre-registered OAuth client fields", () => {
    const pagerduty = ExtensionCatalog.get("turenlabs/pagerduty")!.contributions[0]
    expect(pagerduty).toMatchObject({
      type: "mcp",
      configuration: [{ id: "clientId", required: true }],
      secrets: [{ id: "PAGERDUTY_CLIENT_SECRET", required: true }],
      connection: { oauth: { clientId: "clientId", clientSecret: "PAGERDUTY_CLIENT_SECRET" } },
    })
  })

  test("permits reviewed credential bindings only for declared official MCP fields", () => {
    const pagerduty = ExtensionCatalog.get("turenlabs/pagerduty")!
    const pagerdutyMcp = pagerduty.contributions[0]
    const sonarqube = ExtensionCatalog.get("turenlabs/sonarqube-cloud-security")!
    const sonarqubeMcp = sonarqube.contributions[0]
    if (pagerdutyMcp?.type !== "mcp" || sonarqubeMcp?.type !== "mcp") {
      throw new Error("Expected MCP contributions")
    }

    expect(() => ExtensionManifestPolicy.validateManifestPolicy(pagerduty)).not.toThrow()
    expect(() => ExtensionManifestPolicy.validateManifestPolicy(sonarqube)).not.toThrow()
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        new Extension.Manifest({
          ...pagerduty,
          contributions: [
            {
              ...pagerdutyMcp,
              connection: {
                oauth: { clientId: Extension.ConfigurationID.make("clientId"), clientSecret: "UNDECLARED_SECRET" },
              },
            },
          ],
        }),
      ),
    ).toThrow("client secret is not declared")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        new Extension.Manifest({
          ...sonarqube,
          contributions: [
            {
              ...sonarqubeMcp,
              connection: {
                headers: [
                  { name: "Authorization", secret: "SONARQUBE_TOKEN", prefix: "Bearer " },
                  {
                    name: "X-Sonar-Organization",
                    configuration: Extension.ConfigurationID.make("missingOrganization"),
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toThrow("header configuration must be required")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({
          contributions: [
            remoteContribution({
              connection: { headers: [{ name: "X-Workspace", configuration: "workspace" }] },
            }),
          ],
        }),
      ),
    ).toThrow("cannot inject MCP connection credentials")
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        new Extension.Manifest({
          ...sonarqube,
          contributions: [
            {
              ...sonarqubeMcp,
              connection: {
                headers: [{ name: "Authorization", secret: "SONARQUBE_TOKEN", prefix: "Bearer\r\n" }],
              },
            },
          ],
        }),
      ),
    ).toThrow("header prefix")
  })

  test("pins the new security MCP allowlists to read-only tool names", () => {
    const expectedPolicies = {
      "turenlabs/datadog-security": [
        "get_datadog_incident",
        "search_datadog_incidents",
        "search_datadog_logs",
        "search_datadog_monitors",
        "get_datadog_trace",
        "search_datadog_spans",
        "search_datadog_security_signals",
        "analyze_datadog_security_signals",
        "get_datadog_security_signal",
        "security_findings_schema",
        "search_datadog_security_findings",
      ],
      "turenlabs/microsoft-graph-enterprise": [
        "microsoft_graph_suggest_queries",
        "microsoft_graph_get",
        "microsoft_graph_list_properties",
      ],
      "turenlabs/jfrog-xray": [
        "xray_artifact_get_summary",
        "xray_artifact_get_violations",
        "xray_artifact_security_status",
        "xray_sbom_search_impacted_resources",
        "catalog_vulnerabilities_get",
        "catalog_packages_versions_vulnerabilities",
        "catalog_packages_list_versions",
        "catalog_packages_get",
        "artifactory_builds_list_builds",
        "artifactory_builds_list_build_runs",
        "artifactory_builds_get_info",
      ],
      "turenlabs/sonarqube-cloud-security": [
        "search_sonar_issues_in_projects",
        "search_security_hotspots",
        "show_security_hotspot",
        "get_project_quality_gate_status",
        "list_quality_gates",
        "show_rule",
      ],
      "turenlabs/elastic-security": [
        "security.alerts",
        "security.attack_discovery_search",
        "security.entity_risk_score",
        "security.get_entity",
        "security.search_entities",
        "platform.core.cases",
        "observability.get_alerts",
        "observability.get_logs",
        "observability.get_traces",
      ],
    }

    for (const [id, allow] of Object.entries(expectedPolicies)) {
      const contribution = ExtensionCatalog.get(id)?.contributions[0]
      expect(contribution?.type).toBe("mcp")
      if (contribution?.type !== "mcp") continue
      expect(contribution.tools).toEqual({ allow, write: [] })
    }
  })

  test("ships Automox as a pinned one-click read-only MCP package", () => {
    const hosted = ExtensionCatalog.get("turenlabs/automox")?.contributions[0]
    expect(hosted).toMatchObject({
      type: "mcp",
      id: "automox",
      authentication: "key",
      deployment: { type: "hosted", url: "https://console.automox.com/api/mcp" },
      connection: {
        headers: [{ name: "Authorization", secret: "AUTOMOX_HOSTED_API_KEY", prefix: "Bearer " }],
      },
      tools: { write: [] },
    })
    const manifest = ExtensionCatalog.get("turenlabs/automox-local")
    const contribution = manifest?.contributions[0]
    expect(contribution).toMatchObject({
      type: "mcp",
      id: "automox-local",
      authentication: "key",
      localOnly: true,
      deployment: { type: "local", command: "uvx", platforms: ["darwin", "linux", "win32"] },
      tools: { write: [] },
    })
    if (contribution?.type !== "mcp") throw new Error("Automox MCP contribution is missing")
    expect(contribution.tools.allow).toHaveLength(85)
    expect(contribution.secrets.map((secret) => secret.id)).toEqual(["AUTOMOX_API_KEY", "AUTOMOX_ACCOUNT_UUID"])
  })

  test("pins hosted security MCP endpoints, authentication, and reviewed tool policies", () => {
    const expectedPolicies = {
      "turenlabs/chainguard-docs": {
        url: "https://mcp.edu.chainguard.dev/mcp",
        authentication: "none",
        localOnly: false,
        allow: [
          "search_docs",
          "get_image_docs",
          "list_images",
          "get_security_docs",
          "get_tool_docs",
          "find_package_equivalent",
          "check_image_freshness",
        ],
        write: [],
      },
      "turenlabs/semgrep-hosted": {
        url: "https://mcp.semgrep.ai/mcp",
        authentication: "none",
        localOnly: false,
        allow: [
          "security_check",
          "semgrep_scan",
          "semgrep_scan_with_custom_rule",
          "semgrep_findings",
          "get_abstract_syntax_tree",
        ],
        write: ["security_check", "semgrep_scan", "semgrep_scan_with_custom_rule", "get_abstract_syntax_tree"],
      },
      "turenlabs/socket": {
        url: "https://mcp.socket.dev/",
        authentication: "oauth",
        localOnly: true,
        allow: ["depscore", "organizations", "alerts", "threat_feed", "package_files"],
        write: [],
      },
      "turenlabs/tenable": {
        url: "https://cloud.tenable.com/mcp/",
        authentication: "key",
        localOnly: true,
        allow: [
          "asset_search",
          "tenable_one_search_assets",
          "tagging_create_tag",
          "tagging_add_tags_assets",
          "ticket_create_issue",
          "ticket_notify_assignees",
        ],
        write: ["tagging_create_tag", "tagging_add_tags_assets", "ticket_create_issue", "ticket_notify_assignees"],
      },
    } as const

    for (const [id, policy] of Object.entries(expectedPolicies)) {
      const contribution = ExtensionCatalog.get(id)?.contributions[0]
      expect(contribution?.type).toBe("mcp")
      if (contribution?.type !== "mcp" || contribution.deployment.type !== "hosted") continue
      expect(contribution).toMatchObject({
        adapter: `mcp:${contribution.id}`,
        upstreamPolicy: "static",
        authentication: policy.authentication,
        localOnly: policy.localOnly,
        deployment: { type: "hosted", url: policy.url },
        mcpContext: { unloadAfterIdleTurns: 3 },
        tools: { allow: [...policy.allow], write: [...policy.write] },
      })
    }

    expect(ExtensionCatalog.writeToolActions).toEqual(
      expect.arrayContaining([
        "semgrep-hosted_security_check",
        "semgrep-hosted_semgrep_scan",
        "semgrep-hosted_semgrep_scan_with_custom_rule",
        "semgrep-hosted_get_abstract_syntax_tree",
      ]),
    )
    expect(ExtensionCatalog.writeToolActions).not.toContain("semgrep-hosted_semgrep_findings")
    expect(ExtensionCatalog.get("turenlabs/semgrep-hosted")?.contributions[0]?.instructions).toContain(
      "require explicit approval",
    )
    expect(ExtensionCatalog.get("turenlabs/tenable")?.contributions[0]).toMatchObject({
      secrets: [{ id: "TENABLE_API_KEYS", required: true }],
      connection: { headers: [{ name: "X-ApiKeys", secret: "TENABLE_API_KEYS" }] },
    })
  })

  test("rejects unsafe declarative MCP endpoints", () => {
    for (const url of [
      "http://mcp.acme.example/mcp",
      "https://user:password@mcp.acme.example/mcp",
      "https://127.0.0.1/mcp",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(() =>
        ExtensionManifestPolicy.validateManifestPolicy(
          remoteManifest({ contributions: [remoteContribution({ deployment: { type: "hosted", url } })] }),
        ),
      ).toThrow()
    }
    expect(() =>
      ExtensionManifestPolicy.validateManifestPolicy(
        remoteManifest({
          contributions: [
            remoteContribution({
              deployment: { type: "customer-url", path: "//attacker.example/mcp", privateNetwork: true },
            }),
          ],
        }),
      ),
    ).toThrow("absolute URL path")
  })
})
