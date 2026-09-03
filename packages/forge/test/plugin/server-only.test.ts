import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Filesystem } from "@/util/filesystem"
import { createPlugTask, type PlugDeps } from "@/cli/cmd/plug"
import { PluginLoader } from "@/plugin/loader"
import { readPluginManifest } from "@/plugin/install"
import { readV1Plugin } from "@/plugin/shared"
import { tmpdir } from "../fixture/fixture"

function deps(global: string, target: string): PlugDeps {
  return {
    spinner: () => ({
      start() {},
      stop() {},
    }),
    log: {
      error() {},
      info() {},
      success() {},
    },
    resolve: async () => target,
    readText: (file) => Filesystem.readText(file),
    write: (file, text) => Filesystem.write(file, text),
    exists: (file) => Filesystem.exists(file),
    files: (dir, name) => [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    global,
  }
}

async function packageDirectory(dir: string) {
  const target = path.join(dir, "plugin")
  await Filesystem.write(
    path.join(target, "package.json"),
    JSON.stringify(
      {
        name: "acme",
        version: "1.0.0",
        exports: { "./server": "./server.js" },
      },
      null,
      2,
    ),
  )
  await Filesystem.write(path.join(target, "server.js"), 'export default { id: "acme", server: async () => ({}) }\n')
  return target
}

describe("server plugin surface", () => {
  test("detects one server target and writes only forge config", async () => {
    await using tmp = await tmpdir()
    const target = await packageDirectory(tmp.path)
    expect(await readPluginManifest(target)).toMatchObject({
      ok: true,
      targets: [{ kind: "server" }],
    })

    const run = createPlugTask({ mod: "acme@1.0.0" }, deps(path.join(tmp.path, "global"), target))
    expect(
      await run({
        vcs: "git",
        worktree: tmp.path,
        directory: tmp.path,
      }),
    ).toBe(true)
    expect(await Filesystem.readJson<{ plugin: string[] }>(path.join(tmp.path, ".forge", "forge.jsonc"))).toEqual({
      plugin: ["acme@1.0.0"],
    })
  })

  test("loads a server entrypoint and validates the v1 module shape", async () => {
    await using tmp = await tmpdir()
    const target = await packageDirectory(tmp.path)
    const plan = {
      spec: pathToFileURL(target).href,
      options: undefined,
      deprecated: false,
    }
    const resolved = await PluginLoader.resolve(plan, "server")
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const loaded = await PluginLoader.load(resolved.value)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(readV1Plugin(loaded.value.mod, plan.spec, "server")).toMatchObject({
      id: "acme",
      server: expect.any(Function),
    })
  })
})
