import { expect, test } from "bun:test"
import { fork } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import net from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"

test("real Bun sidecar authenticates, serves private proxy IPC, and stops on disconnect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "turen-bun-ipc-"))
  const children: ReturnType<typeof fork>[] = []
  try {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "sidecar.ts")],
      outdir: directory,
      target: "bun",
      define: { "import.meta.env.FORGE_CHANNEL": JSON.stringify("dev") },
      plugins: [
        {
          name: "source-backend",
          setup(builder) {
            builder.onResolve({ filter: /^virtual:forge-server$/ }, () => ({
              path: pathToFileURL(path.resolve(import.meta.dir, "../../../forge/src/node.ts")).href,
              external: true,
            }))
          },
        },
      ],
    })
    expect(build.success).toBe(true)
    const password = randomBytes(24).toString("hex")
    const credentialVault = { keyID: "ipc-test", key: randomBytes(32).toString("base64") }
    const start = async () => {
      const port = await new Promise<number>((resolve, reject) => {
        const probe = net.createServer()
        probe.once("error", reject)
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address()
          if (!address || typeof address === "string") return probe.close(() => reject(new Error("Missing port")))
          probe.close(() => resolve(address.port))
        })
      })
      const child = fork(path.join(directory, "sidecar.js"), [], {
        execPath: process.execPath,
        execArgv: ["--no-env-file", "--no-install"],
        cwd: directory,
        env: {
          ...process.env,
          XDG_DATA_HOME: directory,
          XDG_CONFIG_HOME: directory,
          XDG_STATE_HOME: directory,
          XDG_CACHE_HOME: directory,
          FORGE_DB: path.join(directory, `test-${children.length}.db`),
          FORGE_DISABLE_CHANNEL_DB: "1",
          FORGE_TEST_HOME: directory,
          FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
          ELECTRON_RUN_AS_NODE: undefined,
          FORGE_SECRET_VAULT_KEY_ID: undefined,
          FORGE_SECRET_VAULT_KEY: undefined,
          FORGE_SERVER_PASSWORD: undefined,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
      children.push(child)
      let stderr = ""
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
      const next = (type: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer)
            child.off("message", onMessage)
            child.off("exit", onExit)
            child.off("error", onError)
          }
          const onError = (error: Error) => {
            cleanup()
            reject(error)
          }
          const onExit = () => onError(new Error(`Sidecar exited before ${type}: ${stderr}`))
          const onMessage = (message: unknown) => {
            if (!message || typeof message !== "object") return
            const reply = message as Record<string, unknown>
            if (reply.type === "error") return onError(new Error(JSON.stringify(reply.error)))
            if (reply.type !== type) return
            cleanup()
            resolve(reply)
          }
          const timer = setTimeout(() => onError(new Error(`Sidecar did not send ${type}: ${stderr}`)), 30_000)
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
    expect((await fetch(`${first.url}/global/health`)).status).toBe(401)
    expect(
      (
        await fetch(`${first.url}/global/health`, {
          headers: { authorization: `Basic ${Buffer.from(`forge:${password}`).toString("base64")}` },
        })
      ).status,
    ).toBe(200)
    const reply = first.next("security-proxy-result")
    first.child.send({
      type: "security-proxy",
      id: "probe",
      command: {
        type: "create",
        owner: { directory },
        input: { id: "ipc_case", name: "IPC fixture" },
      },
    })
    expect(await reply).toMatchObject({ id: "probe", result: { case: { id: "ipc_case" } } })
    const stopped = first.next("stopped")
    first.child.send({ type: "stop" })
    await stopped
    expect(await first.exited).toBe(0)

    const second = await start()
    second.child.disconnect()
    expect(await second.exited).toBe(0)
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
        child.kill("SIGKILL")
        await exited
      }),
    )
    await rm(directory, { recursive: true, force: true })
  }
}, 90_000)
