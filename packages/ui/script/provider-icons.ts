#!/usr/bin/env bun

// Refreshes provider logos from models.dev and regenerates the provider icon spritesheet.
// Logos for providers that models.dev no longer lists are kept.

import path from "node:path"

process.chdir(path.join(import.meta.dir, ".."))
const url = process.env.FORGE_MODELS_URL || "https://models.dev"

// Provider IDs come from the network and become file names, so accept only plain names: no path
// separators or control characters.
const providers = Object.keys(await (await fetch(`${url}/api.json`)).json()).filter((provider) =>
  /^[a-z0-9][a-z0-9._-]*$/i.test(provider),
)

// A few downloads at a time, so a refresh doesn't open hundreds of connections at once.
const batches = Array.from({ length: Math.ceil(providers.length / 8) }, (_, i) => providers.slice(i * 8, i * 8 + 8))
for (const batch of batches) {
  await Promise.all(
    batch.map(async (provider) => {
      const response = await fetch(`${url}/logos/${provider}.svg`)
      const svg = response.ok ? await response.text() : ""
      if (!svg.includes("<svg")) {
        // batou:ignore log_output -- provider matched the plain-name pattern above, so it has no newlines
        console.warn(`skipped ${provider}: HTTP ${response.status}, not an SVG`)
        return
      }
      // batou:ignore file_write -- provider matched the plain-name pattern above, so the path stays in this folder
      await Bun.write(`src/assets/icons/provider/${provider}.svg`, svg)
    }),
  )
}

// Regenerate through Vite under Node, the way `bun dev` does. The spritesheet plugin lists icons in
// glob order, and glob orders files differently under Bun, which would reorder the committed files.
const regenerate = `import { createServer } from "vite"
const server = await createServer({ server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, logLevel: "error" })
await server.pluginContainer.buildStart({})
await server.close()`
const code = await Bun.spawn(["node", "--input-type=module", "-e", regenerate], {
  stdio: ["inherit", "inherit", "inherit"],
}).exited
if (code !== 0) process.exit(code)
console.log(`refreshed ${providers.length} provider logos`)
