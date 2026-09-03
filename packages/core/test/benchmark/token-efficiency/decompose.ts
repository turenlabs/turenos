/**
 * Decomposes TurenOS's fixed per-request token floor into its named contributors.
 *
 * The benchmark answers "how many tokens does the floor cost". This answers
 * "what is the floor made of", which is the only way to know what is worth
 * cutting.
 *
 * Method, in two halves, neither of them a guess:
 *
 *  1. A PATH shim in front of `claude` captures the exact wire inputs the
 *     Claude Code runtime hands the CLI for one real TurenOS turn — argv (which
 *     carries `--tools`, the native tool set for the turn) and stdin (which
 *     carries the `initialize` control request, and with it the system prompt).
 *     Those are priced with the repo's own estimator.
 *
 *  2. Claude Code's own contributions — its `claude_code` preset system prompt
 *     and the JSON schemas of its native tools — are not visible to a shim and
 *     are not ours to read. They are measured by *running* the CLI: an empty
 *     custom system prompt with no tools gives the irreducible envelope, adding
 *     the preset prices the preset, and adding the turn's tool set prices the
 *     schemas. Every number below is a reading, never an estimate.
 *
 *   bun run packages/core/test/benchmark/token-efficiency/decompose.ts
 *
 * Costs one Haiku turn plus a handful of ~10k-token probe turns against the
 * local Claude Code subscription. `--skip-cli-probe` runs part 1 only.
 * `--per-tool` additionally prices each native tool's marginal cost, which is
 * one extra probe turn per tool.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Token } from "../../../src/util/token"
import { baseEnv, exec } from "./src/exec.ts"
import { BENCH_DIR, materializeWorkspace, scratchRoot } from "./src/workspace.ts"

const REPO_ROOT = path.resolve(BENCH_DIR, "..", "..", "..", "..", "..")
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "forge", "src", "index.ts")
const PROMPT =
  "In src/config.ts, what is the numeric value of the exported constant MAX_RETRY_ATTEMPTS? Reply with only the number."

const skipCliProbe = process.argv.includes("--skip-cli-probe")
const perTool = process.argv.includes("--per-tool")

/** A `claude` stand-in that records the turn's wire inputs, then execs the real CLI. */
const SHIM = `#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const capture = process.env.TOKEN_DECOMPOSE_CAPTURE
const real = process.env.TOKEN_DECOMPOSE_REAL_CLAUDE
const argv = process.argv.slice(2)
const dir = path.join(capture, Date.now() + "-" + Math.random().toString(36).slice(2, 8))
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "argv.json"), JSON.stringify(argv, null, 2))

const flag = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
for (const name of ["--append-system-prompt-file", "--system-prompt-file"]) {
  const file = flag(name)
  if (!file) continue
  try {
    writeFileSync(path.join(dir, "system.txt"), readFileSync(file))
    writeFileSync(path.join(dir, "system-source.txt"), name)
  } catch {}
}

const child = spawn(real, argv, { stdio: ["pipe", "inherit", "inherit"] })
const chunks = []
const flush = () => writeFileSync(path.join(dir, "stdin.txt"), Buffer.concat(chunks))
process.stdin.on("data", (chunk) => {
  chunks.push(chunk)
  child.stdin.write(chunk)
})
process.stdin.on("end", () => {
  flush()
  child.stdin.end()
})
child.on("exit", (code, signal) => {
  flush()
  process.exit(code ?? (signal ? 1 : 0))
})
`

type Row = { readonly group: string; readonly item: string; readonly tokens: number; readonly how: string }
const rows: Row[] = []
const add = (group: string, item: string, tokens: number, how: string) => rows.push({ group, item, tokens, how })

