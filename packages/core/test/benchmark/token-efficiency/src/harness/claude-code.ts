import { baseEnv, exec, parseNdjson } from "../exec.ts"
import { emptyUsage, usageFromAnthropic, type Harness, type RequestUsage, type TurnOutcome } from "../types.ts"

/** Model alias passed to `claude --model`. */
const MODEL = process.env["TOKEN_BENCH_CLAUDE_MODEL"] ?? "haiku"
/** Canonical model this alias resolves to, cross-checked at runtime. */
const UNDERLYING = "claude-haiku-4-5"

/**
 * Claude Code, driven exactly as the CLI documents for headless use.
 *
 * Flags and why:
 *   -p                        headless, print-and-exit
 *   --output-format stream-json --verbose
 *                             per-assistant-message usage (for the exact
 *                             provider-request count) plus a final `result`
 *                             event carrying authoritative totals
 *   --setting-sources ""      ignore user/project/local settings so the
 *                             measurement is not polluted by this machine's
 *                             hooks, MCP servers or CLAUDE.md
 *   --permission-mode acceptEdits
 *                             applied on every task, not just the write task,
 *                             so the flag set is identical across tasks
 *   --no-session-persistence  single-turn tasks only; the 5-turn task must
 *                             persist in order to --resume
 */
export const claudeCode: Harness = {
  id: "claude-code",
  label: "Claude Code",
  pairing: "anthropic-haiku",
  model: MODEL,
  underlyingModel: UNDERLYING,
  pricingKey: UNDERLYING,
  // Claude Code reports usage for the invocation only; --resume starts a fresh count.
  usageIsCumulative: false,

  async available() {
    const probe = await exec({
      cmd: ["claude", "--version"],
      cwd: process.cwd(),
      env: baseEnv(),
      timeoutMs: 30_000,
    })
    if (probe.exitCode !== 0)
      return { ok: false as const, reason: `\`claude --version\` failed: ${probe.stderr.trim()}` }
    return { ok: true as const }
  },

  async run(args): Promise<TurnOutcome> {
    const cmd = [
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      MODEL,
      "--setting-sources",
      "",
      "--permission-mode",
      "acceptEdits",
    ]
    if (args.sessionId) cmd.push("--resume", args.sessionId)
    else if (!args.multiTurn) cmd.push("--no-session-persistence")
    cmd.push(args.prompt)

    const result = await exec({ cmd, cwd: args.workspace, env: baseEnv(), timeoutMs: args.timeoutMs })
    const events = parseNdjson(result.stdout)

    const failure = (error: string): TurnOutcome => ({
      ok: false,
      error,
      sessionId: null,
      text: "",
      usage: emptyUsage(),
      requests: [],
      providerRequests: 0,
      providerRequestsExact: true,
      toolCalls: 0,
      wallMs: result.wallMs,
      reportedCostUsd: null,
      exitCode: result.exitCode,
    })

    if (result.timedOut) return failure(`timed out after ${args.timeoutMs}ms`)

    const final = events.find((event) => event["type"] === "result")
    if (!final) {
      return failure(
        `no result event (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      )
    }
    if (final["is_error"] === true || final["subtype"] !== "success") {
      return failure(`claude reported ${String(final["subtype"])}: ${String(final["result"] ?? "").slice(0, 400)}`)
    }

    // Per-request usage. Streaming emits the same assistant message id more
    // than once (one event per content block) so dedupe by id, and take the
    // usage from the first sighting — the later ones repeat the same prompt
    // accounting.
    const seen = new Set<string>()
    const requests: RequestUsage[] = []
    let toolCalls = 0
    for (const event of events) {
      if (event["type"] !== "assistant") continue
      const message = event["message"] as Record<string, unknown> | undefined
      if (!message) continue
      const id = String(message["id"] ?? "")
      const content = message["content"]
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && (block as Record<string, unknown>)["type"] === "tool_use") {
            toolCalls += 1
          }
        }
      }
      if (!id || seen.has(id)) continue
      seen.add(id)
      requests.push({
        index: requests.length,
        usage: usageFromAnthropic((message["usage"] ?? {}) as Record<string, number>),
      })
    }

    // Totals come from the `result` event, not from summing the stream: the
    // per-message output_tokens in the stream are mid-stream snapshots and
    // under-report. Prompt-side numbers do agree between the two.
    const usage = usageFromAnthropic((final["usage"] ?? {}) as Record<string, number>)
    const numTurns = typeof final["num_turns"] === "number" ? final["num_turns"] : requests.length

    return {
      ok: true,
      error: null,
      sessionId: typeof final["session_id"] === "string" ? final["session_id"] : null,
      text: typeof final["result"] === "string" ? final["result"] : "",
      usage,
      requests,
      providerRequests: requests.length > 0 ? requests.length : numTurns,
      providerRequestsExact: requests.length > 0,
      toolCalls,
      wallMs: result.wallMs,
      reportedCostUsd: typeof final["total_cost_usd"] === "number" ? final["total_cost_usd"] : null,
      exitCode: result.exitCode,
    }
  },
}
