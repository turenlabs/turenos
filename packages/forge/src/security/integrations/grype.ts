import fs from "node:fs/promises"
import path from "node:path"
import type { Integration } from "../registry"
import { ToolError, type Finding, type IntegrationContext, type Severity } from "../types"
import { Scanner } from "../util/scanner"

/**
 * grype + syft — Anchore's vulnerability scanner and SBOM generator, exposed
 * as a single integration ("grype") with two tools. The binaries are separate
 * and detected independently.
 *
 * Deliberate deviation from CONVENTIONS.md (per integration spec): a missing
 * binary returns a structured `{ installed: false, installHint }` result
 * instead of throwing, so agents can relay install instructions; findings are
 * capped at 100 (not 50) with a truncation note.
 */

const GRYPE_HINT = "brew install grype"
const SYFT_HINT = "brew install syft"
/** First grype run downloads the vulnerability DB, which can take minutes. */
const GRYPE_TIMEOUT_MS = 300_000
const SYFT_TIMEOUT_MS = 180_000
const MAX_FINDINGS = 100
const MAX_COMPONENTS = 200

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

async function grypeScan(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const onlyFixed = args.only_fixed
  if (onlyFixed !== undefined && typeof onlyFixed !== "boolean") throw new ToolError(`"only_fixed" must be a boolean`)
  const target = await resolveTarget(args.path, ctx)

  const bin = await Scanner.which("grype")
  if (!bin) return notInstalled("grype", GRYPE_HINT)

  const source = target.isDirectory ? `dir:${target.abs}` : `sbom:${target.abs}`
  const argv = [bin, source, "-o", "sarif", "-q"]
  if (onlyFixed) argv.push("--only-fixed")

  const result = await Scanner.run(argv, { cwd: ctx.workspace, timeoutMs: GRYPE_TIMEOUT_MS })
  if (result.timedOut)
    throw new ToolError(
      `grype timed out after ${GRYPE_TIMEOUT_MS / 1000}s (the first run downloads its vulnerability DB; retry once it is cached)`,
    )
  // grype exits 1 when findings trip a --fail-on threshold; only >1 is a real failure
  if (result.exitCode > 1)
    throw new ToolError(`grype failed (exit ${result.exitCode}): ${stderrSnippet(result.stderr)}`)
  if (Scanner.parseJsonOutput(result.stdout) === undefined)
    throw new ToolError(`grype produced no parseable SARIF output: ${stderrSnippet(result.stderr)}`)

  return report("grype", target, Scanner.parseSarif(result.stdout))
}

// Minimal CycloneDX 1.x shapes — only what syftSbom reads.
interface CdxLicenseChoice {
  license?: { id?: string; name?: string }
  expression?: string
}

interface CdxComponent {
  name?: string
  version?: string
  purl?: string
  licenses?: CdxLicenseChoice[]
}

interface CdxBom {
  components?: CdxComponent[]
}

function componentLicense(component: CdxComponent): string | undefined {
  const parts = (component.licenses ?? [])
    .map((choice) => choice.license?.id ?? choice.license?.name ?? choice.expression)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return parts.length ? parts.join(", ") : undefined
}

async function syftSbom(args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown> {
  const target = await resolveTarget(args.path, ctx)

  const bin = await Scanner.which("syft")
  if (!bin) return notInstalled("syft", SYFT_HINT)

  const source = target.isDirectory ? `dir:${target.abs}` : `file:${target.abs}`
  const result = await Scanner.run([bin, source, "-o", "cyclonedx-json", "-q"], {
    cwd: ctx.workspace,
    timeoutMs: SYFT_TIMEOUT_MS,
  })
  if (result.timedOut) throw new ToolError(`syft timed out after ${SYFT_TIMEOUT_MS / 1000}s`)
  if (result.exitCode !== 0)
    throw new ToolError(`syft failed (exit ${result.exitCode}): ${stderrSnippet(result.stderr)}`)

  const bom = Scanner.parseJsonOutput<CdxBom>(result.stdout)
  if (!bom) throw new ToolError(`syft produced no parseable CycloneDX output: ${stderrSnippet(result.stderr)}`)

  // Trimmed component list only — the full BOM easily blows the output budget.
  const components = (bom.components ?? []).map((component) => {
    const license = componentLicense(component)
    return {
      name: component.name ?? "unknown",
      version: component.version,
      ...(license ? { license } : {}),
      ...(component.purl ? { purl: component.purl } : {}),
    }
  })
  const top = components.slice(0, MAX_COMPONENTS)
  return {
    tool: "syft",
    installed: true,
    target: target.rel,
    format: "cyclonedx-json",
    total: components.length,
    components: top,
    ...(components.length > top.length
      ? { note: `truncated to the first ${top.length} of ${components.length} components` }
      : {}),
  }
}

export const Grype: Integration = {
  id: "grype",
  executables: ["grype", "syft"],
  category: "tools",
  group: "dependencies",
  description: "Scan for known vulnerabilities with grype and generate SBOMs with syft",
  tools: [
    {
      name: "grype_scan",
      description:
        "Run grype over a directory or SBOM file to find known vulnerabilities in dependencies. The first run downloads grype's vulnerability database and can take a few minutes.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory or SBOM file, relative to the workspace (default: whole workspace)",
          },
          only_fixed: { type: "boolean", description: "Only report vulnerabilities that have a fix available" },
        },
        additionalProperties: false,
      },
      handler: grypeScan,
    },
    {
      name: "syft_sbom",
      description:
        "Generate a CycloneDX SBOM for a directory with syft and return a trimmed component list (name, version, license, purl).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory or file to catalog, relative to the workspace (default: whole workspace)",
          },
        },
        additionalProperties: false,
      },
      handler: syftSbom,
    },
  ],
}
