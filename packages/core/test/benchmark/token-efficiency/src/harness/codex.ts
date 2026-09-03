import { baseEnv, exec, parseNdjson } from "../exec.ts"
import { emptyUsage, usageFromCodex, type Harness, type TurnOutcome } from "../types.ts"

const MODEL = process.env["TOKEN_BENCH_CODEX_MODEL"] ?? "gpt-5.6-sol"
/**
 * Reasoning effort is pinned rather than inherited from ~/.codex/config.toml,
 * which on a developer machine is usually "high". Leaving it unpinned makes the
 * benchmark unreproducible across machines.
 */
const EFFORT = process.env["TOKEN_BENCH_CODEX_EFFORT"] ?? "low"

/**
 * Codex CLI in non-interactive exec mode.
 *
 *   --json                    JSONL event stream; the final `turn.completed`
 *                             carries usage for the turn
 *   --skip-git-repo-check     workspaces are git repos, but this keeps the
 *                             harness usable if that ever changes
 *   --ignore-user-config      do not load this machine's ~/.codex/config.toml,
 *                             matching --setting-sources "" on Claude Code
 *   -c sandbox_mode=...       workspace-write only for the write task; read
 *                             tasks stay read-only so Codex is not handed more
 *                             privilege than it needs
 *
 * The working root comes from the child process cwd rather than `-C`, because
 * `codex exec resume` does not accept `-C` (nor `-s`). Using cwd keeps the flag
 * set byte-identical between the first turn and every resumed turn, which
 * matters when the thing being measured is per-turn context growth.
 */
export const codex: Harness = {
  id: "codex",
  label: "Codex CLI",
  pairing: "openai-codex",
  model: MODEL,
  underlyingModel: MODEL,
  pricingKey: MODEL,
  // Verified empirically: resuming a thread and sending a two-word prompt reports
  // exactly double the previous turn's cached_input_tokens. See types.ts.
  usageIsCumulative: true,

  async available() {
    const probe = await exec({
      cmd: ["codex", "--version"],
      cwd: process.cwd(),
      env: baseEnv(),
      timeoutMs: 30_000,
    })
    if (probe.exitCode !== 0)
      return { ok: false as const, reason: `\`codex --version\` failed: ${probe.stderr.trim()}` }
    return { ok: true as const }
  },

  async run(args): Promise<TurnOutcome> {
    const common = [
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-m",
      MODEL,
      "-c",
      `model_reasoning_effort="${EFFORT}"`,
      "-c",
      `sandbox_mode="${args.allowWrite ? "workspace-write" : "read-only"}"`,
    ]
    const cmd = args.sessionId
      ? ["codex", "exec", "resume", ...common, args.sessionId, args.prompt]
      : ["codex", "exec", ...common, args.prompt]

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
      providerRequestsExact: false,
      toolCalls: 0,
      wallMs: result.wallMs,
      reportedCostUsd: null,
      exitCode: result.exitCode,
    })

    if (result.timedOut) return failure(`timed out after ${args.timeoutMs}ms`)

    const failed = events.find((event) => event["type"] === "turn.failed")
    if (failed) {
      const detail = (failed["error"] as Record<string, unknown> | undefined)?.["message"]
      return failure(`codex turn.failed: ${String(detail ?? "").slice(0, 400)}`)
    }

    const completed = events.find((event) => event["type"] === "turn.completed")
    if (!completed) {
      const err = events.find((event) => event["type"] === "error")
      return failure(
        `no turn.completed event (exit ${result.exitCode}): ${String(err?.["message"] ?? result.stderr).slice(0, 400)}`,
      )
    }

    const started = events.find((event) => event["type"] === "thread.started")
    const sessionId = typeof started?.["thread_id"] === "string" ? started["thread_id"] : args.sessionId

    let text = ""
    let toolCalls = 0
    let assistantItems = 0
    for (const event of events) {
      if (event["type"] !== "item.completed") continue
      const item = event["item"] as Record<string, unknown> | undefined
      if (!item) continue
      const kind = item["type"]
      if (kind === "agent_message") {
        assistantItems += 1
        if (typeof item["text"] === "string") text = item["text"]
      } else if (kind === "command_execution" || kind === "file_change" || kind === "mcp_tool_call") {
        toolCalls += 1
        assistantItems += 1
      } else if (kind === "error") {
        // Non-fatal notices (e.g. unknown model metadata) — recorded via stderr.
      }
    }

    return {
      ok: true,
      error: null,
      sessionId,
      text,
      usage: usageFromCodex((completed["usage"] ?? {}) as Record<string, number>),
      // Codex reports usage once per exec turn, not per provider round-trip,
      // so per-request usage is genuinely unavailable here.
      requests: [],
      // APPROXIMATE: counted as one provider response per emitted item. A
      // single response can emit several items, so this is a lower bound on
      // items and an upper bound on requests. Flagged as inexact so the report
      // never presents it as measured.
      providerRequests: assistantItems,
      providerRequestsExact: false,
      toolCalls,
      wallMs: result.wallMs,
      // Codex reports no cost field.
      reportedCostUsd: null,
      exitCode: result.exitCode,
    }
  },
}
