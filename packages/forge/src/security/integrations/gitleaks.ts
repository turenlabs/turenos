import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext } from "../types"
import { Scanner } from "../util/scanner"

/**
 * gitleaks — secret scanning for repos and directories.
 *
 * Two tools: `gitleaks_scan` scans a directory as plain files (`gitleaks dir`),
 * `gitleaks_scan_history` scans full git history (`gitleaks git`). Both write
 * a SARIF report to a temp file under ctx.cacheDir, parse it into Findings,
 * and redact matched secret values — only rule + file + line survive.
 *
 * A missing binary is returned as `{ installed: false, installHint }` (not
 * thrown) so agents can relay install guidance.
 */

const TOOL = "gitleaks"
const INSTALL_HINT = "brew install gitleaks"
const MAX_FINDINGS = 100
const TIMEOUT_MS = 120_000

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 }

async function tempReportPath(ctx: IntegrationContext): Promise<string> {
  await fs.mkdir(ctx.cacheDir, { recursive: true })
  return path.join(ctx.cacheDir, `gitleaks-${randomUUID()}.sarif`)
}

function stderrSnippet(stderr: string): string {
  const text = stderr.trim()
  if (!text) return "(no error output)"
  return text.length > 500 ? `…${text.slice(-500)}` : text
}

/**
 * Gitleaks SARIF messages can contain the matched secret value. Replace the
 * message wholesale and keep only rule + location + severity.
 */
function redact(finding: Finding, target: string): Finding {
  let file = finding.file?.replace(/^file:\/\//, "")
  if (file && path.isAbsolute(file)) {
    const rel = path.relative(target, file)
    if (!rel.startsWith("..")) file = rel
  }
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    message: "[REDACTED]",
    file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    tool: finding.tool ?? TOOL,
  }
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
          note: `showing top ${MAX_FINDINGS} of ${findings.length} findings by severity; scan a narrower path for the rest`,
        }
      : {}),
  }
}

async function runGitleaks(mode: "dir" | "git", args: Record<string, unknown>, ctx: IntegrationContext) {
  const bin = await Scanner.which(TOOL)
  if (!bin) return { installed: false, tool: TOOL, installHint: INSTALL_HINT }

  const target = (await Scanner.resolveScanTarget(args["path"], ctx)).abs
  const report = await tempReportPath(ctx)
  try {
    // --exit-code 0 makes gitleaks exit 0 even when leaks are found, so any
    // non-zero exit is a real failure.
    const result = await Scanner.run(
      [bin, mode, target, "--report-format", "sarif", "--report-path", report, "--exit-code", "0"],
      { cwd: ctx.workspace, timeoutMs: TIMEOUT_MS },
    )
    if (result.timedOut) {
      throw new ToolError(`gitleaks timed out after ${TIMEOUT_MS / 1000}s; scan a narrower path`)
    }
    const sarif = await fs.readFile(report, "utf8").catch(() => undefined)
    if (result.exitCode !== 0 || sarif === undefined) {
      throw new ToolError(`gitleaks failed (exit code ${result.exitCode}): ${stderrSnippet(result.stderr)}`)
    }
    const findings = Scanner.parseSarif(sarif).map((finding) => redact(finding, target))
    return scanResult(mode === "git" ? "gitleaks git" : "gitleaks dir", target, findings)
  } finally {
    await fs.rm(report, { force: true })
  }
}

export const Gitleaks: Integration = {
  id: "gitleaks",
  executables: ["gitleaks"],
  category: "tools",
  group: "secrets",
  description: "Scan the workspace for committed secrets using gitleaks",
  tools: [
    {
      name: "gitleaks_scan",
      description:
        "Run gitleaks secret detection over a directory as plain files (defaults to the workspace). Returns findings with secret values redacted (rule + file + line only). Reports { installed: false, installHint } when gitleaks is not installed.",
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
      handler: (args, ctx) => runGitleaks("dir", args, ctx),
    },
    {
      name: "gitleaks_scan_history",
      description:
        "Run gitleaks over the full git history of a repository (defaults to the workspace; the path must be a git repo). Returns findings with secret values redacted (rule + file + line only). Reports { installed: false, installHint } when gitleaks is not installed.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Git repository to scan, relative to the workspace (default: the workspace itself)",
          },
        },
        additionalProperties: false,
      },
      handler: (args, ctx) => runGitleaks("git", args, ctx),
    },
  ],
}
