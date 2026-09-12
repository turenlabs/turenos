import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext, type Severity } from "../types"
import { Scanner } from "../util/scanner"

/**
 * bandit — Python SAST scanner.
 *
 * Runs `bandit -r <path> -f sarif -o <tmpfile> --exit-zero` first; SARIF
 * output requires the optional formatter (`pip install "bandit[sarif]"`), so
 * when it is unavailable we fall back to `-f json` on stdout and map the
 * results ourselves. Python-only: a cheap directory walk short-circuits with
 * a "no Python files" note when nothing would be scanned.
 *
 * Deliberate deviation from CONVENTIONS.md (per integration spec): a missing
 * binary returns a structured `{ installed: false, installHint }` result
 * instead of throwing, so agents can relay install instructions; findings are
 * capped at 100 (not 50) with a truncation note.
 */

const BANDIT_HINT = 'pip install "bandit[sarif]"'
const BANDIT_TIMEOUT_MS = 180_000
const MAX_FINDINGS = 100
/** Directory-entry budget for the cheap Python check before assuming Python exists. */
const PY_SCAN_BUDGET = 5_000

const SEVERITY_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1, unknown: 0 }
const MIN_SEVERITIES = ["low", "medium", "high"] as const

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", ".venv", "env", "dist", "build"])

type Target = Scanner.ScanTarget

function notInstalled(tool: string, installHint: string) {
  return {
    tool,
    installed: false,
    installHint,
    note: `"${tool}" is not installed or not on PATH. Install it with: ${installHint}`,
  }
}

function stderrSnippet(text: string): string {
  const trimmed = text.trim()
  return trimmed ? trimmed.slice(0, 400) : "(no stderr output)"
}

/** Strip a file:// scheme and the scanned root prefix from a finding's file path. */
function cleanFile(file: string | undefined, base: string): string | undefined {
  if (!file) return undefined
  let out = file
  if (out.startsWith("file://")) {
    out = out.slice("file://".length)
    try {
      out = decodeURI(out)
    } catch {
      // keep the encoded form
    }
  }
  if (out === base) return path.basename(out)
  if (out.startsWith(base + path.sep)) return out.slice(base.length + 1)
  return out
}

function report(tool: string, target: Target, findings: Finding[], extra: Record<string, unknown> = {}) {
  for (const finding of findings)
    finding.file = cleanFile(finding.file, target.isDirectory ? target.abs : path.dirname(target.abs))
  const bySeverity: Partial<Record<Severity, number>> = {}
  for (const finding of findings) bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1
  const top = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]).slice(0, MAX_FINDINGS)
  return {
    tool,
    installed: true,
    target: target.rel,
    total: findings.length,
    summary: { bySeverity },
    findings: top,
    ...(findings.length > top.length
      ? { note: `truncated to the ${top.length} most severe of ${findings.length} findings` }
      : {}),
    ...extra,
  }
}

/**
 * Cheap breadth-first check for .py files. Skips vendored/derived dirs and
 * hidden dirs; when the entry budget runs out, assumes Python may exist and
 * lets bandit decide (never a false "no Python" on huge trees).
 */
async function containsPythonFiles(root: string): Promise<boolean> {
  const queue = [root]
  let visited = 0
  while (queue.length) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > PY_SCAN_BUDGET) return true
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name))
      } else if (entry.name.endsWith(".py")) {
        return true
      }
    }
  }
  return false
}

// Minimal bandit `-f json` shapes — only what the fallback mapping reads.
interface BanditJsonResult {
  filename?: string
  issue_severity?: string
  issue_confidence?: string
  issue_text?: string
  test_id?: string
  test_name?: string
  line_number?: number
  line_range?: number[]
}

interface BanditJson {
  results?: BanditJsonResult[]
}

const BANDIT_SEVERITY: Record<string, Severity> = { HIGH: "high", MEDIUM: "medium", LOW: "low" }

