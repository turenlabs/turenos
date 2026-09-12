import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext } from "../types"
import { Scanner } from "../util/scanner"

/**
 * osv-scanner — Google's lockfile/dependency scanner backed by OSV.dev.
 *
 * Runs `osv-scanner scan source -r` over a directory, writing SARIF to a temp
 * file under ctx.cacheDir and parsing it into the shared Finding shape.
 * osv-scanner exits 1 when vulnerabilities are found — exit codes 0 and 1 are
 * both treated as success.
 *
 * A missing binary is returned as `{ installed: false, installHint }` (not
 * thrown) so agents can relay install guidance.
 */

const TOOL = "osv-scanner"
const INSTALL_HINT = "brew install osv-scanner"
const MAX_FINDINGS = 100
// Queries the OSV.dev API over the network; allow for large dependency trees.
const TIMEOUT_MS = 180_000

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 }

async function tempReportPath(ctx: IntegrationContext): Promise<string> {
  await fs.mkdir(ctx.cacheDir, { recursive: true })
  return path.join(ctx.cacheDir, `osv-scanner-${randomUUID()}.sarif`)
}

function stderrSnippet(stderr: string): string {
  const text = stderr.trim()
  if (!text) return "(no error output)"
  return text.length > 500 ? `…${text.slice(-500)}` : text
}

function normalizeFinding(finding: Finding, target: string): Finding {
  let file = finding.file?.replace(/^file:\/\//, "")
  if (file && path.isAbsolute(file)) {
    const rel = path.relative(target, file)
    if (!rel.startsWith("..")) file = rel
  }
  return { ...finding, file, tool: finding.tool ?? TOOL }
}

function scanResult(target: string, findings: Finding[]) {
  const bySeverity: Record<string, number> = {}
  for (const finding of findings) bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1
  const sorted = [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 5) - (SEVERITY_ORDER[b.severity] ?? 5))
  const capped = sorted.length > MAX_FINDINGS
  return {
    installed: true,
    tool: TOOL,
    target,
    total: findings.length,
    summary: { bySeverity },
    findings: capped ? sorted.slice(0, MAX_FINDINGS) : sorted,
    ...(capped
      ? {
          truncated: true,
          note: `showing top ${MAX_FINDINGS} of ${findings.length} findings by severity; scan a narrower path for the rest`,
        }
      : {}),
  }
}

async function scan(args: Record<string, unknown>, ctx: IntegrationContext) {
  const bin = await Scanner.which(TOOL)
  if (!bin) return { installed: false, tool: TOOL, installHint: INSTALL_HINT }

  const target = (await Scanner.resolveScanTarget(args["path"], ctx)).abs
  const report = await tempReportPath(ctx)
  try {
    const result = await Scanner.run([bin, "scan", "source", "-r", "--format", "sarif", "--output", report, target], {
      cwd: ctx.workspace,
      timeoutMs: TIMEOUT_MS,
    })
    if (result.timedOut) {
      throw new ToolError(
        `osv-scanner timed out after ${TIMEOUT_MS / 1000}s (it queries the OSV.dev API); retry, or scan a narrower path`,
      )
    }
    // Exit code 1 means vulnerabilities were found, not failure; anything
    // above 1 (e.g. no package sources found, network error) is a real error.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ToolError(`osv-scanner failed (exit code ${result.exitCode}): ${stderrSnippet(result.stderr)}`)
    }
    const sarif = await fs.readFile(report, "utf8").catch(() => undefined)
    if (sarif === undefined) {
      throw new ToolError(`osv-scanner produced no report: ${stderrSnippet(result.stderr)}`)
    }
    const findings = Scanner.parseSarif(sarif).map((finding) => normalizeFinding(finding, target))
    return scanResult(target, findings)
  } finally {
    await fs.rm(report, { force: true })
  }
}

export const OsvScanner: Integration = {
  id: "osv-scanner",
  executables: ["osv-scanner"],
  category: "tools",
  group: "dependencies",
  description: "Scan lockfiles and dependencies for known vulnerabilities using osv-scanner",
  tools: [
    {
      name: "osv_scanner_scan",
      description:
        "Run osv-scanner recursively over a directory to find known-vulnerable dependencies in lockfiles and manifests (queries the OSV.dev API). Reports { installed: false, installHint } when osv-scanner is not installed.",
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
      handler: scan,
    },
  ],
}
