import path from "node:path"
import { parseArgs } from "node:util"

const options = parseArgs({
  args: Bun.argv.slice(2),
  options: { verify: { type: "boolean" }, shard: { type: "string" } },
  strict: true,
  allowPositionals: false,
}).values

const root = path.resolve(import.meta.dir, "../..")
// These are the portable suites also run on Windows.
// Core, Forge, and Desktop retain their POSIX coverage in the native Bun shard jobs.
const portable = [
  "packages/app",
  "packages/client",
  "packages/codemode",
  "packages/effect-drizzle-sqlite",
  "packages/extensions",
  "packages/http-recorder",
  "packages/httpapi-codegen",
  "packages/llm",
  "packages/plugin",
  "packages/protocol",
  "packages/schema",
  "packages/script",
  "packages/sdk/js",
  "packages/sdk-next",
  "packages/server",
  "packages/session-ui",
  "packages/ui",
]
const repository = await Bun.file(path.join(root, "package.json")).json()
const actual: string[] = []
for (const pattern of repository.workspaces.packages) {
  for await (const file of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root })) {
    const manifest = await Bun.file(path.join(root, file)).json()
    if (manifest.scripts?.test) actual.push(path.dirname(file).replaceAll("\\", "/"))
  }
}
const expected = [...portable, "packages/core", "packages/desktop", "packages/forge"].sort()
if (JSON.stringify(actual.sort()) !== JSON.stringify(expected))
  throw new Error(
    `CI suite inventory changed. Classify every test package before proceeding: ${JSON.stringify(actual)}`,
  )
console.log(
  `Verified all ${actual.length} test packages: Core shards, Forge shards, ${portable.length} portable suites.`,
)

const shard = options.shard?.match(/^([1-9]\d*)\/([1-9]\d*)$/)
if (options.shard !== undefined && (!shard || Number(shard[1]) > Number(shard[2]) || Number(shard[2]) > portable.length))
  throw new Error(`Invalid portable suite shard: ${options.shard}`)
const selected = portable.filter((_, index) => !shard || index % Number(shard[2]) === Number(shard[1]) - 1)
console.log(
  `Selected ${selected.length} portable suites${options.shard ? ` (shard ${options.shard})` : ""}: ${selected.join(", ")}`,
)
if (options.verify) process.exit(0)
const failures: string[] = []
for (const directory of selected) {
  const started = performance.now()
  const child = Bun.spawn([process.execPath, "run", "test"], {
    cwd: path.join(root, directory),
    stdio: ["inherit", "inherit", "inherit"],
  })
  if ((await child.exited) !== 0) failures.push(directory)
  console.log(`${directory}: ${((performance.now() - started) / 1000).toFixed(1)}s`)
}
if (failures.length) throw new Error(`Failed suites: ${failures.join(", ")}`)
