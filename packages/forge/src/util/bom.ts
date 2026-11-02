import { Effect } from "effect"
import { isUtf8 } from "node:buffer"
import { FSUtil } from "@turenlabs/core/fs-util"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

export const readFile = Effect.fn("Bom.readFile")(function* (fs: FSUtil.Interface, filePath: string) {
  return split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(yield* fs.readFile(filePath)))
})

// For callers that write the whole file back: readFile's lossy decode would turn every invalid byte in
// the file into U+FFFD on write, not just the text being changed.
export const readUtf8File = Effect.fn("Bom.readUtf8File")(function* (fs: FSUtil.Interface, filePath: string) {
  const bytes = yield* fs.readFile(filePath)
  if (!isUtf8(bytes))
    return yield* Effect.fail(new Error(`File is not valid UTF-8: ${filePath}. Only UTF-8 text files can be edited.`))
  return split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
})

export const syncFile = Effect.fn("Bom.syncFile")(function* (fs: FSUtil.Interface, filePath: string, bom: boolean) {
  const current = yield* readFile(fs, filePath)
  if (current.bom === bom) return current.text
  yield* fs.writeWithDirs(filePath, join(current.text, bom))
  return current.text
})