async function captureTurn(): Promise<string> {
  const realClaude = Bun.which("claude")
  if (!realClaude) throw new Error("`claude` is not on PATH")

  const runId = `decompose-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const workspace = materializeWorkspace(runId, "trivial")
  const captureDir = path.join(scratchRoot(), runId, "capture")
  mkdirSync(captureDir, { recursive: true })
  const shimDir = mkdtempSync(path.join(os.tmpdir(), "token-decompose-shim-"))
  writeFileSync(path.join(shimDir, "claude"), SHIM, { mode: 0o755 })

  const dbDir = path.join(scratchRoot(), "db", runId)
  mkdirSync(dbDir, { recursive: true })
  const env = baseEnv()
  env["PATH"] = `${shimDir}${path.delimiter}${env["PATH"] ?? process.env["PATH"] ?? ""}`
  env["TOKEN_DECOMPOSE_CAPTURE"] = captureDir
  env["TOKEN_DECOMPOSE_REAL_CLAUDE"] = realClaude
  env["FORGE_SECRET_VAULT_KEY_ID"] = `token-decompose-${randomUUID()}`
  env["FORGE_SECRET_VAULT_KEY"] = randomBytes(32).toString("base64")
  env["FORGE_DB"] = path.join(dbDir, "decompose.db")
  env["FORGE_PURE"] = "1"
  env["FORGE_DISABLE_AUTOUPDATE"] = "1"
  env["FORGE_DISABLE_AUTOCOMPACT"] = "1"
  env["FORGE_DISABLE_PROJECT_CONFIG"] = "1"
  env["FORGE_PERMISSION"] = JSON.stringify({
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    bash: "allow",
  })

  // batou:ignore command_exec -- benchmark-only script; `exec` is Bun.spawn with a
  // literal argv array and no shell, and the env it receives is assembled here from
  // constants plus the benchmark's own scratch paths.
  const result = await exec({
    cmd: [
      "bun",
      "run",
      "--conditions=browser",
      CLI_ENTRY,
      "run",
      "--dir",
      workspace,
      "--format",
      "json",
      "--model",
      process.env["TOKEN_BENCH_TUREN_CC_MODEL"] ?? "claude-code/haiku",
      PROMPT,
    ],
    cwd: REPO_ROOT,
    env,
    timeoutMs: 300_000,
  })
  rmSync(shimDir, { recursive: true, force: true })

  // The first spawn is the auth probe; the turn is the capture that carries stdin.
  const turns = readdirSync(captureDir)
    .sort()
    .map((entry) => path.join(captureDir, entry))
    .filter((entry) => existsSync(path.join(entry, "stdin.txt")) && readFileSync(path.join(entry, "stdin.txt")).length)
  const turn = turns.at(-1)
  if (!turn) {
    throw new Error(`no captured turn (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 800)}`)
  }
  return turn
}

/** Runs the CLI directly to price what only the CLI knows. */
async function probe(args: string[]): Promise<number> {
  const result = await exec({
    cmd: [
      "claude",
      "-p",
      "--output-format",
      "json",
      "--setting-sources=",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      "haiku",
      ...args,
      "Reply with exactly: OK",
    ],
    cwd: os.tmpdir(),
    env: baseEnv(),
    timeoutMs: 180_000,
  })
  const usage = JSON.parse(result.stdout)["usage"]
  return usage["input_tokens"] + usage["cache_read_input_tokens"] + usage["cache_creation_input_tokens"]
}

const dir = await captureTurn()
const argv: string[] = JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8"))
const toolFlag = argv[argv.indexOf("--tools") + 1] ?? ""
const nativeTools = toolFlag.split(",").filter((name) => name.length > 0)

// --- what TurenOS put on the wire ---------------------------------------------
const stdin = readFileSync(path.join(dir, "stdin.txt"), "utf8")
let system = existsSync(path.join(dir, "system.txt")) ? readFileSync(path.join(dir, "system.txt"), "utf8") : ""
let preset = false
let userText = ""
for (const line of stdin.split("\n")) {
  if (!line.trim().startsWith("{")) continue
  const message = JSON.parse(line) as Record<string, any>
  if (message["type"] === "control_request" && message["request"]?.["subtype"] === "initialize") {
    const request = message["request"]
    // A custom prompt arrives as `systemPrompt` (the SDK normalises a string into a
    // one-element array of blocks); the preset-plus-append form arrives as
    // `appendSystemPrompt`, in which case Claude Code's preset is also on the wire.
    if (typeof request["systemPrompt"] === "string") system = request["systemPrompt"]
    if (Array.isArray(request["systemPrompt"]))
      system = request["systemPrompt"].filter((block: unknown) => typeof block === "string").join("\n\n")
    if (typeof request["appendSystemPrompt"] === "string") {
      system = request["appendSystemPrompt"]
      preset = true
    }
  }
  if (message["type"] === "user") {
    userText = (message["message"]?.["content"] ?? [])
      .filter((part: { type: string }) => part.type === "text")
      .map((part: { text: string }) => part.text)
      .join("\n")
  }
}

// The system prompt is one string; split it back into the parts `systemPrompt()`
// joined so the table names them rather than reporting one opaque block.
for (const part of system.split("\n\n").filter((part) => part.trim().length > 0)) {
  const head = part.split("\n")[0]!.replace(/\s+/g, " ").slice(0, 30)
  add("turen system prompt", head, Token.estimate(part), "estimator")
}
add("transcript", "first user turn", Token.estimate(userText), "estimator")

// --- what Claude Code put on the wire ---------------------------------------
if (!skipCliProbe) {
  const envelope = await probe(["--system-prompt-file", "/dev/null", "--tools="])
  const withTools = await probe(["--system-prompt-file", "/dev/null", `--tools=${toolFlag}`])
  add("request envelope", "harness framing (irreducible)", envelope, "cli probe")
  add(
    "claude code tools",
    `${nativeTools.length} native schemas: ${nativeTools.join(",")}`,
    withTools - envelope,
    "cli probe",
  )
  if (preset) {
    const withPreset = await probe(["--append-system-prompt-file", "/dev/null", "--tools="])
    add("claude code prompt", "claude_code preset", withPreset - envelope, "cli probe")
  }
  if (perTool) {
    for (const tool of nativeTools) {
      const without = nativeTools.filter((name) => name !== tool)
      const cost = withTools - (await probe(["--system-prompt-file", "/dev/null", `--tools=${without.join(",")}`]))
      add("claude code tools", `  ${tool} (marginal, removable)`, cost, "cli probe")
    }
  }
}

// --- report ------------------------------------------------------------------
const attributed = rows.filter((row) => !row.item.startsWith("  ")).reduce((sum, row) => sum + row.tokens, 0)
console.log(`\ncapture: ${dir}`)
console.log(`system prompt mode: ${preset ? "claude_code preset + append" : "custom (preset replaced)"}\n`)
console.log(`  ${"group".padEnd(20)}${"item".padEnd(38)}${"tokens".padStart(8)}   share  measured by`)
console.log(`  ${"-".repeat(20)}${"-".repeat(38)}${"-".repeat(8)}   -----  -----------`)
for (const row of [...rows].sort((a, b) => b.tokens - a.tokens)) {
  const share = row.item.startsWith("  ") ? "     " : `${((row.tokens / attributed) * 100).toFixed(1).padStart(5)}%`
  console.log(`  ${row.group.padEnd(20)}${row.item.padEnd(38)}${String(row.tokens).padStart(8)}   ${share}  ${row.how}`)
}
console.log(`\n  ${"".padEnd(20)}${"= attributed floor".padEnd(38)}${String(attributed).padStart(8)}`)
console.log(`  compare against \`fixed ovh\` from run.ts --task trivial; the gap is this turn's tool result.`)
