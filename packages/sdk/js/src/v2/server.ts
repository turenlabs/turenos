import launch from "cross-spawn"
import { type Config } from "./gen/types.gen.js"
import { stop, bindAbort } from "../process.js"

export type ServerOptions = {
  hostname?: string
  port?: number
  signal?: AbortSignal
  timeout?: number
  config?: Config
}

export async function createForgeServer(options?: ServerOptions) {
  options = Object.assign(
    {
      hostname: "127.0.0.1",
      port: 4096,
      timeout: 5000,
    },
    options ?? {},
  )

  const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`]
  if (options.config?.logLevel) args.push(`--log-level=${options.config.logLevel}`)

  const proc = launch(`forge`, args, {
    env: {
      ...process.env,
      FORGE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
    },
  })
  let clear = () => {}

  const url = await new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      clear()
      stop(proc)
      reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms`))
    }, options.timeout)
    let output = ""
    let resolved = false
    proc.stdout?.on("data", (chunk) => {
      if (resolved) return
      output += chunk.toString()
      const lines = output.split("\n")
      for (const line of lines) {
        // The server prints "forge server listening on <url>" (cli/cmd/serve.ts).
        // Matching the old upstream banner meant this never fired, so spawning a
        // server waited for a line that could not arrive and timed out instead.
        if (line.startsWith("forge server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
          if (!match) {
            clear()
            stop(proc)
            clearTimeout(id)
            reject(new Error(`Failed to parse server url from output: ${line}`))
            return
          }
          clearTimeout(id)
          resolved = true
          resolve(match[1]!)
          return
        }
      }
    })
    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
    })
    proc.on("exit", (code) => {
      clearTimeout(id)
      let msg = `Server exited with code ${code}`
      if (output.trim()) {
        msg += `\nServer output: ${output}`
      }
      reject(new Error(msg))
    })
    proc.on("error", (error) => {
      clearTimeout(id)
      reject(error)
    })
    clear = bindAbort(proc, options.signal, () => {
      clearTimeout(id)
      reject(options.signal?.reason)
    })
  })

  return {
    url,
    close() {
      clear()
      stop(proc)
    },
  }
}
