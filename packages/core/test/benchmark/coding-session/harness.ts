export * as CodingHarness from "./harness"

import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { CodingEvents } from "./events"
import { CodingWorkspace } from "./workspace"

export type Input = {
  directory: string
  scratch: string
  model: string
  effort: string
  prompt: string
  timeout: number
  session?: string
}

type Turn = CodingEvents.Metrics & {
  session?: string
  elapsedMs: number
  status: "ok" | "failed" | "timeout" | "incomplete-stream"
  exit: number
}

const server = "http://127.0.0.1:4096"

export async function distance(input: Input): Promise<Turn> {
  const config = path.join(input.scratch, "config", "distance-cli")
  mkdirSync(config, { recursive: true })
  await Bun.write(path.join(config, "config.toml"), `[effort]\n"chatgpt/${input.model}" = "${input.effort}"\n`)
  const env = {
    ...CodingWorkspace.baseEnv(),
    AGENTS_HOME: path.join(input.scratch, "agents"),
    XDG_CONFIG_HOME: path.dirname(config),
    ...(process.env.XDG_DATA_HOME ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {}),
    ...(process.env.DISTANCE_CLI_AUTH_ROOT_KEY
      ? { DISTANCE_CLI_AUTH_ROOT_KEY: process.env.DISTANCE_CLI_AUTH_ROOT_KEY }
      : {}),
  }
  const metrics = CodingEvents.empty()
  const timeout = AbortSignal.timeout(input.timeout * 1000)
  const command = [
    "distance-cli",
    "run",
    "--no-project-context",
    "--mode",
    "auto",
    "--max-steps",
    "12",
    "--model",
    `chatgpt/${input.model}`,
    "--output-format",
    "stream-json",
    ...["bash", "web_fetch", "web_search", "spawn_agent"].flatMap((tool) => ["--deny", tool]),
    ...(input.session ? ["--resume", input.session] : []),
    "--",
    input.prompt,
  ]
  const started = performance.now()
  const child = Bun.spawn(command, {
    cwd: input.directory,
    env,
    signal: timeout,
    stdin: "ignore",
    stderr: "ignore",
    stdout: "pipe",
  })
  let result: Record<string, unknown> = {}
  for await (const line of CodingEvents.lines(child.stdout)) {
    if (!line.trim()) continue
    const row = CodingEvents.parse(line)
    if (row.type === "result") result = row
    CodingEvents.distance(metrics, row, performance.now() - started)
  }
  const exit = await child.exited
  const session = typeof result.session_id === "string" ? result.session_id : undefined
  const status = timeout.aborted ? "timeout" : exit === 0 && session && result.is_error === false ? "ok" : "failed"
  return { ...metrics, status, exit, session, elapsedMs: performance.now() - started }
}

export async function turen(input: Input): Promise<Turn> {
  const session = input.session ?? `ses_${randomUUID().replaceAll("-", "")}`
  const password = process.env.FORGE_SERVER_PASSWORD
  const username = process.env.FORGE_SERVER_USERNAME || "forge"
  const env = {
    ...CodingWorkspace.baseEnv(),
    FORGE_SERVER_USERNAME: username,
    ...(password === undefined ? {} : { FORGE_SERVER_PASSWORD: password }),
  }
  const headers: Record<string, string> =
    password === undefined
      ? {}
      : { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
  const metrics = CodingEvents.empty()
  const controller = new AbortController()
  // Subscribe before submitting so the first streamed delta cannot beat the reader.
  const timeout = AbortSignal.timeout((input.timeout + 5) * 1000)
  const signal = AbortSignal.any([controller.signal, timeout])
  const events = await fetch(`${server}/api/event`, { headers, signal, redirect: "error", proxy: "", timeout: false })
  if (!events.ok || !events.body) {
    await events.body?.cancel()
    throw new Error(`TurenOS event feed HTTP ${events.status}; check the local server and FORGE_SERVER_PASSWORD`)
  }
  const rows = CodingEvents.lines(events.body)
  try {
    const ready = await rows.next()
    if (ready.done || !ready.value.startsWith("data:")) throw new Error("TurenOS event feed closed before readiness")
    const started = performance.now()
    const settlements = CodingEvents.settlements()
    const collect = (async () => {
      for await (const line of rows) {
        if (!line.startsWith("data:") || !line.includes(session)) continue
        const id = CodingEvents.turen(metrics, CodingEvents.parse(line.slice(5)), session, performance.now() - started)
        if (id) settlements.record(id)
      }
    })().catch(() => {})
    const target = input.session
      ? [input.session]
      : [
          "--new",
          "--dir",
          input.directory,
          "--session-id",
          session,
          "--agent",
          "build",
          "--model",
          `openai/${input.model}`,
          "--variant",
          input.effort,
        ]
    const child = Bun.spawn(
      [
        "turen-tui",
        "send",
        ...target,
        "--url",
        server,
        "--wait",
        "--timeout",
        `${input.timeout}`,
        "--json",
        "--",
        input.prompt,
      ],
      { cwd: input.directory, env, signal, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    )
    const output = await new Response(child.stdout).text()
    const exit = await child.exited
    const elapsedMs = performance.now() - started
    const result = exit === 0 ? CodingEvents.parse(output) : {}
    const id = CodingEvents.object(result.message).id
    const idle = result.state === "idle"
    // The wait command reads durable state on a separate connection. Give the live feed a chance to catch up.
    const streamOk = idle && typeof id === "string" && (await settlements.wait(id, collect, Bun.sleep(2000)))
    controller.abort()
    await collect
    if (exit !== 0 || timeout.aborted) {
      // A waiter exiting doesn't cancel an admitted turn. Stop only the session this run created.
      await Bun.spawn(["turen-tui", "stop", session, "--url", server], {
        cwd: input.directory,
        env,
        stdout: "ignore",
        stderr: "ignore",
        signal: AbortSignal.timeout(5000),
      }).exited
    }
    const status = timeout.aborted || exit === 4 ? "timeout" : !idle ? "failed" : !streamOk ? "incomplete-stream" : "ok"
    return { ...metrics, status, exit, session, elapsedMs }
  } finally {
    controller.abort()
    await rows.return(undefined).catch(() => {})
  }
}