function mapJsonResult(result: BanditJsonResult): Finding {
  const lineRange = Array.isArray(result.line_range) ? result.line_range : []
  return {
    ruleId: result.test_id ?? result.test_name ?? "bandit",
    severity: BANDIT_SEVERITY[result.issue_severity?.toUpperCase() ?? ""] ?? "unknown",
    message: result.issue_text ?? "",
    file: result.filename,
    startLine: result.line_number,
    endLine: lineRange.length ? lineRange[lineRange.length - 1] : undefined,
    tool: "bandit",
    ...(result.issue_confidence ? { extra: { confidence: result.issue_confidence } } : {}),
  }
}

async function banditScan(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const minSeverity = args.severity
  if (minSeverity !== undefined && !MIN_SEVERITIES.includes(minSeverity as (typeof MIN_SEVERITIES)[number]))
    throw new ToolError(`"severity" must be one of: ${MIN_SEVERITIES.join(", ")}`)
  const target = await Scanner.resolveScanTarget(args.path, ctx)

  const bin = await Scanner.which("bandit")
  if (!bin) return notInstalled("bandit", BANDIT_HINT)

  const hasPython = target.isDirectory ? await containsPythonFiles(target.abs) : target.abs.endsWith(".py")
  if (!hasPython)
    return {
      tool: "bandit",
      installed: true,
      target: target.rel,
      total: 0,
      findings: [],
      note: "no Python files under the target path; bandit only scans Python",
    }

  let findings: Finding[] | undefined
  let format: "sarif" | "json" = "sarif"
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-bandit-"))
  try {
    const outFile = path.join(tmpdir, "bandit.sarif")
    const sarifRun = await Scanner.run([bin, "-r", target.abs, "-f", "sarif", "-o", outFile, "--exit-zero", "-q"], {
      cwd: ctx.workspace,
      timeoutMs: BANDIT_TIMEOUT_MS,
    })
    if (sarifRun.timedOut)
      throw new ToolError(`bandit timed out after ${BANDIT_TIMEOUT_MS / 1000}s; try a narrower "path"`)
    if (sarifRun.exitCode === 0) {
      const text = await fs.readFile(outFile, "utf8").catch(() => "")
      if (Scanner.parseJsonOutput(text) !== undefined) findings = Scanner.parseSarif(text)
    }

    // The SARIF formatter is an optional extra; fall back to plain JSON when it is missing/broken.
    if (findings === undefined) {
      format = "json"
      const jsonRun = await Scanner.run([bin, "-r", target.abs, "-f", "json", "--exit-zero", "-q"], {
        cwd: ctx.workspace,
        timeoutMs: BANDIT_TIMEOUT_MS,
      })
      if (jsonRun.timedOut)
        throw new ToolError(`bandit timed out after ${BANDIT_TIMEOUT_MS / 1000}s; try a narrower "path"`)
      if (jsonRun.exitCode !== 0)
        throw new ToolError(`bandit failed (exit ${jsonRun.exitCode}): ${stderrSnippet(jsonRun.stderr)}`)
      const parsed = Scanner.parseJsonOutput<BanditJson>(jsonRun.stdout)
      if (!parsed) throw new ToolError(`bandit produced no parseable output: ${stderrSnippet(jsonRun.stderr)}`)
      findings = (parsed.results ?? []).map(mapJsonResult)
    }
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {})
  }

  if (typeof minSeverity === "string")
    findings = findings.filter((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[minSeverity as Severity])

  return report("bandit", target, findings, { format, ...(minSeverity ? { minSeverity } : {}) })
}

export const Bandit: Integration = {
  id: "bandit",
  executables: ["bandit"],
  category: "tools",
  group: "sast",
  description: "Scan Python code for common security issues using bandit",
  tools: [
    {
      name: "bandit_scan",
      description: "Run bandit static analysis over Python sources in a directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory to scan, relative to the workspace (default: whole workspace)",
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Minimum severity to report (optional)",
          },
        },
        additionalProperties: false,
      },
      handler: banditScan,
    },
  ],
}
