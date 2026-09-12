import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext, type Severity } from "../types"
import { Scanner } from "../util/scanner"

/**
 * opengrep — LGPL-2.1 semgrep fork for multi-language pattern-based SAST.
 *
 * Runs `opengrep scan --config <config> --sarif --output <tmpfile> <path>`,
 * writing SARIF to a temp file under ctx.cacheDir, then maps results with
 * Scanner.parseSarif (rules carry security-severity properties). Exit codes 0
 * and 1 (findings) are success. When the binary is missing the tool returns
 * { installed: false, installHint } instead of throwing, so the caller can
 * decide whether to install it.
 */

const INSTALL_HINT =
  "install from https://github.com/opengrep/opengrep/releases (or brew install opengrep if available)"
const TIMEOUT_MS = 600_000 // full-tree SAST is slow; allow up to 10 minutes
const MAX_FINDINGS = 100

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  unknown: 5,
}

function countBySeverity(findings: Finding[]): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {}
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1
  return counts
}

function tail(text: string, max = 400): string {
  return text.trim().slice(-max)
}

function configArg(raw: unknown): string {
  if (raw === undefined) return "auto"
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ToolError(`"config" must be a non-empty string, e.g. "auto", "p/owasp-top-ten", or a local rules path`)
  }
  const value = raw.trim()
  // never let a config value be parsed as an extra CLI flag
  if (value.startsWith("-")) throw new ToolError(`"config" must not start with "-"`)
  return value
}

async function opengrepScan(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const target = await Scanner.resolveScanTarget(args["path"], ctx)
  const config = configArg(args["config"])

  const bin = await Scanner.which("opengrep")
  if (!bin) return { installed: false, installHint: INSTALL_HINT }

  await fs.mkdir(ctx.cacheDir, { recursive: true })
  const sarifPath = path.join(ctx.cacheDir, `scan-${randomUUID()}.sarif`)
  try {
    const result = await Scanner.run(
      [bin, "scan", "--config", config, "--sarif", "--output", sarifPath, "--quiet", target.abs],
      { cwd: ctx.workspace, timeoutMs: TIMEOUT_MS },
    )
    if (result.timedOut) {
      throw new ToolError(
        `opengrep timed out after ${TIMEOUT_MS / 60_000} minutes; scan a smaller path or use a narrower config`,
      )
    }
    // opengrep exits 1 when findings exist; anything else is a real failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new ToolError(
        `opengrep failed (exit ${result.exitCode}): ${tail(result.stderr) || tail(result.stdout) || "no output"}. ` +
          `If the default "auto" config cannot be fetched (needs network access), pass a registry ruleset or a local rules path via "config".`,
      )
    }
    const sarif = await fs.readFile(sarifPath, "utf8").catch(() => undefined)
    if (sarif === undefined) {
      throw new ToolError(`opengrep produced no SARIF output: ${tail(result.stderr) || "unknown error"}`)
    }

    const all = Scanner.parseSarif(sarif)
    const sorted = [...all].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    const findings = sorted.slice(0, MAX_FINDINGS)
    return {
      installed: true,
      tool: "opengrep",
      target: target.rel,
      config,
      findings,
      total: all.length,
      summary: { bySeverity: countBySeverity(all) },
      ...(all.length > findings.length
        ? { note: `showing top ${MAX_FINDINGS} of ${all.length} findings by severity` }
        : {}),
    }
  } finally {
    await fs.rm(sarifPath, { force: true }).catch(() => {})
  }
}

export const Opengrep: Integration = {
  id: "opengrep",
  executables: ["opengrep"],
  category: "tools",
  group: "sast",
  description: "Run opengrep (semgrep-compatible) SAST rules over the workspace",
  tools: [
    {
      name: "opengrep_scan",
      description:
        "Run opengrep static analysis (semgrep-compatible, multi-language SAST) over a directory or file. " +
        'Default config "auto" may need network access to fetch rules; pass a registry ruleset (e.g. "p/owasp-top-ten") ' +
        "or a local rules path instead. Long runtime: large trees can take up to ~10 minutes.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory or file to scan, relative to the workspace (default: whole workspace)",
          },
          config: {
            type: "string",
            description:
              'Ruleset to use: "auto", a registry ruleset like "p/owasp-top-ten", or a local rules path (default: "auto")',
          },
        },
        additionalProperties: false,
      },
      handler: opengrepScan,
    },
  ],
}
