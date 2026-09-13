#!/usr/bin/env bun

// Qualifies staged native backend + renderer assets, not an Electron GUI or source runtime.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktop = fileURLToPath(new URL("..", import.meta.url))
const binary = path.join(desktop, "resources", process.platform === "win32" ? "forge-cli.exe" : "forge-cli")
const limit = 1024 * 1024
const controller = new AbortController()
// Reserve 15 seconds of the 90-second budget for exact-child termination and Windows cleanup.
const overall = setTimeout(() => controller.abort(new Error("whiteboard smoke exceeded 75-second work budget")), 75_000)
const children: ReturnType<typeof launch>[] = []
let owned: string | undefined
let step = "renderer-assets"

function pass(label: string) {
  console.log(`[whiteboard-artifact] PASS ${label}`)
}

async function bounded<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function launch(workspace: string, env: NodeJS.ProcessEnv) {
  controller.signal.throwIfAborted()
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const state = { output: "", stdout: "", bytes: 0, closed: false }
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      state.closed = true
      resolve()
    }),
  )
  const ready = new Promise<string>((resolve, reject) => {
    child.once("error", reject)
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
    child.once("close", (code, signal) => reject(new Error(`staged CLI closed (${code ?? signal})\n${state.output}`)))
    const capture = (chunk: Buffer, stdout: boolean) => {
      state.bytes += chunk.length
      state.output = (state.output + chunk.toString()).slice(-16_384)
      if (state.bytes > limit) {
        controller.abort(new Error("staged CLI exceeded 1MiB output cap"))
        reject(controller.signal.reason)
        return
      }
      if (!stdout) return
      state.stdout = (state.stdout + chunk.toString()).slice(-4096)
      const match = state.stdout.match(/forge server listening on (http:\/\/127\.0\.0\.1:(\d+))(?=\s)/)
      if (!match) return
      const port = Number(match[2])
      if (port < 1 || port > 65535) return reject(new Error("CLI reported invalid listening port"))
      resolve(match[1]!)
    }
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, true))
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, false))
  })
  return {
    ready: () => bounded(ready, 30_000, "staged CLI startup"),
    async stop() {
      if (state.closed) return
      child.kill("SIGTERM")
      await bounded(closed, 3000, "CLI graceful shutdown").catch(() => undefined)
      if (state.closed) return
      child.kill("SIGKILL")
      await bounded(closed, 3000, "CLI forced shutdown")
    },
    diagnostics: () => state.output,
  }
}

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "expected JSON object")
  return value as Record<string, unknown>
}

function shape(id: string, version = 1) {
  return {
    id,
    type: "rectangle",
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    angle: 0,
    version,
    versionNonce: 10,
    isDeleted: false,
  }
}

