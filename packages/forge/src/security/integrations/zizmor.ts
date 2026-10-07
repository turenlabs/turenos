import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Option, Schema } from "effect"
import type { Integration } from "../registry"
import { Scanner } from "../util/scanner"
import { ToolError, type Finding, type IntegrationContext, type Severity, type ToolRequestContext } from "../types"

const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES
const MAX_FILES = 100
const MAX_ENTRIES = 2048
const MAX_DEPTH = 12
const RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1, unknown: 0 }

// Only the supported zizmor SARIF contract is accepted. Extra source-bearing
// fields (snippets, code flows, fixes, help) are discarded before normalization.
const Sarif = Schema.Struct({
  version: Schema.Literal("2.1.0"),
  runs: Schema.Array(
    Schema.Struct({
      tool: Schema.Struct({
        driver: Schema.Struct({
          name: Schema.Literal("zizmor"),
          version: Schema.optional(Schema.String),
          rules: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
        }),
      }),
      invocations: Schema.Array(Schema.Struct({ executionSuccessful: Schema.Literal(true) })),
      results: Schema.Array(
        Schema.Struct({
          ruleId: Schema.String,
          level: Schema.Literals(["error", "warning", "note", "none"]),
          message: Schema.Struct({ text: Schema.String }),
          suppressions: Schema.optional(Schema.Array(Schema.Unknown)),
          properties: Schema.optional(
            Schema.Struct({
              "zizmor/severity": Schema.optional(Schema.Literals(["Informational", "Low", "Medium", "High"])),
            }),
          ),
          locations: Schema.Array(
            Schema.Struct({
              physicalLocation: Schema.Struct({
                artifactLocation: Schema.Struct({ uri: Schema.String }),
                region: Schema.Struct({ startLine: Schema.Int, endLine: Schema.optional(Schema.Int) }),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
})
const decodeSarif = Schema.decodeUnknownOption(Schema.fromJsonString(Sarif))

async function scan(args: Record<string, unknown>, ctx: IntegrationContext, request: ToolRequestContext) {
  if (Object.keys(args).some((key) => key !== "path"))
    throw new ToolError("zizmor accepts only the optional path argument")
  const raw = args.path === undefined ? ".github/workflows" : args.path
  if (
    typeof raw !== "string" ||
    !raw.trim() ||
    raw.length > 1024 ||
    /[\x00-\x1f]/.test(raw) ||
    raw === "-" ||
    raw.includes("://") ||
    raw.includes("@")
  ) {
    throw new ToolError("path must be a local workspace YAML file or directory, not a remote repository or URL")
  }
  const workspace = path.resolve(ctx.workspace)
  const abs = path.resolve(workspace, raw)
  const rel = path.relative(workspace, abs)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ToolError("path must be inside the workspace")
  }
  const target = { abs, rel: rel || "." }
  await requireRegularPath(workspace, abs)
  const bin = await Scanner.requireBinary("zizmor", "install or update zizmor separately, then retry")
  const stage = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "forge-zizmor-")).catch(() => {
    throw new ToolError("zizmor could not create temporary staging; check temporary directory permissions")
  })
  try {
    const files = await stageInputs(workspace, target.abs, stage, request.signal)
    const inputs = files.map((file) => path.join(stage, file))
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.startsWith("ZIZMOR_") || key === "GH_HOST" || /^(GH|GITHUB)_.*TOKEN$/.test(key))
        .map((key) => [key, undefined]),
    )
    Object.assign(env, { HOME: stage, USERPROFILE: stage, XDG_CACHE_HOME: stage, LOCALAPPDATA: stage, APPDATA: stage })
    const result = await Scanner.run(
      [
        bin,
        "--offline",
        "--no-config",
        "--no-ignores",
        "--strict-collection",
        "--persona=auditor",
        "--format=sarif",
        "--color=never",
        "--",
        ...inputs,
      ],
      {
        cwd: stage,
        signal: request.signal,
        timeoutMs: 30_000,
        maxOutputBytes: 4 * 1024 * 1024,
        // Remove inherited variables: empty tokens fail zizmor's CLI parser.
        env,
      },
    ).catch(() => {
      throw new ToolError(
        request.signal.aborted ? "zizmor scan cancelled" : "zizmor could not start; check the installed executable",
      )
    })
    if (request.signal.aborted) throw new ToolError("zizmor scan cancelled")
    if (result.timedOut) throw new ToolError("zizmor timed out after 30s; choose a narrower path")
    if (result.truncated) throw new ToolError("zizmor output exceeded the limit; choose a narrower path")
    // Unlike other formats, SARIF exits zero even when it contains findings.
    // Exit 2 is the CLI parser rejecting an argument: --no-ignores needs zizmor 1.25.0 or newer.
    if (result.exitCode === 2) {
      throw new ToolError("zizmor rejected its arguments (exit 2); zizmor 1.25.0 or newer is required, update it separately and retry")
    }
    if (result.exitCode !== 0) {
      throw new ToolError(
        `zizmor failed (exit ${result.exitCode}); check YAML syntax or install/update zizmor separately and retry`,
      )
    }
    return report(result.stdout, target.rel, stage, files)
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

function report(stdout: string, target: string, stage: string, files: string[]) {
  const parsed = decodeSarif(stdout)
  if (Option.isNone(parsed) || parsed.value.runs.length !== 1) {
    throw new ToolError("zizmor returned malformed or incompatible SARIF; install/update zizmor separately and retry")
  }
  const run = parsed.value.runs[0]
  if (!run.invocations.length) throw new ToolError("zizmor SARIF did not confirm successful execution")
  // zizmor omits driver.rules when results is empty; findings still require a declared rule.
  const rules = new Set((run.tool.driver.rules ?? []).map((rule) => rule.id))
  const selected = new Set(files)
  const locations = new Map<string, string>()
  for (const item of run.results) {
    if (
      !/^zizmor\/[a-z0-9-]{1,100}$/.test(item.ruleId) ||
      !rules.has(item.ruleId) ||
      !item.locations.length ||
      item.suppressions?.length
    ) {
      throw new ToolError("zizmor returned incompatible or suppressed findings; no clean result is available")
    }
    for (const location of item.locations) {
      const physical = location.physicalLocation
      if (
        physical.region.startLine < 1 ||
        (physical.region.endLine !== undefined && physical.region.endLine < physical.region.startLine)
      ) {
        throw new ToolError("zizmor returned invalid source locations")
      }
      const uri = physical.artifactLocation.uri
      const resolved = (() => {
        try {
          return uri.startsWith("file:") ? fileURLToPath(uri) : uri
        } catch {
          throw new ToolError("zizmor returned invalid source locations")
        }
      })()
      const rel = path.relative(stage, path.resolve(stage, resolved))
      if (!selected.has(rel)) throw new ToolError("zizmor returned a location outside the collected inputs")
      locations.set(uri, rel)
    }
  }
  const all = Scanner.parseSarif(JSON.stringify(parsed.value))
    .map(
      (item, i): Finding => ({
        ...item,
        file: locations.get(item.file ?? ""),
        severity: run.results[i].properties?.["zizmor/severity"] === "Informational" ? "info" : item.severity,
        message: item.message.replaceAll(stage + path.sep, "").slice(0, 400),
      }),
    )
    .sort((a, b) => RANK[b.severity] - RANK[a.severity])
  const findings = all.slice(0, 50)
  const result = {
    tool: "zizmor",
    target,
    version: run.tool.driver.version?.slice(0, 64) || "unavailable",
    findings,
    total: all.length,
    truncated: all.length > findings.length || run.results.some((item) => item.message.text.length > 400),
    coverage: { offline: true, onlineAudits: false, files: files.length, complete: true },
  }
  // Count escaped UTF-8 JSON bytes, not string length; filenames and messages
  // can be non-ASCII. Keep headroom under the MCP server's 50,000-byte cap.
  while (Buffer.byteLength(JSON.stringify(result)) > 45_000 && findings.length) {
    findings.pop()
    result.truncated = true
  }
  return result
}

// Reject stable symlink escapes, including ancestors inside the workspace. This
// is not OS isolation: concurrent ancestor replacement remains a TOCTOU risk.
async function requireRegularPath(workspace: string, target: string) {
  const parts = path.relative(workspace, target).split(path.sep).filter(Boolean)
  for (const item of [workspace, ...parts.map((_, i) => path.join(workspace, ...parts.slice(0, i + 1)))]) {
    const stat = await fs.lstat(item).catch(() => undefined)
    if (!stat || (!stat.isDirectory() && !stat.isFile())) {
      throw new ToolError("path must exist and contain only regular files or directories, without symlinks")
    }
  }
}

async function stageInputs(workspace: string, target: string, stage: string, signal: AbortSignal) {
  const files: string[] = []
  const budget = { entries: 0, bytes: 0 }
  async function visit(file: string, depth: number) {
    if (signal.aborted) throw new ToolError("zizmor scan cancelled")
    if (++budget.entries > MAX_ENTRIES || depth > MAX_DEPTH) {
      throw new ToolError("zizmor input exceeds entry/depth limits; choose a narrower path")
    }
    await requireRegularPath(workspace, file)
    const stat = await fs.lstat(file)
    if (stat.isDirectory()) {
      // Streaming traversal bounds even a directory with millions of entries.
      const dir = await fs.opendir(file)
      for await (const entry of dir) await visit(path.join(file, entry.name), depth + 1)
      return
    }
    if (!/\.ya?ml$/i.test(file)) {
      if (file === target) throw new ToolError("path must select a YAML file or directory")
      return
    }
    const rel = path.relative(workspace, file)
    if (
      rel.length > 1024 ||
      files.length >= MAX_FILES ||
      stat.size > MAX_FILE_BYTES ||
      budget.bytes + stat.size > MAX_TOTAL_BYTES
    ) {
      throw new ToolError("zizmor input exceeds file/path/byte limits; choose a narrower path")
    }
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new ToolError("zizmor input changed during collection; retry")
      }
      const buffer = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size)
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size !== stat.size) throw new ToolError("zizmor input changed during collection; retry")
      budget.bytes += size
      const dest = path.join(stage, rel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, buffer.subarray(0, size), { mode: 0o600 })
      files.push(rel)
    } finally {
      await handle.close()
    }
  }
  await visit(target, 0).catch((error: unknown) => {
    if (error instanceof ToolError) throw error
    throw new ToolError("zizmor could not safely collect local YAML inputs; check permissions and retry")
  })
  if (!files.length) throw new ToolError("No YAML inputs collected; choose a workflow file or directory")
  return files.sort()
}

export const Zizmor: Integration = {
  id: "zizmor",
  category: "tools",
  group: "iac",
  description: "Offline security analysis of local GitHub Actions YAML using zizmor",
  executables: ["zizmor"],
  tools: [
    {
      name: "zizmor_scan",
      description: "Scan local GitHub Actions YAML offline without configuration, suppression, or fixes.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace YAML file or directory (default: .github/workflows)" },
        },
        additionalProperties: false,
      },
      handler: scan,
    },
  ],
}
