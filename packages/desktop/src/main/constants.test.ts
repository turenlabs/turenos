import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test.each(["dev", "beta", "prod"])("updater enablement for %s builds", async (channel) => {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./constants.ts", import.meta.url))],
    target: "bun",
    define: { "import.meta.env.FORGE_CHANNEL": JSON.stringify(channel) },
  })
  expect(result.success).toBe(true)
  const directory = await mkdtemp(path.join(os.tmpdir(), "turen-update-channel-"))
  try {
    const file = path.join(directory, "constants.mjs")
    await Bun.write(file, await result.outputs[0]!.text())
    const constants = await import(pathToFileURL(file).href)
    expect(constants.CHANNEL).toBe(channel)
    expect(constants.UPDATER_ENABLED).toBe(channel === "prod")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
