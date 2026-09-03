import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaudeCodeGuidance } from "../src/claude-code-guidance"
import { ClaudeCodeCLI } from "../src/provider/claude-code"

if (process.env.FORGE_LIVE_CLAUDE !== "1")
  throw new Error("Set FORGE_LIVE_CLAUDE=1 to run this provider-billed workflow probe")

const prompt = `Investigate this unfamiliar repository without editing it. Answer all four questions with exact file paths, symbols, and values:
1. Where is the retry delay default defined, and which environment variable overrides it?
2. Where is the outbound request timeout enforced, and what is its value?
3. Where is telemetry sampling configured, and what fraction is used?
4. Which tests cover each of those behaviors?
Work end-to-end without asking the user. Use the repository tools efficiently.`

const agents = JSON.stringify({
  explore: {
    description: "Read-only codebase exploration that returns exact file and symbol evidence.",
    prompt: "Investigate the bounded question using read-only tools. Return concise file, symbol, and value evidence.",
  },
})

const files = {
  "apps/api/src/http/request.ts": `import { REQUEST_TIMEOUT_MS } from "../../../../packages/runtime/src/config"
export const request = (url: string) => fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
`,
  "packages/runtime/src/config.ts": `export const REQUEST_TIMEOUT_MS = 9_000
`,
  "packages/runtime/src/retry/policy.ts": `export const DEFAULT_RETRY_DELAY_MS = 275
`,
  "packages/runtime/src/retry/environment.ts": `import { DEFAULT_RETRY_DELAY_MS } from "./policy"
export const retryDelay = () => Number(process.env.FORGE_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS)
`,
  "packages/telemetry/src/sampling.ts": `export const TRACE_SAMPLE_FRACTION = 0.15
`,
  "test/runtime/retry.test.ts": `import { expect, test } from "bun:test"
import { retryDelay } from "../../packages/runtime/src/retry/environment"
test("uses the default and FORGE_RETRY_DELAY_MS override", () => expect(retryDelay()).toBeGreaterThan(0))
`,
  "test/api/request.test.ts": `import { expect, test } from "bun:test"
import { REQUEST_TIMEOUT_MS } from "../../packages/runtime/src/config"
test("enforces the request timeout", () => expect(REQUEST_TIMEOUT_MS).toBe(9_000))
`,
  "test/telemetry/sampling.test.ts": `import { expect, test } from "bun:test"
import { TRACE_SAMPLE_FRACTION } from "../../packages/telemetry/src/sampling"
test("samples fifteen percent of traces", () => expect(TRACE_SAMPLE_FRACTION).toBe(0.15))
`,
} as const

type ToolCall = {
  readonly name: string
  readonly input: Record<string, unknown>
}

