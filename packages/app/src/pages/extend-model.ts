import type { ExtensionItem, ExtensionUpdate } from "@turenlabs/sdk/v2/client"
import { settingsOwnedExtension } from "@/utils/extension-surface"

export type ExtensionKind = "all" | "tool" | "mcp" | "data" | "skill"

export const extensionCategories = [
  { value: "all", label: "All focus areas" },
  { value: "vulnerability-intelligence", label: "Vulnerability Intelligence" },
  { value: "threat-intelligence", label: "Threat Intelligence & Reputation" },
  { value: "security-knowledge", label: "Security Knowledge" },
  { value: "software-engineering", label: "Software Engineering" },
  { value: "security-operations", label: "Security Operations / SIEM & Detection" },
  { value: "incident-response", label: "Incident Response & On-call" },
  { value: "cloud-security", label: "Cloud Security" },
  { value: "application-security", label: "Application Security & Code Review" },
  { value: "supply-chain", label: "Supply Chain / Artifact Security" },
  { value: "identity-access", label: "Identity & Access" },
  { value: "observability", label: "Observability" },
  { value: "other", label: "Developer Productivity / Other" },
] as const

export type ExtensionCategory = (typeof extensionCategories)[number]["value"]

export const extensionStatusFilters = [
  { value: "all", label: "All statuses" },
  { value: "connected", label: "Enabled / connected" },
  { value: "needs-attention", label: "Needs attention" },
  { value: "available", label: "Available / disabled" },
] as const

export type ExtensionStatusFilter = (typeof extensionStatusFilters)[number]["value"]

export const extensionSortOptions = [
  { value: "recommended", label: "Recommended" },
  { value: "category", label: "Security focus" },
  { value: "status", label: "Connection status" },
  { value: "alphabetical", label: "Name (A-Z)" },
] as const

export type ExtensionSort = (typeof extensionSortOptions)[number]["value"]

type ClassifiedExtensionCategory = Exclude<ExtensionCategory, "all">

// These are reviewed product classifications, not keywords inferred from
// manifest descriptions. Unknown external entries deliberately remain Other.
const categoryByExtensionID: Readonly<Record<string, ClassifiedExtensionCategory>> = {
  "turenlabs/euvd": "vulnerability-intelligence",
  "turenlabs/cwe": "vulnerability-intelligence",
  "turenlabs/epss": "vulnerability-intelligence",
  "turenlabs/kev": "vulnerability-intelligence",
  "turenlabs/exploitdb": "vulnerability-intelligence",
  "turenlabs/nvd": "vulnerability-intelligence",
  "turenlabs/ghsa": "vulnerability-intelligence",
  "turenlabs/osv": "vulnerability-intelligence",
  "turenlabs/attack": "security-knowledge",
  "turenlabs/d3fend": "security-knowledge",
  "turenlabs/lolbas": "security-knowledge",
  "turenlabs/gtfobins": "security-knowledge",
  "turenlabs/circl-hashlookup": "threat-intelligence",
  "turenlabs/tweetfeed": "threat-intelligence",
  "turenlabs/tor-exit": "threat-intelligence",
  "turenlabs/phishing-database": "threat-intelligence",
  "turenlabs/certfr-misp": "threat-intelligence",
  "turenlabs/datadog-malicious": "supply-chain",
  "turenlabs/evidence-triage": "incident-response",
  "turenlabs/incident-responder": "incident-response",
  "turenlabs/secret-exposure-review": "application-security",
  "turenlabs/dependency-risk-review": "supply-chain",
  "turenlabs/binary-static-snapshot": "security-knowledge",
  "turenlabs/pcap-triage": "security-operations",
  "turenlabs/threat-intel-enrichment": "threat-intelligence",
  "turenlabs/vulnerability-analyst": "vulnerability-intelligence",
  "turenlabs/malware-analyst": "security-knowledge",
  "turenlabs/cloud-security-reviewer": "cloud-security",
  "turenlabs/threat-hunter": "threat-intelligence",
  "turenlabs/secure-code-review": "application-security",
  "turenlabs/bug-root-cause": "software-engineering",
  "turenlabs/test-strategy": "software-engineering",
  "turenlabs/software-architecture-reviewer": "software-engineering",
  "turenlabs/threat-intel-brief": "threat-intelligence",
  "turenlabs/detection-engineering-review": "security-operations",
  "turenlabs/iac-config-review": "cloud-security",
  "turenlabs/incident-evidence-triage": "incident-response",
  "turenlabs/threat-model-review": "application-security",
  "turenlabs/technical-security-blog": "security-knowledge",
  "turenlabs/scorecard": "supply-chain",
  "turenlabs/microsoft-sentinel": "security-operations",
  "turenlabs/cloudflare-audit-logs": "security-operations",
  "turenlabs/datadog-security": "security-operations",
  "turenlabs/elastic-security": "security-operations",
  "turenlabs/incident-io": "incident-response",
  "turenlabs/pagerduty": "incident-response",
  "turenlabs/atlassian-security-context": "incident-response",
  "turenlabs/cloudflare-casb": "cloud-security",
  "turenlabs/checkov": "cloud-security",
  "turenlabs/github-security": "application-security",
  "turenlabs/gitlab-devsecops": "application-security",
  "turenlabs/sonarqube-cloud-security": "application-security",
  "turenlabs/batou": "application-security",
  "turenlabs/opengrep": "application-security",
  "turenlabs/bandit": "application-security",
  "turenlabs/gitleaks": "application-security",
  "turenlabs/depsdev": "supply-chain",
  "turenlabs/jfrog-xray": "supply-chain",
  "turenlabs/grype": "supply-chain",
  "turenlabs/native-audit": "supply-chain",
  "turenlabs/osv-scanner": "supply-chain",
  "turenlabs/trivy": "supply-chain",
  "turenlabs/onepassword": "identity-access",
  "turenlabs/automox-local": "security-operations",
  "turenlabs/automox": "security-operations",
  "turenlabs/crowdstrike-falcon": "security-operations",
  "turenlabs/aws-cloudtrail-local": "cloud-security",
  "turenlabs/aws-well-architected-security-local": "cloud-security",
  "turenlabs/azure-devops-local": "application-security",
  "turenlabs/endor-labs-local": "supply-chain",
  "turenlabs/semgrep-local": "application-security",
  "turenlabs/snyk-local": "application-security",
  "turenlabs/trivy-local": "supply-chain",
  "turenlabs/microsoft-graph-enterprise": "identity-access",
  "turenlabs/hibp": "identity-access",
  "turenlabs/grafana-cloud-security": "observability",
  "turenlabs/sentry": "observability",
}

