import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { alive, paths } from "../script/sandbox/run"
import { sandboxEnv, start } from "../script/sandbox/server"
import { keys, type } from "../script/sandbox/terminal"

const saved = { ...process.env }
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

/** A directory of fake executables first on PATH, with the sandbox root inside it. */
function shims(scripts: { [name: string]: string }) {
  const dir = mkdtempSync(join(tmpdir(), "turen-sandbox-test-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  process.env.PATH = `${dir}:${saved.PATH}`
  process.env.TUREN_SANDBOX_ROOT = join(dir, "root")
  return dir
}

test("keys and type pass text that starts with a dash to tmux after --", async () => {
  const dir = shims({ tmux: `printf '%s\\n' "$@" >> "$(dirname "$0")/calls"` })
  await type("probe", "-la")
  await keys("probe", "-", "S-Enter")
  const calls = readFileSync(join(dir, "calls"), "utf8").split("\n")
  expect(calls.join(" ")).toContain("-l -- -la")
  expect(calls.join(" ")).toContain("send-keys -t tui:0.0 -- -")
  expect(calls.join(" ")).toContain("-l -- \u001b[13;2u")
})

test("the sandbox environment passes TURENOS_REDUCED_MOTION through when set", () => {
  delete process.env.TURENOS_REDUCED_MOTION
  expect(sandboxEnv(paths("probe"))).not.toHaveProperty("TURENOS_REDUCED_MOTION")
  process.env.TURENOS_REDUCED_MOTION = "1"
  expect(sandboxEnv(paths("probe"))).toMatchObject({ TURENOS_REDUCED_MOTION: "1" })
})

test("a failed server start ends the model process it already started", async () => {
  const dir = shims({
    bun: `case "$*" in
  *model.ts*) echo $$ > "$(dirname "$0")/model.pid"; echo "MODEL_READY 4321"; exec sleep 600 ;;
  *) exit 1 ;;
esac`,
  })
  await expect(start("probe", { memoryMax: "0" })).rejects.toThrow("did not start")
  const pid = Number(readFileSync(join(dir, "model.pid"), "utf8"))
  cleanup.push(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  })
  await Bun.sleep(200)
  expect(alive(pid)).toBe(false)
})
