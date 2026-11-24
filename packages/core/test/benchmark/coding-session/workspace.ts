export * as CodingWorkspace from "./workspace"

import { lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

export const baseEnv = () =>
  Object.fromEntries(
    ["HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR"].flatMap((key) => {
      const value = process.env[key]
      return value === undefined ? [] : [[key, value]]
    }),
  )

const task =
  "Work only on cart.mjs in this scratch project. Use file tools only. Do not run shell commands, use the network, delegate, or access files outside the project. An independent grader will run after your turn."
export const prompts = [
  `Fix the shipping quote bug. The subtotal is the sum of each line's unitCents times quantity. Standard shipping is free at or above the configured threshold; express always charges its listed fee. Preserve the existing interface and unknown-method error. ${task}`,
  `Extend the shipping quote API you just fixed: add an optional third argument discountCents, defaulting to 0. Compare the standard free-shipping threshold against the subtotal minus the discount, floored at zero. Express still charges its listed fee. Preserve the first turn's behavior when no discount is passed. ${task}`,
] as const

const denied = [
  "bash",
  "external_directory",
  "webfetch",
  "websearch",
  "spawn_agent",
  "spawn_agents",
  "shell_job",
  "terminal",
]

export async function materialize(directory: string) {
  for (const file of ["cart.mjs", "rates.mjs"]) {
    await Bun.write(path.join(directory, file), Bun.file(path.join(import.meta.dir, "fixture", file)))
  }
  await Bun.write(
    path.join(directory, "forge.json"),
    JSON.stringify({
      agents: {
        build: {
          steps: 12,
          permissions: denied.map((action) => ({ action, resource: "*", effect: "deny" })),
        },
      },
    }),
  )
  git(directory, ["init", "-q", "--template="])
  git(directory, ["add", "--", "cart.mjs", "rates.mjs", "forge.json"])
  git(directory, [
    "-c",
    "user.name=Benchmark",
    "-c",
    "user.email=benchmark@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ])
}

function git(directory: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory,
    env: { ...baseEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stderr: "inherit",
    stdout: "ignore",
  })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in benchmark workspace`)
}

export function grade(directory: string, stage: 1 | 2) {
  const root = realpathSync(directory)
  const cart = path.join(root, "cart.mjs")
  const rates = path.join(root, "rates.mjs")
  if (![cart, rates].every((file) => lstatSync(file, { throwIfNoEntry: false })?.isFile())) return false
  if (!readFileSync(rates).equals(readFileSync(path.join(import.meta.dir, "fixture", "rates.mjs")))) return false
  const checker = path.join(import.meta.dir, "grade.mjs")
  const result = Bun.spawnSync(
    [
      "node",
      "--permission",
      "--no-addons",
      ...[checker, cart, rates].map((file) => `--allow-fs-read=${file}`),
      checker,
      root,
      `${stage}`,
    ],
    { cwd: root, env: { PATH: process.env.PATH }, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5_000 },
  )
  return result.exitCode === 0
}
