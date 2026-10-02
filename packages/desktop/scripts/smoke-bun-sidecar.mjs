import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// Run with Node to exercise the same JSON IPC transport as Electron main.
const resources = path.resolve(process.argv[2] ?? "resources")
const server = path.resolve(process.argv[3] ?? "out/main/server")
const directory = await mkdtemp(path.join(os.tmpdir(), "turen-bun-smoke-"))
const children = []
const password = randomBytes(24).toString("hex")
const credentialVault = { keyID: "smoke", key: randomBytes(32).toString("base64") }
const headers = { authorization: `Basic ${Buffer.from(`forge:${password}`).toString("base64")}` }
try {
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
      execPath: path.join(resources, process.platform === "win32" ? "bun.exe" : "bun"),
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
  if (process.platform !== "win32") {
    const response = await fetch(`${first.url}/pty`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-forge-directory": directory },
      body: JSON.stringify({ command: "/bin/cat", title: "Bun native PTY smoke" }),
    })
    assert.equal(response.status, 200, await response.clone().text())
    const pty = await response.json()
    assert.equal(
      (
        await fetch(`${first.url}/pty/${pty.id}`, {
          method: "DELETE",
          headers: { ...headers, "x-forge-directory": directory },
        })
      ).status,
      200,
    )
  }
  const stopped = first.next("stopped")
  first.child.send({ type: "stop" })
  await stopped
  assert.equal(await first.exited, 0)
  const second = await start()
  second.child.disconnect()
  assert.equal(await second.exited, 0)
  console.log("PASS: staged Bun, Node IPC, authenticated HTTP, private proxy, native PTY, stop, parent disconnect")
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
