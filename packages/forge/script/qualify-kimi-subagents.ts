import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createForgeClient } from "@turenlabs/sdk/v2"

const providerID = "kimi-for-coding"
const modelID = "k3"
const parentMarker = "KIMI_PARENT_SUBAGENT_OK"
const childMarker = "KIMI_CHILD_ADVERSARIAL_OK"
const root = path.resolve(import.meta.dir, "../../..")
const home = await fs.mkdtemp(path.join(os.tmpdir(), "forge-kimi-subagent-"))
const workspace = path.join(home, "workspace")
const secret = process.env.KIMI_API_KEY ?? ""
if (!secret) throw new Error("Set KIMI_API_KEY before running Kimi subagent qualification")

const port = 41_000 + Math.floor(Math.random() * 2_000)
const url = `http://127.0.0.1:${port}`
const config = {
  formatter: false,
  lsp: false,
  provider: {
    [providerID]: {
      name: "Kimi for Coding",
      id: providerID,
      env: ["KIMI_API_KEY"],
      npm: "@ai-sdk/anthropic",
      api: "https://api.kimi.com/coding/v1",
      options: {},
      models: {
        [modelID]: {
          id: modelID,
          name: "Kimi K3",
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_048_576, output: 131_072 },
        },
      },
    },
  },
}
await fs.mkdir(workspace)
await fs.writeFile(path.join(workspace, "forge.json"), JSON.stringify(config))
const initialized = Bun.spawnSync(["git", "init", "--quiet", workspace])
if (initialized.exitCode !== 0) throw new Error("Failed to initialize isolated qualification workspace")
const proc = Bun.spawn(
  [
    "bun",
    "run",
    "--conditions=browser",
    path.join(root, "packages", "forge", "src", "index.ts"),
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      FORGE_TEST_HOME: home,
      KIMI_API_KEY: secret,
      FORGE_CONFIG_CONTENT: JSON.stringify(config),
      FORGE_DISABLE_PROJECT_CONFIG: "1",
      FORGE_DISABLE_MODELS_FETCH: "1",
      FORGE_DISABLE_AUTOUPDATE: "1",
      FORGE_DISABLE_AUTOCOMPACT: "1",
      FORGE_PURE: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
)
const stdout = new Response(proc.stdout).text()
const stderr = new Response(proc.stderr).text()
let failure: unknown
let inspectFailure: (() => Promise<unknown>) | undefined

try {
  await poll(
    async () => {
      if (proc.exitCode !== null) throw new Error(`TurenOS server exited before startup: ${proc.exitCode}`)
      return fetch(url, { signal: AbortSignal.timeout(1_000) }).then(
        () => true,
        () => undefined,
      )
    },
    30_000,
    "TurenOS server did not start",
  )
  const sdk = createForgeClient({ baseUrl: url, directory: workspace })
  // Model catalog management is not part of the public SDK anymore; session creation is the
  // retained contract used by this qualification.
  const created = await sdk.v2.session.create({
    agent: "build",
    model: { providerID, id: modelID },
    location: { directory: workspace },
  })
  if (created.response.status !== 200)
    throw new Error(`Session create failed with HTTP ${created.response.status}: ${safe(created.error)}`)
  const sessionID = String(record(record(created.data).data).id)
  inspectFailure = async () => {
    const [tasks, context, history, active] = await Promise.all([
      sdk.v2.session.task.list({ sessionID }),
      sdk.v2.session.context({ sessionID }),
      sdk.v2.session.history({ sessionID, limit: 100 }),
      sdk.v2.session.active(),
    ])
    return { tasks, context, history, active }
  }
  const prompted = await sdk.v2.session.prompt({
    sessionID,
    prompt: {
      text: [
        "This is a bounded TurenOS subagent qualification.",
        `Call spawn_agent exactly once with agent adversarial-review and ask it to reply exactly ${childMarker}.`,
        "Then call wait_agents for that task.",
        `After the completed child result is returned, reply exactly ${parentMarker}.`,
        "Do not call shell, filesystem, network, or any other tool.",
      ].join(" "),
    },
  })
  if (prompted.response.status !== 200)
    throw new Error(`Session prompt failed with HTTP ${prompted.response.status}: ${safe(prompted.error)}`)
  const taskStarted = Date.now()
  let observedActive = false
  const task = await poll(
    async () => {
      const [result, active] = await Promise.all([sdk.v2.session.task.list({ sessionID }), sdk.v2.session.active()])
      const item = record(array(record(result.data).data)[0])
      const sessions = record(record(active.data).data)
      const running = sessionID in sessions || String(item.childSessionID) in sessions
      if (running) observedActive = true
      if (item.status === "completed") return item
      if ((observedActive || Date.now() - taskStarted > 15_000) && !running) {
        throw new Error(`Kimi run became idle before its subagent completed (task status: ${String(item.status)})`)
      }
      return undefined
    },
    180_000,
    "Kimi subagent task did not complete",
  )
  const context = await poll(
    async () => {
      const result = await sdk.v2.session.context({ sessionID })
      return JSON.stringify(result.data).includes(parentMarker) ? result.data : undefined
    },
    180_000,
    "Kimi parent did not finish after the child result",
  )
  await poll(
    async () => {
      const result = await sdk.v2.session.active()
      return sessionID in record(record(result.data).data) ||
        String(task.childSessionID) in record(record(result.data).data)
        ? undefined
        : true
    },
    30_000,
    "Kimi parent or child remained active",
  )

  console.log(
    JSON.stringify({
      providerID,
      modelID,
      sessionID,
      taskID: task.id,
      childSessionID: task.childSessionID,
      agent: task.agent,
      status: task.status,
      childMarker: String(task.result).includes(childMarker),
      parentMarker: JSON.stringify(context).includes(parentMarker),
      active: false,
    }),
  )
} catch (error) {
  const diagnostics = inspectFailure
    ? await inspectFailure().catch((cause) => ({
        inspectionError: cause instanceof Error ? cause.message : String(cause),
      }))
    : undefined
  failure = new Error(
    `${error instanceof Error ? error.message : String(error)}${
      diagnostics === undefined ? "" : `\nV2 diagnostics: ${safe(diagnostics)}`
    }`,
  )
} finally {
  proc.kill()
  await Promise.race([proc.exited, Bun.sleep(5_000)])
  await fs.rm(home, { recursive: true, force: true })
}
if (failure) {
  const logs = `${await stdout}\n${await stderr}`.split(secret).join("[REDACTED]").slice(-8_000)
  throw new Error(`${failure instanceof Error ? failure.message : String(failure)}\n${logs}`)
}

async function poll<T>(
  run: () => Promise<T | undefined>,
  timeout: number,
  message: string | (() => string),
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await run()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(typeof message === "string" ? message : message())
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function safe(value: unknown) {
  return (JSON.stringify(value) ?? "").split(secret).join("[REDACTED]").slice(0, 2_000)
}