try {
  const notices = await stat(path.join(desktop, "out/renderer/excalidraw/FONT-NOTICES.txt"))
  assert(notices.isFile() && notices.size > 0, "missing font notices")
  const fonts = path.join(desktop, "out/renderer/excalidraw/fonts/Excalifont")
  const files = (await readdir(fonts)).filter((name) => name.endsWith(".woff2"))
  assert(files.length > 0, "missing local Excalifont fonts")
  for (const name of files) {
    const info = await stat(path.join(fonts, name))
    assert(info.isFile() && info.size > 0, `empty Excalifont asset: ${name}`)
  }
  assert((await stat(binary)).isFile(), `missing staged native CLI: ${binary}`)
  pass(`${step} (${files.length} local Excalifont files)`)

  step = "isolated-native-startup"
  owned = await mkdtemp(path.join(os.tmpdir(), "forge-whiteboard-artifact-"))
  owned = await realpath(owned)
  const workspace = path.join(owned, "workspace")
  const dirs = Object.fromEntries(
    ["home", "config", "cache", "data", "state", "managed", "runtime"].map((name) => [name, path.join(owned!, name)]),
  )
  await Promise.all([workspace, ...Object.values(dirs)].map((dir) => mkdir(dir, { recursive: true })))
  // Data only: never import the source server, source services, or test preload.
  const models = path.join(owned, "models.json")
  const fixture = path.join(desktop, "../forge/test/tool/fixtures/models-api.json")
  assert((await stat(fixture)).size <= 16 * limit, "offline model fixture exceeds 16MiB cap")
  await copyFile(fixture, models)
  const model = { providerID: "openai", id: "gpt-4o" }
  const password = randomBytes(24).toString("base64")
  // Allowlist OS essentials rather than inherit provider credentials, proxy settings,
  // NODE_OPTIONS, or user Forge configuration from a release runner/developer shell.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL)$/i.test(key)),
  )
  Object.assign(env, {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    APPDATA: dirs.config,
    LOCALAPPDATA: dirs.data,
    TMPDIR: owned,
    TMP: owned,
    TEMP: owned,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.runtime,
    FORGE_TEST_HOME: dirs.home,
    FORGE_TEST_MANAGED_CONFIG_DIR: dirs.managed,
    FORGE_CONFIG_DIR: dirs.config,
    FORGE_DB: path.join(owned, "whiteboard.sqlite"),
    FORGE_SECRET_VAULT_KEY: randomBytes(32).toString("base64"),
    FORGE_SECRET_VAULT_KEY_ID: "whiteboard-artifact",
    FORGE_SERVER_PASSWORD: password,
    FORGE_SERVER_USERNAME: "forge",
    USERNAME: "forge",
    FORGE_DISABLE_DEFAULT_PLUGINS: "true",
    FORGE_DISABLE_PROJECT_CONFIG: "true",
    FORGE_DISABLE_CLAUDE_CODE: "true",
    FORGE_DISABLE_MODELS_FETCH: "true",
    FORGE_MODELS_PATH: models,
    FORGE_DISABLE_AUTOUPDATE: "true",
    FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    FORGE_CONFIG_CONTENT: JSON.stringify({ plugin: [], formatter: false, lsp: false }),
  })
  const first = launch(workspace, env)
  children.push(first)
  let base = await first.ready()
  pass(step)
  const authorization = `Basic ${Buffer.from(`forge:${password}`).toString("base64")}`
  const request = (route: string, init: RequestInit = {}, authenticated = true) => {
    const headers = new Headers(init.headers)
    headers.set("x-forge-directory", workspace)
    if (authenticated) headers.set("authorization", authorization)
    return fetch(new URL(route, base), {
      ...init,
      headers,
      signal: init.signal ?? controller.signal,
      redirect: "error",
    })
  }
  const json = (route: string, method: string, body: unknown) =>
    request(route, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const body = async (response: Response, status = 200): Promise<unknown> => {
    assert(response.body, "missing HTTP body")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        assert(size <= limit, "HTTP response exceeded 1MiB cap")
        chunks.push(chunk.value)
      }
      const text = Buffer.concat(chunks).toString()
      assert.equal(response.status, status, `unexpected HTTP status for ${response.url}: ${text.slice(0, 2048)}`)
      return JSON.parse(text) as unknown
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  step = "authentication-and-session"
  const denied = await request("/api/session", {}, false)
  assert.equal(denied.status, 401)
  await denied.body?.cancel()
  const created = record(
    await body(
      await json("/api/session", "POST", {
        agent: "build",
        model,
        location: { directory: workspace },
      }),
    ),
  )
  const sessionID = record(created.data).id
  assert.equal(typeof sessionID, "string")
  const route = `/api/session/${encodeURIComponent(String(sessionID))}/whiteboard`
  const missingAuth = await request(route, {}, false)
  assert.equal(missingAuth.status, 401)
  await missingAuth.body?.cancel()
  const empty = record(await body(await request(route)))
  assert.deepEqual(empty.elements, [])
  assert.equal(empty.revision, 0)
  pass(step)

  step = "concurrent-independent-patches"
  const update = (id: string, version = 1, baseRevision?: number) =>
    json(route, "PATCH", {
      clientID: id,
      username: id,
      patch: { elements: [shape(id, version)], ...(baseRevision === undefined ? {} : { baseRevision }) },
    })
  await Promise.all(["a", "b"].map(async (id) => body(await update(id))))
  const saved = record(await body(await request(route)))
  assert.equal(saved.revision, 2)
  assert(Array.isArray(saved.elements))
  assert.deepEqual(
    saved.elements.map(record).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    [shape("a"), shape("b")],
  )
  pass(step)

  step = "stale-revision-conflict"
  const conflict = record(await body(await update("a", 2, 0), 409))
  assert.equal(conflict.expectedRevision, 0)
  assert.equal(conflict.actualRevision, 2)
  assert.deepEqual(await body(await request(route)), saved)
  pass(step)

  step = "sse-connected-presence-update-abort"
  await body(await json(`${route}/presence`, "POST", { clientID: "a", username: "a", pointer: { x: 3, y: 4 } }))
  const streamAbort = new AbortController()
  const response = await request(`${route}/events`, {
    signal: AbortSignal.any([controller.signal, streamAbort.signal]),
  })
  assert.equal(response.status, 200)
  assert(response.headers.get("content-type")?.includes("text/event-stream"))
  assert(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<Record<string, unknown>> => {
    while (true) {
      const end = buffer.indexOf("\n\n")
      if (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) return record(JSON.parse(data))
        continue
      }
      const chunk = await reader.read()
      assert(!chunk.done, "SSE ended before expected event")
      buffer += decoder.decode(chunk.value, { stream: true })
      buffer = buffer.replace(/\r\n/g, "\n")
      assert(buffer.length <= limit, "SSE frame exceeded 1MiB cap")
    }
  }
  try {
    const connected = await bounded(next(), 5000, "SSE connected")
    assert.equal(connected.type, "session.whiteboard.connected")
    assert.deepEqual(connected.data, { sessionID, revision: 2 })
    const presence = await bounded(next(), 5000, "SSE presence")
    assert.equal(presence.type, "session.whiteboard.presence")
    const participants = record(presence.data).participants
    assert(Array.isArray(participants) && participants.some((item: unknown) => record(item).clientID === "a"))
    await body(await update("a", 2))
    const updated = await bounded(next(), 5000, "SSE update")
    assert.equal(updated.type, "session.whiteboard.updated")
    assert.equal(record(updated.data).sessionID, sessionID)
    assert.equal(record(updated.data).revision, 3)
  } finally {
    streamAbort.abort()
    await bounded(
      reader.cancel().catch(() => undefined),
      2000,
      "SSE cancellation",
    )
    reader.releaseLock()
  }
  pass(step)

  step = "v2-tool-registration"
  // /experimental/tool/ids is intentionally the legacy registry. This diagnostic
  // materializes the real V2 Session snapshot without executing a provider turn.
  // Legacy-mounted diagnostics route placement through query parameters, as the SDK does.
  const query = new URLSearchParams({
    provider: model.providerID,
    model: model.id,
    sessionID: String(sessionID),
    directory: workspace,
  })
  const tools = record(await body(await request(`/experimental/tool?${query}`)))
  assert.equal(tools.sessionID, sessionID)
  assert(Array.isArray(tools.visible), "missing V2 tool snapshot")
  // Whiteboard tools are deferred: they sit in the deferred catalog and
  // auto-load on first use rather than occupying the visible snapshot.
  const names = [
    ...tools.visible.map((tool: unknown) => record(tool).id),
    ...(((tools.deferred as { available?: unknown[] } | undefined)?.available ?? []).map(
      (item: unknown) => record(item).name,
    ) as string[]),
  ]
  assert(names.includes("whiteboard_read") && names.includes("whiteboard_update"), "V2 whiteboard tools not registered")
  pass(step)

  step = "restart-persistence"
  const persisted = await body(await request(route))
  await first.stop()
  const second = launch(workspace, env)
  children.push(second)
  base = await second.ready()
  const restored = record(await body(await request(route)))
  assert.deepEqual(restored, persisted)
  assert(Array.isArray(restored.elements))
  assert.deepEqual(
    restored.elements.map(record).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    [shape("a", 2), shape("b")],
  )
  pass(step)
} catch (error) {
  console.error(`[whiteboard-artifact] FAIL ${step}`)
  for (const child of children) console.error(child.diagnostics())
  throw error
} finally {
  controller.abort()
  try {
    await Promise.all(children.map((child) => child.stop()))
    // Remove only after close; if termination fails, retain the owned directory for diagnosis.
    // mkdtemp is the sole source of this path; never remove the workspace or user home.
    if (owned) await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } finally {
    clearTimeout(overall)
  }
}
console.log("[whiteboard-artifact] PASS native backend + renderer assets (no GUI/provider calls)")
