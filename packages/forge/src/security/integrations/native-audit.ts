import path from "node:path"
import fs from "node:fs/promises"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext, type Severity } from "../types"
import { Scanner, type RunResult } from "../util/scanner"

/**
 * native-audit — run each ecosystem's own dependency auditor over the target
 * directory and normalize results to the shared Finding shape.
 *
 * Detected ecosystems (skipped when their manifest is absent):
 * - node:   package.json + a lockfile      -> `npm audit --json`
 * - python: requirements.txt / pyproject.toml -> `pip-audit -f json [-r requirements.txt]`
 * - rust:   Cargo.lock                     -> `cargo audit --json`
 * - go:     go.mod                         -> `govulncheck -format json ./...`
 *
 * A missing auditor never fails the whole call: each ecosystem entry reports
 * `{ auditorInstalled: false, installHint }` instead, so the caller can decide
 * whether to install it.
 */

const MAX_FINDINGS = 100

const ECOSYSTEMS = ["node", "python", "rust", "go"] as const
type EcosystemName = (typeof ECOSYSTEMS)[number]

interface EcosystemResult {
  name: EcosystemName
  auditor: string
  auditorInstalled: boolean
  installHint?: string
  /** Auditor ran but failed in a way that produced no usable report. */
  error?: string
  findings?: Finding[]
  /** Full finding count before capping. */
  total?: number
  note?: string
  /** Subprocess output hit the capture cap; results may be incomplete. */
  outputTruncated?: boolean
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  unknown: 5,
}

function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

function countBySeverity(findings: Finding[]): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {}
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1
  return counts
}

function normalizeSeverity(value: unknown): Severity {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "critical":
      return "critical"
    case "high":
      return "high"
    case "moderate":
    case "medium":
      return "medium"
    case "low":
      return "low"
    case "info":
    case "informational":
      return "info"
    default:
      return "unknown"
  }
}

/** Drop undefined/null/empty values so serialized findings stay compact. */
function compact(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== "")
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function tail(text: string, max = 400): string {
  return text.trim().slice(-max)
}

