import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext, type Severity } from "../types"
import { Scanner } from "../util/scanner"

/**
 * checkov — IaC misconfiguration scanner (Terraform, CloudFormation, K8s,
 * Dockerfile, ...).
 *
 * Approach: `checkov -o sarif --output-file-path <tmpdir>` writes a SARIF
 * report file (normally results_sarif.sarif — we list the tmpdir to find the
 * actual name, which varies across versions) and we map it via the shared
 * SARIF parser. Chosen over `-o json` on stdout so we reuse Scanner.parseSarif
 * and keep parsing independent of console noise.
 *
 * Deliberate deviation from CONVENTIONS.md (per integration spec): a missing
 * binary returns a structured `{ installed: false, installHint }` result
 * instead of throwing, so agents can relay install instructions; findings are
 * capped at 100 (not 50) with a truncation note.
 */

const CHECKOV_HINT = "brew install checkov (or pipx install checkov)"
const CHECKOV_TIMEOUT_MS = 300_000
const MAX_FINDINGS = 100

const SEVERITY_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1, unknown: 0 }

interface Target {
  abs: string
  rel: string
  isDirectory: boolean
}

/** Resolve the `path` arg against the workspace; reject escapes and missing paths. */
async function resolveTarget(raw: unknown, ctx: IntegrationContext): Promise<Target> {
  if (raw !== undefined && typeof raw !== "string") throw new ToolError(`"path" must be a string`)
  const workspace = path.resolve(ctx.workspace)
  const abs = path.resolve(workspace, raw ?? ".")
  if (abs !== workspace && !abs.startsWith(workspace + path.sep))
    throw new ToolError(`"path" must resolve inside the workspace (${ctx.workspace})`)
  try {
    const stat = await fs.stat(abs)
    return { abs, rel: path.relative(workspace, abs) || ".", isDirectory: stat.isDirectory() }
  } catch {
    throw new ToolError(`path does not exist: ${String(raw ?? ".")} (resolved to ${abs})`)
  }
}

function notInstalled(tool: string, installHint: string) {
  return {
    tool,
    installed: false,
    installHint,
    note: `"${tool}" is not installed or not on PATH. Install it with: ${installHint}`,
  }
}

function outputSnippet(result: { stderr: string; stdout: string }): string {
  const text = (result.stderr.trim() || result.stdout.trim()).slice(0, 400)
  return text || "(no output)"
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
  for (const finding of findings) finding.file = cleanFile(finding.file, target.abs)
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

async function checkovScan(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const framework = args.framework
  if (framework !== undefined && (typeof framework !== "string" || !/^[A-Za-z0-9_,-]+$/.test(framework)))
    throw new ToolError(`"framework" must be a framework name like "terraform" (letters, digits, "_", "-", ",")`)
  const target = await resolveTarget(args.path, ctx)

  const bin = await Scanner.which("checkov")
  if (!bin) return notInstalled("checkov", CHECKOV_HINT)

  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-checkov-"))
  try {
    const argv = [
      bin,
      target.isDirectory ? "-d" : "-f",
      target.abs,
      "-o",
      "sarif",
      "--output-file-path",
      tmpdir,
      "--quiet",
    ]
    if (framework) argv.push("--framework", ...framework.split(",").filter(Boolean))

    const result = await Scanner.run(argv, { cwd: ctx.workspace, timeoutMs: CHECKOV_TIMEOUT_MS })
    if (result.timedOut)
      throw new ToolError(`checkov timed out after ${CHECKOV_TIMEOUT_MS / 1000}s; try a narrower "path" or "framework"`)
    // checkov exits 1 when checks fail — that is a successful scan with findings
    if (result.exitCode > 1) throw new ToolError(`checkov failed (exit ${result.exitCode}): ${outputSnippet(result)}`)

    const entries = await fs.readdir(tmpdir)
    const sarifName =
      entries.find((name) => name.toLowerCase().endsWith(".sarif")) ??
      entries.find((name) => name.toLowerCase().includes("sarif"))
    if (!sarifName) throw new ToolError(`checkov did not write a SARIF report: ${outputSnippet(result)}`)

    const findings = Scanner.parseSarif(await fs.readFile(path.join(tmpdir, sarifName), "utf8"))
    return report("checkov", target, findings, framework ? { framework } : {})
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => {})
  }
}

export const Checkov: Integration = {
  id: "checkov",
  executables: ["checkov"],
  category: "tools",
  group: "iac",
  description: "Scan infrastructure-as-code for misconfigurations using checkov",
  tools: [
    {
      name: "checkov_scan",
      description:
        "Run checkov over a directory to find IaC misconfigurations (Terraform, CloudFormation, Kubernetes, Dockerfile, ...).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory to scan, relative to the workspace (default: whole workspace)",
          },
          framework: { type: "string", description: 'Restrict to one framework, e.g. "terraform" (optional)' },
        },
        additionalProperties: false,
      },
      handler: checkovScan,
    },
  ],
}
