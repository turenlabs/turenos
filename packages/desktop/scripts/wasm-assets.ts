import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

const parserRuntimePatterns = [
  ["runtime", /^tree-sitter-[a-z0-9]+\.wasm$/],
  ["Bash", /^tree-sitter-bash-[a-z0-9]+\.wasm$/],
  ["PowerShell", /^tree-sitter-powershell-[a-z0-9]+\.wasm$/],
] as const

export async function referencedWasmAssets(directory: string) {
  const javascript = (await readdir(directory, { recursive: true })).filter((file) => file.endsWith(".js"))
  const references = (
    await Promise.all(
      javascript.map(async (file) => {
        const source = await readFile(path.join(directory, file), "utf8")
        return Array.from(source.matchAll(/["'](\.\/[^"']+\.wasm)["']/g), (match) =>
          path.join(path.dirname(file), ...match[1].split("/")),
        )
      }),
    )
  ).flat()
  return Array.from(new Set(references)).sort()
}

export function missingTreeSitterAssets(assets: ReadonlyArray<string>) {
  return parserRuntimePatterns
    .filter(([, pattern]) => !assets.some((file) => pattern.test(path.basename(file))))
    .map(([name]) => name)
}
