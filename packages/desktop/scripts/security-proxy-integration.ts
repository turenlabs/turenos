import { join } from "node:path"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const output = await mkdtemp(join(tmpdir(), "security-proxy-build-"))
const build = await Bun.build({
  entrypoints: [join(root, "packages/desktop/scripts/security-proxy-fixture.ts")],
  outdir: output,
  target: "node",
  format: "esm",
  external: ["electron"],
  banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
})
if (!build.success) {
  console.error(build.logs)
  process.exit(1)
}
const entry = join(output, "security-proxy-fixture.js")
const require = createRequire(import.meta.url)
const electron = require("electron") as string
const userData = await mkdtemp(join(tmpdir(), "security-proxy-electron-"))
const child = spawn(electron, [`--user-data-dir=${userData}`, entry], {
  cwd: root,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
})
let stdout = ""
let stderr = ""
const maxOutput = 256 * 1024
const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(0, maxOutput)
child.stdout.on("data", (chunk) => {
  stdout = append(stdout, chunk)
})
child.stderr.on("data", (chunk) => {
  stderr = append(stderr, chunk)
})
const exit = await new Promise<number>((resolve) => {
  let settled = false
  const finish = (code: number) => {
    if (!settled) {
      settled = true
      clearTimeout(timeout)
      resolve(code)
    }
  }
  const timeout = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, 500)
    finish(124)
  }, 15000)
  child.once("error", (error) => {
    stderr = append(stderr, error.stack ?? error.message)
    finish(1)
  })
  child.once("exit", (code, signal) => {
    if (signal) stderr = append(stderr, `child terminated by ${signal}`)
    finish(code ?? 1)
  })
})
process.stdout.write(stdout)
if (stderr) process.stderr.write(stderr)
await rm(output, { recursive: true, force: true })
await rm(userData, { recursive: true, force: true })
process.exit(exit)
