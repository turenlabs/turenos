import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const runtime = fileURLToPath(new URL("./src/components/animation-runtime.ts", import.meta.url))
const runtimeID = "virtual:turen-animation-runtime"
const licensesID = "virtual:turen-visualization-licenses"

/** Bundle only the owned runtime. Agent HTML never enters the compiler. */
export function animationRuntimePlugin() {
  const state = { bundle: undefined, notices: undefined }
  return {
    name: "turen:animation-runtime",
    resolveId(source) {
      if (source === runtimeID || source === licensesID) return "\0" + source
    },
    async load(id) {
      if (id === "\0" + licensesID) {
        state.notices ??= visualizationNotices()
        return `export default ${JSON.stringify(state.notices)};`
      }
      if (id !== "\0" + runtimeID) return
      this.addWatchFile(runtime)
      state.bundle ??= build({
        entryPoints: [runtime],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: true,
        metafile: true,
        legalComments: "inline",
      }).then((result) => {
        for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(path.resolve(input))
        return result.outputFiles[0].text
      })
      return `export default ${JSON.stringify(await state.bundle)};`
    },
    watchChange() {
      state.bundle = undefined
    },
    generateBundle() {
      state.notices ??= visualizationNotices()
      this.emitFile({ type: "asset", fileName: "visualization-NOTICES.txt", source: state.notices })
    },
  }
}

// Include every runtime dependency's original notice, including D3's subpackages.
export function visualizationNotices() {
  const visited = new Set()
  const notices = []
  function collect(name, from) {
    const entry = createRequire(from).resolve(name)
    let root = path.dirname(entry)
    while (
      !existsSync(path.join(root, "package.json")) ||
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name !== name
    ) {
      const parent = path.dirname(root)
      if (parent === root) throw new Error(`Missing package metadata for ${name}`)
      root = parent
    }
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
    const key = `${manifest.name}@${manifest.version}`
    if (visited.has(key)) return
    visited.add(key)
    const files = readdirSync(root)
      .filter((file) => /^licen[cs]e(?:[.-].*)?$/i.test(file))
      .sort()
    if (!files.length) throw new Error(`Missing license notice for ${key}`)
    notices.push(
      `${key} (${manifest.license})\n\n${files.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n")}\n`,
    )
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) collect(dependency, entry)
  }
  collect("d3", import.meta.url)
  collect("animejs", import.meta.url)
  return notices.join("\n----------------------------------------\n\n")
}
