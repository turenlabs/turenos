import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

assert.ok(process.argv[2], "usage: node test/cli.mjs <packaged-module-directory>")
const packageRoot = path.resolve(process.argv[2])
const cli = path.join(packageRoot, "cli.mjs")
for (const name of ["cli.mjs", "cli-worker.mjs"]) {
  const copy = await readFile(path.join(packageRoot, name), "utf8")
  assert.ok(
    copy
      .split("\n")
      .slice(0, 5)
      .some((line) => line.includes("@generated")),
    "packaged CLI must identify its generated source",
  )
  assert.equal(
    copy.replace(/^\/\/ @generated.*\n/m, ""),
    await readFile(new URL(`../script/${name}`, import.meta.url), "utf8"),
  )
}
for (const name of ["NOTICE", "LICENSE-OXC"]) {
  assert.deepEqual(
    await readFile(path.join(packageRoot, `${name}.txt`)),
    await readFile(new URL(`../${name}`, import.meta.url)),
  )
}
const inventory = JSON.parse(await readFile(path.join(packageRoot, "THIRD_PARTY_LICENSES.json"), "utf8"))
assert.ok(
  inventory.every((item) => item.files.every((file) => file.endsWith(".txt"))),
  "packaged legal texts must use prose filenames",
)
const temporary = await mkdtemp(path.join(os.tmpdir(), "script-deobfuscate-cli-"))
const call = (args, input) =>
  spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  })
try {
  const source = 'result = "a" + "b";'
  const filename = path.join(temporary, "input.js")
  await writeFile(filename, source)
  const analyzed = call(["js", filename, "--format", "json"])
  assert.equal(analyzed.status, 0, analyzed.stderr)
  const report = JSON.parse(analyzed.stdout)
  assert.equal(report.input.sha256, createHash("sha256").update(source).digest("hex"))
  assert.ok(report.transformations.length > 0)
  assert.match(report.code, /["']ab["']/)

  const stdin = call(["js", "-", "--format=json"], '"he" + "llo";')
  assert.equal(stdin.status, 0, stdin.stderr)
  assert.match(JSON.parse(stdin.stdout).code, /hello/)
  const readable = call(["js", filename])
  assert.equal(readable.status, 0, readable.stderr)
  assert.match(readable.stdout, /result = ["']ab["']/)

  const encoded = call(
    ["js", "-", "--format", "json", "--extract-payloads", "--assume-standard-builtins"],
    'eval(atob("d2hpbGUodHJ1ZSl7fQ=="));',
  )
  assert.equal(encoded.status, 0, encoded.stderr)
  assert.equal(JSON.parse(encoded.stdout).payloads[0].code, "while(true){}")
  const poison = call(["js", "-", "--format", "json"], "while(true){}; throw new Error('never execute');")
  assert.equal(poison.status, 0, poison.stderr)
  assert.match(JSON.parse(poison.stdout).code, /while/)

  const help = call(["--help"])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /script-deobfuscate js/)
  for (const args of [
    ["ps", filename],
    ["js", filename, "--execute"],
    ["js", filename, "--format", "yaml"],
    ["js", filename, "extra.js"],
  ]) {
    assert.equal(call(args).status, 1, `must reject ${args.join(" ")}`)
  }
  await writeFile(filename, " ".repeat(1024 * 1024 + 1))
  const huge = call(["js", filename])
  assert.equal(huge.status, 1)
  assert.match(huge.stderr, /1 MiB/)
  console.log("Packaged positional CLI, stdin, formats, payloads, non-execution, and argument/size bounds verified.")
} finally {
  await rm(path.join(temporary, "input.js"), { force: true })
  await rmdir(temporary)
}
