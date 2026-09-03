import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { baseEnv, exec, parseNdjson } from "../exec.ts"
import { emptyUsage, type Harness, type RequestUsage, type TurnOutcome, type Usage } from "../types.ts"
import { assertSafeForgeDb, BENCH_DIR, scratchRoot } from "../workspace.ts"

const REPO_ROOT = path.resolve(BENCH_DIR, "..", "..", "..", "..", "..")
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "forge", "src", "index.ts")

/**
 * A single throwaway secret-vault key, minted once per benchmark process and
 * reused by every TurenOS turn it spawns.
 *
 * Outside the desktop app the vault refuses to start without an OS-protected
 * key. NODE_ENV=test is one escape hatch, but it mints a *fresh random* key per
 * process, so the second turn of a conversation cannot reopen the database the
 * first turn claimed — it aborts with "Stored credentials belong to another
 * OS-protected key". Supplying the key explicitly makes it stable across turns,
 * which is what makes multi-turn measurement possible at all.
 *
 * This key never touches the user's real credentials: it is random, in-memory,
 * and only ever paired with a scratch database under the benchmark scratch root.
 */
const VAULT_KEY_ID = `token-bench-${randomUUID()}`
const VAULT_KEY = randomBytes(32).toString("base64")

/**
 * Environment for a headless TurenOS run.
 *
 * Because the vault key is throwaway, the user's real stored credentials are by
 * construction undecryptable here, so a scratch database is mandatory: pointing
 * at the real database would both fail and risk mutating real sessions.
 * `assertSafeForgeDb` enforces that.
 */
function turenEnv(runId: string, runKey: string, allowWrite: boolean): Record<string, string> {
  // The database must be unique per benchmark invocation, not just per run key.
  // NODE_ENV=test mints a fresh ephemeral vault key each process, and the auth
  // layer records the first key that claims a database; reusing a database
  // across invocations aborts with "Stored credentials belong to another
  // OS-protected key". It is still shared across the turns of one task, which
  // is what makes --session resume work.
  const dbDir = path.join(scratchRoot(), "db", runId)
  mkdirSync(dbDir, { recursive: true })
  const db = path.join(dbDir, `${runKey}.db`)
  assertSafeForgeDb(db)

  const env = baseEnv()
  env["FORGE_SECRET_VAULT_KEY_ID"] = VAULT_KEY_ID
  env["FORGE_SECRET_VAULT_KEY"] = VAULT_KEY
  env["FORGE_DB"] = db
  env["FORGE_PURE"] = "1"
  env["FORGE_DISABLE_AUTOUPDATE"] = "1"
  env["FORGE_DISABLE_AUTOCOMPACT"] = "1"
  env["FORGE_DISABLE_PROJECT_CONFIG"] = "1"
  // `forge run` auto-rejects any interactive permission prompt, so the write
  // task needs permissions granted up front or it would fail for a reason that
  // has nothing to do with token efficiency.
  env["FORGE_PERMISSION"] = JSON.stringify(
    allowWrite
      ? { "*": "allow", edit: "allow", bash: "allow" }
      : { read: "allow", grep: "allow", glob: "allow", list: "allow", bash: "allow" },
  )
  return env
}

