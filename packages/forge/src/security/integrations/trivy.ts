import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext } from "../types"
import { Scanner } from "../util/scanner"

/**
 * trivy — filesystem / config / dependency scanner by Aqua Security.
 *
 * `trivy_scan` runs `trivy fs` (vuln/misconfig/secret/license scanners),
 * `trivy_config_scan` runs `trivy config` for IaC misconfigurations only.
 * Both write SARIF to a temp file under ctx.cacheDir and parse it into the
 * shared Finding shape.
 *
 * A missing binary is returned as `{ installed: false, installHint }` (not
 * thrown) so agents can relay install guidance.
 */

const TOOL = "trivy"
const INSTALL_HINT = "brew install trivy"
const MAX_FINDINGS = 100
// First run downloads the vulnerability DB, which can take minutes.
const TIMEOUT_MS = 300_000

const VALID_SCANNERS = ["vuln", "misconfig", "secret", "license"] as const
const DEFAULT_SCANNERS = ["vuln", "misconfig", "secret"]
/** Trivy severities, lowest to highest; a "minimum" expands to a CSV of this tail. */
const TRIVY_SEVERITIES = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 }

async function tempReportPath(ctx: IntegrationContext): Promise<string> {
  await fs.mkdir(ctx.cacheDir, { recursive: true })
  return path.join(ctx.cacheDir, `trivy-${randomUUID()}.sarif`)
}

function stderrSnippet(stderr: string): string {
  const text = stderr.trim()
  if (!text) return "(no error output)"
  return text.length > 500 ? `…${text.slice(-500)}` : text
}

function parseScannersArg(raw: unknown): string[] {
  if (raw === undefined) return DEFAULT_SCANNERS
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    throw new ToolError(`"scanners" must be an array of strings`)
  }
  const scanners = raw as string[]
  for (const scanner of scanners) {
    if (!(VALID_SCANNERS as readonly string[]).includes(scanner)) {
      throw new ToolError(`unknown scanner "${scanner}"; valid scanners: ${VALID_SCANNERS.join(", ")}`)
    }
  }
  if (scanners.length === 0) throw new ToolError(`"scanners" must not be empty`)
  return scanners
}

/** Expand a minimum severity ("HIGH") to trivy's exact-match CSV ("HIGH,CRITICAL"). */
function parseSeverityArg(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string") throw new ToolError(`"severity" must be a string`)
  const min = raw.trim().toUpperCase()
  const index = TRIVY_SEVERITIES.indexOf(min)
  if (index < 0) {
    throw new ToolError(`unknown severity "${raw}"; valid values: ${TRIVY_SEVERITIES.join(", ")}`)
  }
  return TRIVY_SEVERITIES.slice(index).join(",")
}

function normalizeFinding(finding: Finding, target: string): Finding {
  let file = finding.file?.replace(/^file:\/\//, "")
  if (file && path.isAbsolute(file)) {
    const rel = path.relative(target, file)
    if (!rel.startsWith("..")) file = rel
  }
  return { ...finding, file, tool: finding.tool ?? TOOL }
}

function scanResult(tool: string, target: string, findings: Finding[]) {
  const bySeverity: Record<string, number> = {}
  for (const finding of findings) bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1
  const sorted = [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5))
  const capped = sorted.length > MAX_FINDINGS
  return {
    installed: true,
    tool,
    target,
    total: findings.length,
    summary: { bySeverity },
    findings: capped ? sorted.slice(0, MAX_FINDINGS) : sorted,
    ...(capped
      ? {
          truncated: true,
          note: `showing top ${MAX_FINDINGS} of ${findings.length} findings by severity; scan a narrower path or raise the severity filter for the rest`,
        }
      : {}),
  }
}

async function runTrivy(label: string, argv: string[], report: string, target: string, ctx: IntegrationContext) {
  try {
    // trivy exits 0 in this mode even when it finds issues (no --exit-code),
    // so a non-zero exit is a real failure.
    const result = await Scanner.run(argv, { cwd: ctx.workspace, timeoutMs: TIMEOUT_MS })
    if (result.timedOut) {
      throw new ToolError(
        `trivy timed out after ${TIMEOUT_MS / 1000}s (the first run downloads a vulnerability DB); retry, or scan a narrower path`,
      )
    }
    const sarif = await fs.readFile(report, "utf8").catch(() => undefined)
    if (result.exitCode !== 0 || sarif === undefined) {
      throw new ToolError(`trivy failed (exit code ${result.exitCode}): ${stderrSnippet(result.stderr)}`)
    }
    const findings = Scanner.parseSarif(sarif).map((finding) => normalizeFinding(finding, target))
    return scanResult(label, target, findings)
  } finally {
    await fs.rm(report, { force: true })
  }
}

async function fsScan(args: Record<string, unknown>, ctx: IntegrationContext) {
  const bin = await Scanner.which(TOOL)
  if (!bin) return { installed: false, tool: TOOL, installHint: INSTALL_HINT }

  const target = (await Scanner.resolveScanTarget(args["path"], ctx)).abs
  const scanners = parseScannersArg(args["scanners"])
  const severity = parseSeverityArg(args["severity"])
  const report = await tempReportPath(ctx)
  const argv = [
    bin,
    "fs",
    "--scanners",
    scanners.join(","),
    "--format",
    "sarif",
    "--output",
    report,
    ...(severity ? ["--severity", severity] : []),
    target,
  ]
  return runTrivy("trivy fs", argv, report, target, ctx)
}

async function configScan(args: Record<string, unknown>, ctx: IntegrationContext) {
  const bin = await Scanner.which(TOOL)
  if (!bin) return { installed: false, tool: TOOL, installHint: INSTALL_HINT }

  const target = (await Scanner.resolveScanTarget(args["path"], ctx)).abs
  const report = await tempReportPath(ctx)
  const argv = [bin, "config", "--format", "sarif", "--output", report, target]
  return runTrivy("trivy config", argv, report, target, ctx)
}

export const Trivy: Integration = {
  id: "trivy",
  executables: ["trivy"],
  category: "tools",
  // Genuinely spans groups (vuln/dependency, misconfig/iac, secret scanners all
  // live under `trivy_scan`), but its default scanner set leads with `vuln` and
  // it sits alongside grype/osv-scanner/native-audit as a vulnerability scanner
  // first; dedicated IaC (checkov) and secrets (gitleaks) tools cover those axes.
  group: "dependencies",
  description: "Scan the workspace for vulnerabilities and misconfigurations using trivy",
  tools: [
    {
      name: "trivy_scan",
      description:
        "Run a trivy filesystem scan (vulnerabilities, misconfigurations, secrets, licenses) over a directory. The first run downloads a vulnerability DB and can take a few minutes. Reports { installed: false, installHint } when trivy is not installed.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory to scan, relative to the workspace (default: whole workspace)",
          },
          scanners: {
            type: "array",
            items: { type: "string", enum: ["vuln", "misconfig", "secret", "license"] },
            description: 'Scanners to enable (default: ["vuln", "misconfig", "secret"])',
          },
          severity: {
            type: "string",
            description: 'Minimum severity to report, e.g. "HIGH" (UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL; optional)',
          },
        },
        additionalProperties: false,
      },
      handler: fsScan,
    },
    {
      name: "trivy_config_scan",
      description:
        "Run trivy in IaC/config-only mode to find misconfigurations in Terraform, Kubernetes, Dockerfiles, etc. Reports { installed: false, installHint } when trivy is not installed.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory to scan, relative to the workspace (default: whole workspace)",
          },
        },
        additionalProperties: false,
      },
      handler: configScan,
    },
  ],
}
