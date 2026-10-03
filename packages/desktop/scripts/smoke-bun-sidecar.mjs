import assert from "node:assert/strict"
import { fork, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// Run with Node to exercise the same JSON IPC transport as Electron main.
const sourceResources = path.resolve(process.argv[2] ?? "resources")
const sourceServer = path.resolve(process.argv[3] ?? "out/main/server")
const targets = {
  "linux-x64": ["linux", "x64"],
  "linux-arm64": ["linux", "arm64"],
  "macos-x64": ["darwin", "x64"],
  "macos-arm64": ["darwin", "arm64"],
  "windows-x64": ["win32", "x64"],
  "windows-arm64": ["win32", "arm64"],
}
const directory = await mkdtemp(path.join(os.tmpdir(), "turen-bun-smoke-"))
const resources = path.join(directory, "resources")
const server = path.join(directory, "server")
const children = []
const password = randomBytes(24).toString("hex")
const credentialVault = { keyID: "smoke", key: randomBytes(32).toString("base64") }
const headers = { authorization: `Basic ${Buffer.from(`forge:${password}`).toString("base64")}` }
try {
  const target = process.env.TARGET ? targets[process.env.TARGET] : [process.platform, process.arch]
  assert.ok(target, `Unknown native runner target: ${process.env.TARGET}`)
  assert.deepEqual(
    [process.platform, process.arch],
    target,
    `Expected ${target}, got ${process.platform}/${process.arch}`,
  )
  console.log(`Native runner verified: ${process.env.TARGET ?? "local"} = ${process.platform}/${process.arch}`)
  await cp(sourceServer, server, { recursive: true, dereference: true })
  await mkdir(resources)
  await cp(
    path.join(sourceResources, process.platform === "win32" ? "bun.exe" : "bun"),
    path.join(resources, process.platform === "win32" ? "bun.exe" : "bun"),
  )
  const bun = path.join(resources, process.platform === "win32" ? "bun.exe" : "bun")
  const nativeCheck = spawnSync(bun, [path.join(server, "native-check.js")], {
    cwd: server,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      XDG_DATA_HOME: directory,
      XDG_CONFIG_HOME: directory,
      XDG_STATE_HOME: directory,
      XDG_CACHE_HOME: directory,
      FORGE_DB: path.join(directory, "forge.db"),
      FORGE_RESOURCES_PATH: resources,
      FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      ELECTRON_RUN_AS_NODE: undefined,
    },
  })
  assert.equal(nativeCheck.status, 0, `Native module probe failed:\n${nativeCheck.stdout}\n${nativeCheck.stderr}`)
  console.log(nativeCheck.stdout.trim())
  const start = async () => {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        probe.close(() => resolve(address.port))
      })
    })
    const child = fork(path.join(server, "sidecar.js"), [], {
      execPath: bun,
      execArgv: ["--no-env-file", "--no-install", "--use-system-ca"],
      cwd: server,
      env: {
        ...process.env,
        XDG_DATA_HOME: directory,
        XDG_CONFIG_HOME: directory,
        XDG_STATE_HOME: directory,
        XDG_CACHE_HOME: directory,
        FORGE_DB: path.join(directory, "forge.db"),
        FORGE_RESOURCES_PATH: resources,
        FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        FORGE_SERVER_PASSWORD: undefined,
        FORGE_SECRET_VAULT_KEY: undefined,
        FORGE_SECRET_VAULT_KEY_ID: undefined,
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    children.push(child)
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.stdout.resume()
    const exited = new Promise((resolve) => child.once("exit", resolve))
    const next = (type) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          child.off("message", onMessage)
          child.off("exit", onExit)
          child.off("error", onError)
        }
        const onError = (error) => {
          cleanup()
          reject(error)
        }
        const onExit = () => onError(new Error(`Exited before ${type}: ${stderr}`))
        const onMessage = (message) => {
          if (message.type === "error") return onError(new Error(JSON.stringify(message.error)))
          if (message.type !== type) return
          cleanup()
          resolve(message)
        }
        const timer = setTimeout(() => onError(new Error(`Timed out waiting for ${type}: ${stderr}`)), 30_000)
        child.on("message", onMessage)
        child.on("exit", onExit)
        child.on("error", onError)
      })
    const ready = next("ready")
    child.send({ type: "start", hostname: "127.0.0.1", port, password, userDataPath: directory, credentialVault })
    await ready
    return { child, next, exited, url: `http://127.0.0.1:${port}` }
  }
  const first = await start()
  assert.equal((await fetch(`${first.url}/global/health`)).status, 401)
  assert.equal((await fetch(`${first.url}/global/health`, { headers })).status, 200)
  const events = await fetch(`${first.url}/global/event`, { headers })
  assert.match(events.headers.get("content-type"), /text\/event-stream/)
  await events.body.cancel()
  const reply = first.next("security-proxy-result")
  first.child.send({
    type: "security-proxy",
    id: "smoke",
    command: {
      type: "create",
      owner: { directory },
      input: { id: "smoke_case", name: "Smoke" },
    },
  })
  assert.equal((await reply).result.case.id, "smoke_case")
  const ptyResponse = await fetch(`${first.url}/pty`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "x-forge-directory": directory },
    body: JSON.stringify({
      command: path.join(resources, process.platform === "win32" ? "bun.exe" : "bun"),
      args: [
        "-e",
        'process.stdin.setEncoding("utf8"); process.stdin.on("data", (data) => process.stdout.write("pty-response:" + data))',
      ],
      title: "Bun native PTY smoke",
    }),
  })
  assert.equal(ptyResponse.status, 200, await ptyResponse.clone().text())
  const pty = await ptyResponse.json()
  const ticketResponse = await fetch(
    `${first.url}/pty/${pty.id}/connect-token?directory=${encodeURIComponent(directory)}`,
    {
      method: "POST",
      headers: { ...headers, "x-forge-directory": directory, "x-forge-ticket": "1" },
    },
  )
  assert.equal(ticketResponse.status, 200, await ticketResponse.clone().text())
  const ticket = await ticketResponse.json()
  const socket = new WebSocket(
    `ws://127.0.0.1:${new URL(first.url).port}/pty/${pty.id}/connect?directory=${encodeURIComponent(directory)}&ticket=${encodeURIComponent(ticket.ticket)}`,
  )
  let terminalOutput = ""
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for PTY websocket data")), 10_000)
    socket.addEventListener("open", () => socket.send("bun-smoke-pty\r\n"), { once: true })
    socket.addEventListener(
      "message",
      async (event) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : typeof event.data?.text === "function"
              ? await event.data.text()
              : Buffer.from(event.data).toString("utf8")
        terminalOutput += data
        if (!terminalOutput.includes("pty-response:bun-smoke-pty")) return
        clearTimeout(timer)
        resolve()
      },
      { once: false },
    )
    socket.addEventListener("error", () => reject(new Error("PTY websocket failed")), { once: true })
  })
  socket.close()
  assert.equal(
    (
      await fetch(`${first.url}/pty/${pty.id}`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json", "x-forge-directory": directory },
        body: JSON.stringify({ size: { rows: 30, cols: 100 } }),
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await fetch(`${first.url}/pty/${pty.id}`, {
        method: "DELETE",
        headers: { ...headers, "x-forge-directory": directory },
      })
    ).status,
    200,
  )
  const stopped = first.next("stopped")
  first.child.send({ type: "stop" })
  await stopped
  assert.equal(await first.exited, 0)
  const second = await start()
  const persisted = second.next("security-proxy-result")
  second.child.send({
    type: "security-proxy",
    id: "persistence",
    command: { type: "list", owner: { directory } },
  })
  assert.ok((await persisted).result.cases.some((item) => item.id === "smoke_case"))
  second.child.disconnect()
  assert.equal(await second.exited, 0)
  console.log(
    "PASS: isolated staged Bun, Node IPC, authenticated HTTP, SSE abort, proxy, native PTY create/resize/delete, stop, parent disconnect",
  )
} finally {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGKILL")
      await exited
    }),
  )
  await rm(directory, { recursive: true, force: true })
}
