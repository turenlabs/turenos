import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app } from "electron"
import { checkHealth } from "../server"
import { type WslCommandLine, resolveWslForge, shellEscape, wslArgs } from "./runtime"
import { pollWslHealth } from "./startup"
import type { CredentialVault } from "../secret-key"
import { rendererCorsOrigins } from "../window-security"

export type WslSidecar = {
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
}

export async function spawnWslSidecar(
  distro: string,
  opts: { credentialVault: CredentialVault; onLine?: (line: WslCommandLine) => void; healthTimeoutMs?: number },
): Promise<WslSidecar> {
  const forge = await resolveWslForge(distro)
  if (!forge) throw new Error(`TurenOS is not installed in ${distro}`)

  const port = await allocatePort()
  const password = randomUUID()
  const username = "forge"
  const script = [
    "set -euo pipefail",
    'cd "$HOME" || cd /',
    'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
    "export PATH",
    "export WSLENV=",
    "export FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
    "export FORGE_CLIENT=desktop",
    `export FORGE_SERVER_USERNAME=${shellEscape(username)}`,
    `export FORGE_SERVER_PASSWORD=${shellEscape(password)}`,
    `export FORGE_SECRET_VAULT_KEY_ID=${shellEscape(opts.credentialVault.keyID)}`,
    `export FORGE_SECRET_VAULT_KEY=${shellEscape(Buffer.from(opts.credentialVault.key).toString("base64"))}`,
    'export XDG_STATE_HOME="$HOME/.local/state"',
    `exec ${shellEscape(forge)} --print-logs --log-level ${app.isPackaged ? "WARN" : "INFO"} serve --hostname 0.0.0.0 --port ${port} ${rendererCorsOrigins()
      .map((origin) => `--cors ${shellEscape(origin)}`)
      .join(" ")}`,
  ].join("\n")
  const child = spawn("wsl", wslArgs(["bash", "-se"], distro), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stdin.end(script)

  const recentOutput: string[] = []
  const emit = (line: WslCommandLine) => {
    if (!line.text.trim()) return
    recentOutput.push(`[${line.stream}] ${line.text}`)
    if (recentOutput.length > 12) recentOutput.shift()
    opts.onLine?.(line)
  }
  forwardLines(child.stdout, "stdout", emit)
  forwardLines(child.stderr, "stderr", emit)

  const exit = new Promise<never>((_, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(startupFailure(code, signal, recentOutput))))
  })
  const url = `http://127.0.0.1:${port}`
  const startup = new AbortController()
  const health = pollWslHealth(() => checkHealth(url, password), startup.signal)
  const timeoutMs = opts.healthTimeoutMs ?? 30_000
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>(
    (_, reject) =>
      (timeout = setTimeout(
        () => reject(new Error(`Sidecar for ${distro} health check timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )),
  )

  await Promise.race([health, exit, timedOut])
    .catch((error) => {
      child.kill()
      throw error
    })
    .finally(() => {
      clearTimeout(timeout)
      startup.abort()
    })
  return {
    listener: {
      stop: () => child.kill(),
      onExit: (cb) => child.once("exit", cb),
    },
    url,
    username,
    password,
  }
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  source: WslCommandLine["stream"],
  onLine: (line: WslCommandLine) => void,
) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/g)
    pending = lines.pop() ?? ""
    lines.forEach((text) => onLine({ stream: source, text }))
  })
  stream.on("end", () => {
    if (pending) onLine({ stream: source, text: pending })
  })
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null, recentOutput: string[]) {
  const suffix = recentOutput.length ? `\n${recentOutput.join("\n")}` : ""
  return `WSL server exited before becoming healthy (code=${code ?? "null"} signal=${signal ?? "null"})${suffix}`
}