type Measurement = {
  readonly condition: "baseline" | "guided"
  readonly run: number
  readonly exit: number
  readonly elapsedMs: number
  readonly providerTurns?: number
  readonly toolCalls: number
  readonly toolNames: Record<string, number>
  readonly parallelBatches: number
  readonly maxParallelBatch: number
  readonly subagentCalls: number
  readonly serialShellProbes: number
  readonly accurate: boolean
  readonly answer: string
  readonly stderr: string
}

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "forge-claude-workflow-probe-"))
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await Bun.write(path.join(directory, file), content)
  }
  for (let index = 0; index < 24; index++) {
    const file = path.join(directory, `packages/decoy-${index}/src/index.ts`)
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, `export const unrelatedValue${index} = ${index}\n`)
  }
  return directory
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const measure = async (condition: Measurement["condition"], run: number): Promise<Measurement> => {
  const directory = await fixture()
  const guardToken = crypto.randomUUID()
  const guard = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${guardToken}`) return new Response(null, { status: 404 })
      const input = record(await request.json().catch(() => undefined))
      if (input?.tool_name !== "Bash") return Response.json({})
      return Response.json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Bash is disabled in this read-only probe; use Read, Glob, or Grep.",
        },
      })
    },
  })
  const settingsFile = path.join(directory, "claude-settings.json")
  const guardUrl = `http://127.0.0.1:${guard.port}/pre-tool-use`
  await Bun.write(
    settingsFile,
    JSON.stringify({
      allowedHttpHookUrls: [guardUrl],
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "http",
                url: guardUrl,
                headers: { Authorization: `Bearer ${guardToken}` },
                timeout: 2,
              },
            ],
          },
        ],
      },
    }),
  )
  const started = performance.now()
  const child = Bun.spawn(
    [
      ClaudeCodeCLI.DEFAULT_EXECUTABLE,
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--effort",
      "low",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--settings",
      settingsFile,
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--tools",
      "Read,Glob,Grep,Bash,Agent",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Glob,Grep,Bash,Agent",
      "--agents",
      agents,
      "--append-system-prompt",
      condition === "guided"
        ? `You are running inside Forge.\n\n${ClaudeCodeGuidance.WORKFLOW}`
        : "You are running inside Forge.",
    ],
    {
      cwd: directory,
      env: ClaudeCodeCLI.subscriptionEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const exited = new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve(-1)
    }, 180_000)
    child.exited.then((code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    exited,
  ])
  await guard.stop(true)
  const messages = stdout
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [record(JSON.parse(line))]
      } catch {
        return []
      }
    })
    .filter((message): message is Record<string, unknown> => message !== undefined)
  const batches = messages.flatMap((message) => {
    if (message.type !== "assistant") return []
    const envelope = record(message.message)
    if (!Array.isArray(envelope?.content)) return []
    const calls = envelope.content.flatMap((item) => {
      const block = record(item)
      if (block?.type !== "tool_use" || typeof block.name !== "string") return []
      return [{ name: block.name, input: record(block.input) ?? {} } satisfies ToolCall]
    })
    return calls.length ? [calls] : []
  })
  const calls = batches.flat()
  const result = messages.findLast((message) => message.type === "result")
  const answer = typeof result?.result === "string" ? result.result : ""
  const toolNames = Object.fromEntries(
    [...new Set(calls.map((call) => call.name))].map((name) => [
      name,
      calls.filter((call) => call.name === name).length,
    ]),
  )
  const serialShellProbes = batches.filter((batch) => {
    const call = batch.length === 1 ? batch[0] : undefined
    if (!call || (call.name !== "Bash" && call.name !== "Shell") || typeof call.input.command !== "string") return false
    if (/(?:>>?|<<)|\bsed\b[^\n]*\s(?:--in-place(?:=\S*)?|-[A-Za-z]*i[A-Za-z]*\S*)/i.test(call.input.command))
      return false
    return /(^|[;&|]\s*)(?:(?:git\s+(?:grep|ls-files))|ls|find|grep|rg|cat|head|tail|sed|awk|tree|stat|file)(?:\s|$)/i.test(
      call.input.command,
    )
  }).length
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_,.]/g, "")
  const accurate = [
    "DEFAULT_RETRY_DELAY_MS",
    "FORGE_RETRY_DELAY_MS",
    "275",
    "REQUEST_TIMEOUT_MS",
    "9000",
    "TRACE_SAMPLE_FRACTION",
    "0.15",
    "retry.test.ts",
    "request.test.ts",
    "sampling.test.ts",
  ].every((needle) => normalize(answer).includes(normalize(needle)))

  const measurement = {
    condition,
    run,
    exit,
    elapsedMs: Math.round(performance.now() - started),
    providerTurns: typeof result?.num_turns === "number" ? result.num_turns : undefined,
    toolCalls: calls.length,
    toolNames,
    parallelBatches: batches.filter((batch) => batch.length > 1).length,
    maxParallelBatch: Math.max(0, ...batches.map((batch) => batch.length)),
    subagentCalls: calls.filter((call) => call.name === "Agent" || call.name === "Task").length,
    serialShellProbes,
    accurate,
    answer,
    stderr: stderr.slice(0, 2_000),
  } satisfies Measurement
  await rm(directory, { recursive: true, force: true })
  return measurement
}

const measurements: Measurement[] = []
for (const [condition, run] of [
  ["baseline", 1],
  ["guided", 1],
  ["guided", 2],
  ["baseline", 2],
] as const) {
  const result = await measure(condition, run)
  measurements.push(result)
  console.error(JSON.stringify({ ...result, answer: result.answer.slice(0, 160) }))
}

console.log(JSON.stringify(measurements, null, 2))