export function extensionCategory(item: ExtensionItem): ClassifiedExtensionCategory {
  return Object.hasOwn(categoryByExtensionID, item.manifest.id) ? categoryByExtensionID[item.manifest.id] : "other"
}

export function extensionCategoryLabel(category: ExtensionCategory) {
  return extensionCategories.find((option) => option.value === category)?.label ?? "Developer Productivity / Other"
}

export function dataForgeExtension(item: ExtensionItem) {
  return item.manifest.contributions.some(
    (contribution) => contribution.type === "data" && contribution.adapter.startsWith("security:"),
  )
}

// The filter accepts sets for callers that intentionally combine contribution kinds.
// Providers are deliberately absent: they are configured from Settings, not Extend.
export function filterExtensionItems(
  items: ReadonlyArray<ExtensionItem>,
  input: {
    installed: boolean
    kind: ExtensionKind | ReadonlyArray<ExtensionKind>
    search: string
    category?: ExtensionCategory
    status?: ExtensionStatusFilter
  },
) {
  const kinds = Array.isArray(input.kind) ? input.kind : [input.kind as ExtensionKind]
  const anyKind = kinds.includes("all")
  const query = input.search.trim().toLowerCase()
  const category = input.category ?? "all"
  const status = input.status ?? "all"
  return items.filter((item) => {
    const contributions = item.manifest.contributions
    const contribution = contributions[0]
    if (!contribution) return false
    if (settingsOwnedExtension(item)) return false
    if (input.installed && !item.enabled && item.installed !== true && item.origin === "catalog") return false
    if (!input.installed && item.origin !== "catalog") return false
    if (!anyKind && !contributions.some((item) => kinds.includes(item.type as ExtensionKind))) return false
    if (category !== "all" && extensionCategory(item) !== category) return false
    if (!matchesExtensionStatus(item, status)) return false
    if (!query) return true
    return `${item.manifest.name} ${item.manifest.description} ${contributions
      .map((item) => `${item.name} ${item.description} ${item.id} ${item.type}`)
      .join(" ")}`
      .toLowerCase()
      .includes(query)
  })
}

export function sortExtensionItems(items: ReadonlyArray<ExtensionItem>, sort: ExtensionSort) {
  return [...items].sort((left, right) => {
    if (sort === "alphabetical") return compareExtensionNames(left, right)
    if (sort === "status") {
      return (
        extensionStatusRank(left) - extensionStatusRank(right) ||
        extensionCategoryRank(extensionCategory(left)) - extensionCategoryRank(extensionCategory(right)) ||
        compareExtensionNames(left, right)
      )
    }
    if (sort === "category") {
      return (
        extensionCategoryRank(extensionCategory(left)) - extensionCategoryRank(extensionCategory(right)) ||
        extensionTrustRank(left) - extensionTrustRank(right) ||
        compareExtensionNames(left, right)
      )
    }
    return (
      extensionTrustRank(left) - extensionTrustRank(right) ||
      extensionCategoryRank(extensionCategory(left)) - extensionCategoryRank(extensionCategory(right)) ||
      compareExtensionNames(left, right)
    )
  })
}

function matchesExtensionStatus(item: ExtensionItem, filter: ExtensionStatusFilter) {
  if (filter === "all") return true
  const connected = isConnectedExtension(item)
  if (filter === "connected") return connected
  const needsAttention = requiresExtensionAttention(item)
  if (filter === "needs-attention") return needsAttention
  return !connected && !needsAttention
}

