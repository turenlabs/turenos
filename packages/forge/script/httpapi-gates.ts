/**
 * Runs every HttpApi exerciser mode as an independent gate.
 *
 * `test:httpapi` used to chain the three modes with `&&`. Coverage exits non-zero on the
 * pre-existing uncovered routes, so auth and effect never ran in CI at all — which is how
 * effect mode was able to die on its first scenario, unnoticed, for as long as it did.
 * Each mode is its own signal, so a gap in one must not hide a regression in another.
 *
 * Known debt is recorded in checked-in ratchet files rather than by disabling a mode:
 *   - missing-routes.json  routes that have no scenario yet
 *   - known-failures.json  scenarios that already fail
 * Both gates block on anything *new*, so the debt can only shrink.
 */
import path from "path"
import { randomBytes, randomUUID } from "node:crypto"
import { parseArgs } from "node:util"
import { parseOptions } from "../test/server/httpapi-exercise/routing"

const packageRoot = path.dirname(import.meta.dir)
const exercise = path.join(packageRoot, "script", "httpapi-exercise.ts")
const missingBaseline = path.join(packageRoot, "test", "server", "httpapi-exercise", "missing-routes.json")
const knownFailures = path.join(packageRoot, "test", "server", "httpapi-exercise", "known-failures.json")
const secretVaultKeyID = `httpapi-${randomUUID()}`
const secretVaultKey = randomBytes(32).toString("base64")

const args = parseArgs({
  args: Bun.argv.slice(2),
  options: { mode: { type: "string" }, shard: { type: "string" } },
  strict: true,
  allowPositionals: false,
}).values
const options = parseOptions(Bun.argv.slice(2))
if (args.shard && !args.mode) throw new Error("--shard requires an explicit --mode")
const modes = args.mode ? [options.mode] : (["coverage", "auth", "effect"] as const)

const failed: string[] = []
for (const mode of modes) {
  console.log(`\n\x1b[36m=== httpapi exerciser: ${mode} ===\x1b[0m\n`)
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      exercise,
      "--mode",
      mode,
      "--progress",
      ...(args.shard ? ["--shard", args.shard] : []),
      "--fail-on-missing",
      "--fail-on-skip",
      "--missing-baseline",
      missingBaseline,
      "--known-failures",
      knownFailures,
    ],
    cwd: packageRoot,
    env: {
      ...process.env,
      FORGE_SECRET_VAULT_KEY_ID: secretVaultKeyID,
      FORGE_SECRET_VAULT_KEY: secretVaultKey,
    },
    stdio: ["inherit", "inherit", "inherit"],
  })
  if ((await proc.exited) !== 0) failed.push(mode)
}

console.log("")
for (const mode of modes) {
  const ok = !failed.includes(mode)
  console.log(`${ok ? "\x1b[32mPASS" : "\x1b[31mFAIL"}\x1b[0m ${mode}`)
}

if (failed.length > 0) {
  console.error(`\n\x1b[31mhttpapi exerciser gates failed: ${failed.join(", ")}\x1b[0m`)
  process.exit(1)
}