function makeTuren(config: {
  id: string
  label: string
  pairing: string
  model: string
  underlyingModel: string
  pricingKey: string | null
  available: () => Promise<{ ok: true } | { ok: false; reason: string }>
}): Harness {
  return {
    id: config.id,
    label: config.label,
    pairing: config.pairing,
    model: config.model,
    underlyingModel: config.underlyingModel,
    pricingKey: config.pricingKey,
    // step_finish carries that step's own tokens; the runner sums them per turn.
    usageIsCumulative: false,
    available: config.available,

    async run(args): Promise<TurnOutcome> {
      const cmd = [
        "bun",
        "run",
        "--conditions=browser",
        CLI_ENTRY,
        "run",
        "--dir",
        args.workspace,
        "--format",
        "json",
        "--model",
        config.model,
      ]
      if (args.sessionId) cmd.push("--session", args.sessionId)
      cmd.push(args.prompt)

      const result = await exec({
        cmd,
        // Run from the repo root so `bun run` resolves the workspace; the agent's
        // working directory is set by --dir.
        cwd: REPO_ROOT,
        env: turenEnv(args.runId, args.runKey, args.allowWrite),
        timeoutMs: args.timeoutMs,
      })
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

      const errorEvent = events.find((event) => event["type"] === "error")
      if (errorEvent) return failure(`forge error: ${JSON.stringify(errorEvent["error"]).slice(0, 400)}`)

      // One step_finish per provider round-trip, each carrying that step's own
      // token accounting (Anthropic-shaped: input excludes cache).
      const requests: RequestUsage[] = []
      let total: Usage = emptyUsage()
      let text = ""
      let toolCalls = 0
      let sessionId: string | null = args.sessionId
      let reportedCost = 0
      let sawCost = false

      for (const event of events) {
        if (typeof event["sessionID"] === "string") sessionId = event["sessionID"]
        const part = event["part"] as Record<string, unknown> | undefined
        switch (event["type"]) {
          case "tool_use":
            toolCalls += 1
            break
          case "text":
            if (part && typeof part["text"] === "string") text = part["text"]
            break
          case "step_finish": {
            const tokens = part?.["tokens"] as Record<string, unknown> | undefined
            if (!tokens) break
            const cache = (tokens["cache"] ?? {}) as Record<string, unknown>
            const usage: Usage = {
              inputTokens: num(tokens["input"]),
              cacheReadTokens: num(cache["read"]),
              cacheWriteTokens: num(cache["write"]),
              outputTokens: num(tokens["output"]),
              reasoningTokens: num(tokens["reasoning"]),
              contextTokens: num(tokens["input"]) + num(cache["read"]) + num(cache["write"]),
            }
            requests.push({ index: requests.length, usage })
            total = {
              inputTokens: total.inputTokens + usage.inputTokens,
              cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
              cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
              outputTokens: total.outputTokens + usage.outputTokens,
              reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
              contextTokens: total.contextTokens + usage.contextTokens,
            }
            if (typeof part?.["cost"] === "number") {
              sawCost = true
              reportedCost += part["cost"] as number
            }
            break
          }
        }
      }

      if (requests.length === 0) {
        return failure(
          `no step_finish events (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
        )
      }

      return {
        ok: true,
        error: null,
        sessionId,
        text,
        usage: total,
        requests,
        providerRequests: requests.length,
        providerRequestsExact: true,
        toolCalls,
        wallMs: result.wallMs,
        // Subscription-backed providers report 0; that is a real reported value,
        // not a missing one, so keep it.
        reportedCostUsd: sawCost ? reportedCost : null,
        exitCode: result.exitCode,
      }
    },
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * TurenOS driving the local Claude Code subscription as a provider. This is the
 * fair pairing against the Claude Code CLI: identical underlying model,
 * identical account, so any delta is harness overhead.
 */
export const turenClaudeCode: Harness = makeTuren({
  id: "turen-claude-code",
  label: "TurenOS (claude-code provider)",
  pairing: "anthropic-haiku",
  model: process.env["TOKEN_BENCH_TUREN_CC_MODEL"] ?? "claude-code/haiku",
  underlyingModel: "claude-haiku-4-5",
  pricingKey: "claude-haiku-4-5",
  async available() {
    const probe = await exec({
      cmd: ["claude", "auth", "status", "--json"],
      cwd: process.cwd(),
      env: baseEnv(),
      timeoutMs: 30_000,
    })
    if (probe.exitCode !== 0) {
      return { ok: false as const, reason: "claude-code provider requires an authenticated `claude` CLI" }
    }
    return { ok: true as const }
  },
})

/**
 * TurenOS driving OpenAI directly. This is the fair pairing against Codex.
 *
 * It needs an OPENAI_API_KEY in the environment: the benchmark runs against a
 * scratch database with an ephemeral vault key, so the user's stored OAuth
 * credential is by construction undecryptable here. Without a key this arm is
 * reported as `blocked`, never estimated.
 */
export const turenOpenai: Harness = makeTuren({
  id: "turen-openai",
  label: "TurenOS (openai provider)",
  pairing: "openai-codex",
  model: process.env["TOKEN_BENCH_TUREN_OPENAI_MODEL"] ?? "openai/gpt-5-mini",
  underlyingModel: process.env["TOKEN_BENCH_TUREN_OPENAI_MODEL"]?.split("/").slice(1).join("/") ?? "gpt-5-mini",
  pricingKey: process.env["TOKEN_BENCH_TUREN_OPENAI_MODEL"]?.split("/").slice(1).join("/") ?? "gpt-5-mini",
  async available() {
    if (!process.env["OPENAI_API_KEY"]) {
      return {
        ok: false as const,
        reason:
          "OPENAI_API_KEY is not set. TurenOS runs here against a scratch DB with an ephemeral vault key, so the " +
          "stored OpenAI OAuth credential cannot be decrypted; this arm needs an API key in the environment.",
      }
    }
    return { ok: true as const }
  },
})
