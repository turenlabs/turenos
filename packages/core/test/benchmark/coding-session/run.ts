import { mkdtempSync, mkdirSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { CodingHarness } from "./harness"
import { CodingWorkspace } from "./workspace"

const { values } = parseArgs({
  options: {
    yes: { type: "boolean" },
    model: { type: "string", default: "gpt-6.2-sol" },
    effort: { type: "string", default: "medium" },
    repetitions: { type: "string", default: "1" },
    timeout: { type: "string", default: "120" },
  },
})
const repetitions = Number(values.repetitions)
const timeout = Number(values.timeout)
if (!/^gpt-[a-z0-9.-]+$/.test(values.model)) throw new Error("--model must be a bare OpenAI GPT model ID")
if (!["low", "medium", "high"].includes(values.effort)) throw new Error("--effort must be low, medium or high")
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("--repetitions must be 1–10")
if (!Number.isInteger(timeout) || timeout < 10 || timeout > 300) throw new Error("--timeout must be 10–300 seconds")

if (!values.yes) {
  console.log(
    `Plan: ${repetitions} run(s) per client, two turns per run, ${values.model} at ${values.effort}. No requests sent. Pass --yes to use configured accounts.`,
  )
  process.exit(0)
}
for (const command of ["node", "git", "turen-tui", "distance-cli"]) {
  if (!Bun.which(command)) throw new Error(`${command} must be on PATH`)
}
const nodePermission = Bun.spawnSync(
  [
    "node",
    "--permission",
    "--no-addons",
    "-e",
    "if (!process.permission || process.permission.has('net')) process.exit(1)",
  ],
  {
    env: { PATH: process.env.PATH },
  },
)
if (nodePermission.exitCode !== 0)
  throw new Error("Node.js with filesystem and network permission restrictions is required (verified with Node.js 26)")

const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "turen-coding-bench-")))
const clients = { turen: CodingHarness.turen, distance: CodingHarness.distance }
const versions = Object.fromEntries(
  ["turen-tui", "distance-cli", "node"].map((command) => [
    command,
    Bun.spawnSync([command, "--version"], { env: CodingWorkspace.baseEnv() }).stdout.toString().trim(),
  ]),
)
console.log(
  JSON.stringify({ type: "setup", scratch, versions, model: values.model, effort: values.effort, repetitions }),
)
let failed = false
for (let run = 1; run <= repetitions; run++) {
  const order = run % 2 === 1 ? (["turen", "distance"] as const) : (["distance", "turen"] as const)
  for (const client of order) {
    const root = path.join(scratch, `${run}-${client}`)
    const directory = path.join(root, "project")
    mkdirSync(directory, { recursive: true })
    await CodingWorkspace.materialize(directory)
    if (CodingWorkspace.grade(directory, 1)) throw new Error("Unmodified fixture unexpectedly passed the grader")
    let session: string | undefined
    for (const stage of [1, 2] as const) {
      try {
        const result = await clients[client]({
          directory,
          scratch: root,
          model: values.model,
          effort: values.effort,
          prompt: CodingWorkspace.prompts[stage - 1],
          timeout,
          session,
        })
        const completed = result.status === "ok" || result.status === "incomplete-stream"
        const passed = completed && CodingWorkspace.grade(directory, stage)
        console.log(JSON.stringify({ type: "turn", client, run, stage, ...result, passed }))
        session = result.session
        failed ||= !passed || result.status !== "ok"
        if (!session || !completed) break
      } catch (error) {
        console.log(
          JSON.stringify({
            type: "turn",
            client,
            run,
            stage,
            status: "error",
            error: error instanceof Error ? error.message : "benchmark error",
            passed: false,
          }),
        )
        failed = true
        break
      }
    }
  }
}
process.exitCode = failed ? 1 : 0
