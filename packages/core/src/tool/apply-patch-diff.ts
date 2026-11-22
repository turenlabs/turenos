export * as ApplyPatchDiff from "./apply-patch-diff"

import { createTwoFilesPatch, diffLines } from "diff"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { lazy } from "../util/lazy"

const loadWasm = lazy(async () => {
  const wasm = await import("@turenlabs/text-diff-wasm")
  const { default: wasmPath } = await import(
    // @ts-ignore Bun embeds file imports when compiling the CLI.
    "@turenlabs/text-diff-wasm/turen_text_diff_wasm_bg.wasm",
    { with: { type: "file" } },
  )
  const bytes = await readFile(path.isAbsolute(wasmPath) ? wasmPath : new URL(wasmPath, import.meta.url))
  await wasm.default({ module_or_path: bytes })
  return wasm.diff_text
})

export async function formatPatchDiff(input: {
  before: string
  after: string
  oldName: string
  newName: string
  patchLines: number
}) {
  const { before, after, oldName, newName } = input
  // Small patches do not repay WASM startup. Bound the memory retained by the WASM instance.
  if (
    input.patchLines >= 256 &&
    Buffer.byteLength(before) + Buffer.byteLength(after) <= 256 * 1024 &&
    after.isWellFormed()
  ) {
    try {
      const diff = await loadWasm()
      const encoder = new TextEncoder()
      const result = JSON.parse(
        diff(encoder.encode(before), encoder.encode(after), JSON.stringify({ oldName, newName })),
      ) as {
        readonly schema_version: number
        readonly binary?: boolean
        readonly lossy?: boolean
        readonly approximate?: boolean
        readonly patchTruncated?: boolean
        readonly patch?: string
        readonly additions?: number
        readonly deletions?: number
      }
      if (
        result.schema_version === 1 &&
        !result.binary &&
        !result.lossy &&
        !result.approximate &&
        !result.patchTruncated &&
        typeof result.patch === "string" &&
        typeof result.additions === "number" &&
        typeof result.deletions === "number"
      )
        return { patch: result.patch, additions: result.additions, deletions: result.deletions }
    } catch {
      // A failed accelerator must not prevent an approved patch from applying.
    }
  }
  const counts = diffLines(before, after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return { patch: createTwoFilesPatch(oldName, newName, before, after), ...counts }
}
