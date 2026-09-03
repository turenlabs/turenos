// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

const liveKimi = process.env.FORGE_TEST_KIMI === "1"

// Set XDG env vars FIRST, before any src/ imports
const dir = path.join(os.tmpdir(), "forge-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  const { AppRuntime } = await import("../src/effect/app-runtime")
  await AppRuntime.dispose()

  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1 && process.platform !== "win32") throw error
      if (left <= 1) return
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)
})

if (!liveKimi) {
  process.env["XDG_DATA_HOME"] = path.join(dir, "share")
  process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
  process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
  process.env["XDG_STATE_HOME"] = path.join(dir, "state")
  process.env["FORGE_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
}
process.env["FORGE_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
process.env["FORGE_EXPERIMENTAL_WORKSPACES"] = "true"

// Pin how `forge` resolves to a spawnable CLI for the whole test process.
//
// Without this, `resolvePtyCommand` falls back to `process.argv[1]`, which under
// `bun test` is whichever test file is currently executing. Anything that spawns the
// `forge` CLI (the managed security MCP server, PTY sessions) then re-executes a test
// file as if it were Forge: it cannot speak JSON-RPC, the transport closes, and the
// caller sees `MCP error -32000: Connection closed`. It only reproduced intermittently
// because it depended on test file ordering.
//
// Resolving nothing is not a safe alternative: `MCP.state` calls `Effect.die` when
// security is configured but no binary can be located, so a machine without `forge` on
// PATH (every CI runner) would fail a different set of tests instead. Pinning the real
// source entrypoint makes the resolution deterministic and independent of both the
// current test file and the developer's PATH.
process.env["FORGE_CLI_COMMAND"] = process.execPath
process.env["FORGE_CLI_ENTRY"] = path.join(import.meta.dir, "..", "src", "index.ts")

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configuration.
if (!liveKimi) {
  const testHome = path.join(dir, "home")
  await fs.mkdir(testHome, { recursive: true })
  process.env["FORGE_TEST_HOME"] = testHome
}

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["FORGE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "opencode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["FORGE_SERVER_PASSWORD"]
delete process.env["FORGE_SERVER_USERNAME"]
delete process.env["FORGE_EXPERIMENTAL"]
delete process.env["FORGE_ENABLE_EXPERIMENTAL_MODELS"]
delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
delete process.env["OTEL_EXPORTER_OTLP_HEADERS"]
delete process.env["OTEL_RESOURCE_ATTRIBUTES"]

// Use in-memory sqlite
if (!liveKimi) process.env["FORGE_DB"] = ":memory:"

// Now safe to import from src/
const { initProjectors } = await import("../src/server/projectors")

initProjectors()