function extensionStatusRank(item: ExtensionItem) {
  if (isConnectedExtension(item)) return 0
  if (!matchesExtensionStatus(item, "available")) return 1
  if (item.installed) return 2
  return 3
}

function isConnectedExtension(item: ExtensionItem) {
  return (
    !requiresExtensionAttention(item) && (item.enabled || item.status === "connecting" || item.status === "connected")
  )
}

function requiresExtensionAttention(item: ExtensionItem) {
  return (
    item.status === "needs-auth" ||
    item.status === "needs-config" ||
    item.status === "needs-install" ||
    item.status === "failed" ||
    item.status === "unavailable"
  )
}

function extensionCategoryRank(category: ClassifiedExtensionCategory) {
  return extensionCategories.findIndex((option) => option.value === category)
}

function extensionTrustRank(item: ExtensionItem) {
  if (item.manifest.trust === "official") return 0
  if (item.manifest.trust === "verified") return 1
  return 2
}

function compareExtensionNames(left: ExtensionItem, right: ExtensionItem) {
  return left.manifest.name.localeCompare(right.manifest.name) || left.manifest.id.localeCompare(right.manifest.id)
}

export function extensionAction(item: ExtensionItem, drafts: Readonly<Record<string, string>>) {
  const contributions = item.manifest.contributions
  if (contributions.length === 0) return undefined
  const dynamicInstall = contributions.every(
    (contribution) =>
      (contribution.type === "mcp" &&
        contribution.deployment.type === "hosted" &&
        contribution.adapter === `mcp:${contribution.id}`) ||
      (contribution.type === "skill" &&
        contribution.source.type === "catalog" &&
        contribution.adapter === `skill:${contribution.id}`),
  )
  if (item.installed === false && item.mutable && dynamicInstall) {
    return {
      payload: { enabled: true, manifest: item.manifest } as ExtensionUpdate,
      missingRequired: false,
      label: "Install & Enable",
    }
  }
  const missingLocalTool =
    !item.enabled &&
    item.installed === false &&
    contributions.some((contribution) => contribution.type === "tool" && contribution.commands.length > 0) &&
    !contributions.some((contribution) => contribution.adapter === "security:batou")
  if (missingLocalTool) {
    return {
      payload: { enabled: false } as ExtensionUpdate,
      missingRequired: false,
      blocked: true,
      label: "Not installed",
    }
  }
  const declaredSecrets = contributions.flatMap((contribution) => contribution.secrets)
  const secrets = Object.fromEntries(
    declaredSecrets.flatMap((secret) => {
      const value = drafts[`${item.manifest.id}:${secret.id}`]
      return value === undefined ? [] : [[secret.id, value]]
    }),
  )
  const endpoint = drafts[`${item.manifest.id}:endpoint`]
  const configurable = contributions.flatMap((contribution) =>
    "configuration" in contribution && Array.isArray(contribution.configuration) ? contribution.configuration : [],
  )
  const configuration = Object.fromEntries(
    configurable.flatMap((field) => {
      const value = drafts[`${item.manifest.id}:${field.id}`]
      return value === undefined ? [] : [[field.id, value]]
    }),
  )
  if (
    contributions.some(
      (contribution) => contribution.type === "mcp" && contribution.deployment.type === "customer-url",
    ) &&
    endpoint !== undefined
  ) {
    configuration.endpoint = endpoint
  }
  const hasDraft = Object.keys(secrets).length > 0 || Object.keys(configuration).length > 0
  const recovering = item.status === "needs-auth" || item.status === "needs-config"
  const enabled = recovering || hasDraft ? true : !item.enabled
  const blocked = enabled && (item.status === "unavailable" || item.status === "needs-install")
  const missingRequired =
    enabled &&
    (declaredSecrets.some((secret) => {
      if (!secret.required || item.secretsSet[secret.id]) return false
      return !secrets[secret.id]
    }) ||
      configurable.some((field) => field.required && !item.configurationSet[field.id] && !configuration[field.id]))
  const payload: ExtensionUpdate = {
    enabled,
    ...(recovering ? { connect: true } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {}),
    ...(Object.keys(configuration).length ? { configuration } : {}),
  }
  return {
    payload,
    missingRequired,
    ...(blocked ? { blocked: true } : {}),
    label: recovering ? "Connect" : hasDraft ? "Save" : item.enabled ? "Disable" : "Enable",
  }
}

export function directOAuthConnect(item: ExtensionItem) {
  return (
    item.mutable &&
    item.status === "needs-auth" &&
    item.manifest.contributions.length > 0 &&
    item.manifest.contributions.every(
      (contribution) =>
        contribution.type === "mcp" &&
        contribution.authentication === "oauth" &&
        contribution.deployment.type === "hosted" &&
        contribution.secrets.length === 0 &&
        (!contribution.configuration || contribution.configuration.length === 0),
    )
  )
}

export function catalogHomepage(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}
