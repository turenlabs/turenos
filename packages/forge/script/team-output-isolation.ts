import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function isolateWorkload(prefix: string) {
  assert.equal(process.env.FORGE_WORKLOAD_LAUNCHED, "1", "Use the clean team-output-launch.sh launcher")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  await fs.chmod(root, 0o700)
  for (const key of Object.keys(process.env))
    if (key !== "NODE_ENV" && key !== "PATH") delete process.env[key]
  process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`
  for (const kind of ["DATA", "CONFIG", "STATE", "CACHE"])
    process.env[`XDG_${kind}_HOME`] = path.join(root, kind.toLowerCase())
  process.env.HOME = path.join(root, "home")
  process.env.USERPROFILE = process.env.HOME
  process.env.FORGE_TEST_HOME = process.env.HOME
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = path.join(root, "tmp")
  process.env.FORGE_TEST_MANAGED_CONFIG_DIR = path.join(root, "managed")
  process.env.FORGE_DB = path.join(root, "runtime.sqlite")
  process.env.FORGE_DISABLE_MODELS_FETCH = "true"
  process.env.FORGE_MODELS_PATH = path.resolve("test/tool/fixtures/models-api.json")
  process.env.FORGE_TEST_KIMI = "0"
  await Promise.all(["home", "tmp", "managed"].map((name) => fs.mkdir(path.join(root, name))))
  assert.equal(os.tmpdir(), path.join(root, "tmp"))
  assert.equal(process.env.HOME, path.join(root, "home"))
  assert.equal(process.env.FORGE_TEST_HOME, process.env.HOME)
  const { Global } = await import("@turenlabs/core/global")
  assert.equal(Global.Path.home, path.join(root, "home"))
  assert.equal(Global.Path.config, path.join(root, "config", "forge"))
  assert.equal(Global.Path.tmp, path.join(root, "tmp", "forge"))
  return root
}