function firstLine(text: string | undefined, max = 200): string {
  if (!text) return ""
  const line = text.split("\n", 1)[0]?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max)}...` : line
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

function ecosystemArg(raw: unknown): EcosystemName | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === "string" && (ECOSYSTEMS as readonly string[]).includes(raw)) return raw as EcosystemName
  throw new ToolError(`"ecosystem" must be one of: ${ECOSYSTEMS.join(", ")}`)
}

function runFailure(auditor: string, result: RunResult): string {
  if (result.timedOut) return `${auditor} timed out after ${Math.round(result.durationMs / 1000)}s`
  return `${auditor} produced no parseable JSON (exit ${result.exitCode}): ${tail(result.stderr) || tail(result.stdout) || "no output"}`
}

// ---------------------------------------------------------------------------
// node: npm audit --json
// ---------------------------------------------------------------------------

interface NpmVia {
  source?: number | string
  title?: string
  url?: string
  severity?: string
  range?: string
  cvss?: { score?: number }
}

interface NpmVulnerability {
  severity?: string
  via?: (NpmVia | string)[]
  fixAvailable?: boolean | { name?: string; version?: string }
}

interface NpmAuditReport {
  error?: { code?: string; summary?: string }
  vulnerabilities?: Record<string, NpmVulnerability>
  // npm v6 fallback shape
  advisories?: Record<
    string,
    { module_name?: string; severity?: string; title?: string; url?: string; github_advisory_id?: string }
  >
}

function npmAdvisoryId(url: string | undefined, source: number | string | undefined): string {
  const match = url?.match(/GHSA-[a-z0-9-]+/i)
  if (match) return match[0]
  return source !== undefined ? String(source) : "npm-advisory"
}

function npmFixSummary(fix: NpmVulnerability["fixAvailable"]): string | undefined {
  if (fix === true) return "fix available"
  if (fix && typeof fix === "object") return `fix: ${fix.name ?? "upgrade"}@${fix.version ?? "latest"}`
  return undefined
}

const NODE_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]

async function auditNode(target: string): Promise<EcosystemResult | undefined> {
  if (!(await exists(path.join(target, "package.json")))) return undefined
  let hasLock = false
  for (const lock of NODE_LOCKFILES) {
    if (await exists(path.join(target, lock))) {
      hasLock = true
      break
    }
  }
  if (!hasLock) return undefined

  const base: EcosystemResult = { name: "node", auditor: "npm audit", auditorInstalled: false }
  const npm = await Scanner.which("npm")
  if (!npm) return { ...base, installHint: "npm ships with Node.js: https://nodejs.org" }
  base.auditorInstalled = true

  // npm audit exits non-zero when vulnerabilities are found; any exit with
  // parseable JSON counts as success.
  const result = await Scanner.run([npm, "audit", "--json"], { cwd: target, timeoutMs: 120_000 })
  const report = Scanner.parseJsonOutput<NpmAuditReport>(result.stdout)
  if (!report) return { ...base, error: runFailure("npm audit", result) }
  if (report.error) {
    return { ...base, error: `npm audit failed: ${report.error.summary ?? report.error.code ?? "unknown error"}` }
  }

  const findings: Finding[] = []
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // string entries are references to other vulnerable packages; the
      // advisory itself appears as an object on the source package.
      if (typeof via !== "object" || via === null) continue
      findings.push({
        ruleId: npmAdvisoryId(via.url, via.source),
        severity: normalizeSeverity(via.severity ?? vuln.severity),
        message: `${pkg}${via.range ? ` ${via.range}` : ""}: ${via.title ?? "known vulnerability"}`,
        tool: "npm-audit",
        extra: compact({ package: pkg, url: via.url, cvss: via.cvss?.score, fix: npmFixSummary(vuln.fixAvailable) }),
      })
    }
  }
  if (findings.length === 0 && report.advisories) {
    for (const advisory of Object.values(report.advisories)) {
      findings.push({
        ruleId: advisory.github_advisory_id ?? npmAdvisoryId(advisory.url, undefined),
        severity: normalizeSeverity(advisory.severity),
        message: `${advisory.module_name ?? "package"}: ${advisory.title ?? "known vulnerability"}`,
        tool: "npm-audit",
        extra: compact({ url: advisory.url }),
      })
    }
  }
  return { ...base, findings, ...(result.truncated ? { outputTruncated: true } : {}) }
}

// ---------------------------------------------------------------------------
// python: pip-audit -f json [-r requirements.txt]
// ---------------------------------------------------------------------------

interface PipAuditVuln {
  id?: string
  description?: string
  fix_versions?: string[]
  aliases?: string[]
}

interface PipAuditDep {
  name?: string
  version?: string
  vulns?: PipAuditVuln[]
}

interface PipAuditReport {
  dependencies?: PipAuditDep[]
}

async function auditPython(target: string): Promise<EcosystemResult | undefined> {
  const hasRequirements = await exists(path.join(target, "requirements.txt"))
  if (!hasRequirements && !(await exists(path.join(target, "pyproject.toml")))) return undefined

  const base: EcosystemResult = { name: "python", auditor: "pip-audit", auditorInstalled: false }
  const bin = await Scanner.which("pip-audit")
  if (!bin) return { ...base, installHint: "pip install pip-audit" }
  base.auditorInstalled = true

  const argv = hasRequirements ? [bin, "-f", "json", "-r", "requirements.txt"] : [bin, "-f", "json"]
  const result = await Scanner.run(argv, { cwd: target, timeoutMs: 300_000 })
  const report = Scanner.parseJsonOutput<PipAuditReport | PipAuditDep[]>(result.stdout)
  if (!report) return { ...base, error: runFailure("pip-audit", result) }

  const deps = Array.isArray(report) ? report : Array.isArray(report.dependencies) ? report.dependencies : []
  const findings: Finding[] = []
  for (const dep of deps) {
    for (const vuln of dep.vulns ?? []) {
      findings.push({
        ruleId: vuln.id ?? "pip-audit",
        // pip-audit JSON output carries no severity; use the data integrations
        // (osv/epss) to enrich by id.
        severity: "unknown",
        message:
          `${dep.name ?? "package"} ${dep.version ?? ""}: ${firstLine(vuln.description) || "known vulnerability"}`.trim(),
        tool: "pip-audit",
        extra: compact({
          package: dep.name,
          version: dep.version,
          fixVersions: vuln.fix_versions?.length ? vuln.fix_versions : undefined,
          aliases: vuln.aliases?.length ? vuln.aliases.slice(0, 5) : undefined,
        }),
      })
    }
  }
  return { ...base, findings, ...(result.truncated ? { outputTruncated: true } : {}) }
}

// ---------------------------------------------------------------------------
// rust: cargo audit --json
// ---------------------------------------------------------------------------

interface CargoAdvisory {
  id?: string
  title?: string
  severity?: string
  cvss?: string
  url?: string
}

interface CargoVulnerability {
  advisory?: CargoAdvisory
  package?: { name?: string; version?: string }
  versions?: { patched?: string[] }
}

interface CargoAuditReport {
  vulnerabilities?: { count?: number; list?: CargoVulnerability[] }
  warnings?: Record<string, unknown[]>
}

async function auditRust(target: string): Promise<EcosystemResult | undefined> {
  if (!(await exists(path.join(target, "Cargo.lock")))) return undefined

  const base: EcosystemResult = { name: "rust", auditor: "cargo audit", auditorInstalled: false }
  const cargo = await Scanner.which("cargo")
  if (!cargo) return { ...base, installHint: "install Rust (https://rustup.rs), then: cargo install cargo-audit" }
  // cargo-audit is a cargo subcommand; probe for it before the real run.
  const probe = await Scanner.run([cargo, "audit", "--version"], { cwd: target, timeoutMs: 30_000 })
  if (probe.exitCode !== 0) return { ...base, installHint: "cargo install cargo-audit" }
  base.auditorInstalled = true

  const result = await Scanner.run([cargo, "audit", "--json"], { cwd: target, timeoutMs: 300_000 })
  const report = Scanner.parseJsonOutput<CargoAuditReport>(result.stdout)
  if (!report) return { ...base, error: runFailure("cargo audit", result) }

  const findings: Finding[] = []
  for (const vuln of report.vulnerabilities?.list ?? []) {
    const advisory = vuln.advisory ?? {}
    findings.push({
      ruleId: advisory.id ?? "rustsec-advisory",
      severity: normalizeSeverity(advisory.severity),
      message:
        `${vuln.package?.name ?? "crate"} ${vuln.package?.version ?? ""}: ${advisory.title ?? "known vulnerability"}`.trim(),
      tool: "cargo-audit",
      extra: compact({
        package: vuln.package?.name,
        version: vuln.package?.version,
        patched: vuln.versions?.patched?.length ? vuln.versions.patched : undefined,
        cvss: advisory.cvss,
        url: advisory.url,
      }),
    })
  }
  const warningCount = Object.values(report.warnings ?? {}).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0,
  )
  return {
    ...base,
    findings,
    ...(warningCount > 0 ? { note: `${warningCount} non-vulnerability warnings (unmaintained/yanked) omitted` } : {}),
    ...(result.truncated ? { outputTruncated: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// go: govulncheck -format json ./...
// ---------------------------------------------------------------------------

interface GovulncheckMessage {
  osv?: { id?: string; summary?: string; aliases?: string[] }
  finding?: {
    osv?: string
    fixed_version?: string
    trace?: { module?: string; package?: string; function?: string }[]
  }
}

/**
 * govulncheck streams concatenated pretty-printed JSON objects. Accumulate
 * lines and parse whenever a top-level closing brace (or a whole one-line
 * object) completes a candidate.
 */
function parseJsonStream(text: string): GovulncheckMessage[] {
  const messages: GovulncheckMessage[] = []
  let buffer: string[] = []
  for (const line of text.split("\n")) {
    buffer.push(line)
    const trimmed = line.trim()
    const closes = trimmed === "}" || (buffer.length === 1 && trimmed.startsWith("{") && trimmed.endsWith("}"))
    if (!closes) continue
    try {
      messages.push(JSON.parse(buffer.join("\n")) as GovulncheckMessage)
      buffer = []
    } catch {
      // not complete yet; keep accumulating
    }
  }
  return messages
}

async function auditGo(target: string): Promise<EcosystemResult | undefined> {
  if (!(await exists(path.join(target, "go.mod")))) return undefined

  const base: EcosystemResult = { name: "go", auditor: "govulncheck", auditorInstalled: false }
  const bin = await Scanner.which("govulncheck")
  if (!bin) return { ...base, installHint: "go install golang.org/x/vuln/cmd/govulncheck@latest" }
  base.auditorInstalled = true

  // Builds the module, so this can take minutes. Exit 3 = vulns found.
  const result = await Scanner.run([bin, "-format", "json", "./..."], { cwd: target, timeoutMs: 300_000 })
  if (result.timedOut) return { ...base, error: "govulncheck timed out after 5 minutes" }
  if (result.exitCode !== 0 && result.exitCode !== 3) {
    return {
      ...base,
      error: `govulncheck failed (exit ${result.exitCode}): ${tail(result.stderr) || tail(result.stdout) || "no output"}`,
    }
  }

  const osvById = new Map<string, NonNullable<GovulncheckMessage["osv"]>>()
  const affected = new Map<string, { called: boolean; module?: string; fixed?: string }>()
  for (const message of parseJsonStream(result.stdout)) {
    if (message.osv?.id) osvById.set(message.osv.id, message.osv)
    const finding = message.finding
    if (!finding?.osv) continue
    const entry = affected.get(finding.osv) ?? { called: false }
    const frame = finding.trace?.[0]
    if (frame?.function) entry.called = true
    entry.module ??= frame?.module
    entry.fixed ??= finding.fixed_version
    affected.set(finding.osv, entry)
  }

  const findings: Finding[] = []
  for (const [id, info] of affected) {
    const detail = osvById.get(id)
    findings.push({
      ruleId: id,
      severity: "unknown",
      message: `${info.module ?? "module"}: ${detail?.summary ?? "known vulnerability"}`,
      tool: "govulncheck",
      extra: compact({
        // true = a vulnerable function is actually reached, not just imported
        called: info.called,
        fixedVersion: info.fixed,
        aliases: detail?.aliases?.length ? detail.aliases.slice(0, 5) : undefined,
      }),
    })
  }
  return { ...base, findings, ...(result.truncated ? { outputTruncated: true } : {}) }
}

// ---------------------------------------------------------------------------
// integration
// ---------------------------------------------------------------------------

const RUNNERS: readonly [EcosystemName, (target: string) => Promise<EcosystemResult | undefined>][] = [
  ["node", auditNode],
  ["python", auditPython],
  ["rust", auditRust],
  ["go", auditGo],
]

async function nativeDependencyAudit(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const target = await Scanner.resolveScanTarget(args["path"], ctx)
  if (!target.isDirectory) throw new ToolError(`"path" is not a directory in the workspace: ${target.rel}`)
  const filter = ecosystemArg(args["ecosystem"])

  const ecosystems: EcosystemResult[] = []
  for (const [name, runner] of RUNNERS) {
    if (filter && filter !== name) continue
    const result = await runner(target.abs)
    if (result) ecosystems.push(result)
  }
  if (ecosystems.length === 0) {
    throw new ToolError(
      `no ${filter ?? "supported"} ecosystem detected in ${target.rel}; ` +
        "looked for package.json + lockfile, requirements.txt/pyproject.toml, Cargo.lock, go.mod",
    )
  }

  const all = ecosystems.flatMap((eco) => eco.findings ?? [])
  const withFindings = ecosystems.filter((eco) => eco.findings !== undefined)
  const cap = Math.max(10, Math.floor(MAX_FINDINGS / Math.max(1, withFindings.length)))
  for (const eco of withFindings) {
    const sorted = sortBySeverity(eco.findings ?? [])
    eco.total = sorted.length
    if (sorted.length > cap) {
      eco.findings = sorted.slice(0, cap)
      eco.note = [eco.note, `showing top ${cap} of ${sorted.length} findings by severity`].filter(Boolean).join("; ")
    } else {
      eco.findings = sorted
    }
  }

  return {
    tool: "native-audit",
    target: target.rel,
    ecosystems,
    total: all.length,
    summary: { bySeverity: countBySeverity(all) },
  }
}

export const NativeAudit: Integration = {
  id: "native-audit",
  executables: ["npm", "pip-audit", "cargo", "govulncheck"],
  category: "tools",
  group: "dependencies",
  description:
    "Run each ecosystem's own dependency audit (npm audit, pip-audit, cargo audit, govulncheck) and normalize results",
  tools: [
    {
      name: "native_dependency_audit",
      description:
        "Detect the ecosystems present in a directory (package.json + lockfile, requirements.txt/pyproject.toml, Cargo.lock, go.mod) " +
        "and run each one's native dependency auditor: npm audit, pip-audit, cargo audit, govulncheck. " +
        "Auditors that are not installed are reported per-ecosystem with an install hint instead of failing. " +
        "The go audit builds the module and can take a few minutes.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project directory, relative to the workspace (default: workspace root)",
          },
          ecosystem: {
            type: "string",
            enum: [...ECOSYSTEMS],
            description: "Only audit this ecosystem instead of all detected ones (optional)",
          },
        },
        additionalProperties: false,
      },
      handler: nativeDependencyAudit,
    },
  ],
}
