#!/usr/bin/env bun

// Refreshes provider logos from models.dev and regenerates the provider icon spritesheet.
// Logos for providers that models.dev no longer lists are kept.

import path from "node:path"
import { createServer } from "vite"

process.chdir(path.join(import.meta.dir, ".."))
const url = process.env.FORGE_MODELS_URL || "https://models.dev"
const api = await fetch(`${url}/api.json`, { signal: AbortSignal.timeout(10_000) })
if (!api.ok) throw new Error(`${url}/api.json returned HTTP ${api.status}`)

// Provider IDs come from the network and become file names, so accept only plain names: no path
// separators or control characters.
const queue = Object.keys(await api.json()).filter((provider) => /^[a-z0-9][a-z0-9._-]*$/i.test(provider))
const results = { written: 0, skipped: 0 }

// Eight downloads in flight; each worker takes the next provider when it finishes one.
const worker = async (): Promise<void> => {
  const provider = queue.shift()
  if (!provider) return
  results[(await download(provider)) ? "written" : "skipped"]++
  return worker()
}
await Promise.all(Array.from({ length: 8 }, worker))

// createServer runs the spritesheet plugin's buildStart, which regenerates the sprites and types.
await (
  await createServer({
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
    logLevel: "error",
  })
).close()
console.log(`provider logos: ${results.written} written, ${results.skipped} skipped`)

async function download(provider: string) {
  const response = await fetch(`${url}/logos/${provider}.svg`, { signal: AbortSignal.timeout(10_000) }).catch(
    () => undefined,
  )
  const svg = response?.ok && response.headers.get("content-type")?.includes("svg") ? await response.text() : ""
  // Logos end up in the shipped sprite and in docs HTML, so take only plain SVG markup.
  // An optional XML declaration, comments and a DOCTYPE without an internal subset may precede <svg>.
  // A comment body can't cross `-->`, so the match stays linear on hostile input; the size cap bounds it too.
  const prolog = /^\s*(<\?xml[^>]*>\s*)?(<!--(?:(?!-->)[\s\S])*-->\s*|<!DOCTYPE[^>[]*>\s*)*<svg[\s>]/i
  const unsafe = /<script|<foreignObject|\son\w+\s*=|javascript:/i
  if (svg.length > 512 * 1024 || !prolog.test(svg) || unsafe.test(svg)) {
    // batou:ignore log_output -- provider matched the plain-name pattern above, so it has no newlines
    console.warn(`skipped ${provider}: HTTP ${response?.status ?? "error"}, not a plain SVG`)
    return false
  }
  // batou:ignore file_write -- provider matched the plain-name pattern above, so the path stays in this folder
  await Bun.write(`src/assets/icons/provider/${provider}.svg`, svg)
  return true
}
