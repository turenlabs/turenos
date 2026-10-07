#!/usr/bin/env bun

// Refreshes provider logos from models.dev, regenerates the provider icon spritesheet and checks it.
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
await checkSprite()
console.log(`provider logos: ${results.written} written, ${results.skipped} skipped`)

// The sprite plugin re-serializes every logo with a different HTML parser than the one that checked it in
// download(), so check the sprite that ships as well. Nothing is repaired: the logos are still on disk.
async function checkSprite() {
  const sprite = await Bun.file("src/components/provider-icons/sprite.svg").text()
  if (await isInertSvg(sprite, { bytes: 8 * 1024 * 1024, elements: 100_000 })) return
  throw new Error(
    "The regenerated provider sprite contains markup the logo validator rejects. Do not commit the logo changes; " +
      "revert them from packages/ui with `git checkout -- src && git clean -f src/assets/icons/provider`.",
  )
}

async function download(provider: string) {
  const response = await fetch(`${url}/logos/${provider}.svg`, { signal: AbortSignal.timeout(10_000) }).catch(
    () => undefined,
  )
  // The timeout and connection resets also hit while the body streams, so a failed read skips the logo too.
  const svg =
    response?.ok && response.headers.get("content-type")?.includes("svg") ? await response.text().catch(() => "") : ""
  if (!(await isInertSvg(svg))) {
    // batou:ignore log_output -- provider matched the plain-name pattern above, so it has no newlines
    console.warn(`skipped ${provider}: HTTP ${response?.status ?? "error"}, not a plain SVG`)
    return false
  }
  // batou:ignore file_write -- provider matched the plain-name pattern above, so the path stays in this folder
  await Bun.write(`src/assets/icons/provider/${provider}.svg`, svg)
  return true
}

// Logos end up in the shipped sprite and in docs HTML, so take only plain, inert SVG markup. The default
// limits are for one logo; the sprite holds them all.
async function isInertSvg(svg: string, limit = { bytes: 512 * 1024, elements: 10_000 }) {
  // An optional XML declaration, comments and a DOCTYPE without an internal subset may precede <svg>.
  // A comment body can't cross `-->`, so the match stays linear on hostile input; testing only the first
  // 4 KB keeps its constant factor small, and real prologs are under 200 bytes.
  const prolog = /^\s*(<\?xml[^>]*>\s*)?(<!--(?:(?!-->)[\s\S])*-->\s*|<!DOCTYPE[^>[]*>\s*)*<svg[\s>]/i
  if (svg.length > limit.bytes || !prolog.test(svg.slice(0, 4096))) return false
  // The sprite plugin copies each logo mostly as text, so a comment, CDATA section or quote left open at the
  // end would swallow the next logo's markup and change how it parses. An unguessable element that the
  // tokenizer still finds after the logo proves nothing was left open.
  const end = `x-${crypto.randomUUID()}`
  // Every element the current logos use, plus the sprite's own symbol, lowercase because HTMLRewriter
  // lowercases names. <style> stays out: in the inline sprite its rules apply page-wide, so one logo's `.st0`
  // would recolor every other logo.
  const inert = new Set([
    end,
    "svg",
    "g",
    "defs",
    "symbol",
    "path",
    "rect",
    "circle",
    "polygon",
    "polyline",
    "clippath",
    "pattern",
    "text",
    "tspan",
    "title",
    "image",
    "sodipodi:namedview",
  ])
  const seen: string[] = []
  return new HTMLRewriter()
    .on("*", {
      element(el) {
        // The real logos have at most 27 elements, so the default cap only keeps a hostile file's walk short.
        // A throw aborts the rewrite, which rejects below.
        if (
          seen.push(el.tagName) > limit.elements ||
          !inert.has(el.tagName) ||
          [...el.attributes].some((attr) => unsafeAttribute(el.tagName, ...attr))
        )
          throw new Error("not inert")
      },
    })
    .transform(new Response(`${svg}<${end}/>`))
    .text()
    .then(
      () => seen.at(-1) === end,
      () => false,
    )
}

// Event handlers by any prefix, and links that leave the document. An <image> may inline a raster or vector picture.
function unsafeAttribute(tag: string, name: string, value: string) {
  const local = name.slice(name.lastIndexOf(":") + 1)
  if (local.startsWith("on")) return true
  if (local !== "href") return false
  return !value.startsWith("#") && !(tag === "image" && value.startsWith("data:image/"))
}
