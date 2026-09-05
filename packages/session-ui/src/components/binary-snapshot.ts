export type BinarySnapshot = {
  path: string
  kind: "hex" | "disassembly"
  rows: Array<{ offset: number; address?: string; bytes: string[]; text?: string }>
  bitness?: number
  architecture?: "arm64" | "x86"
  nextOffset?: number
  warnings: string[]
}

const MAX_TEXT = 1024 * 1024

export function binarySnapshot(
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  output?: string,
): BinarySnapshot | undefined {
  if (tool === "hexview") return hexSnapshot(input, record(metadata.structured))
  if (tool !== "disassemble") return
  const structured = record(metadata.structured)
  const report = parseReport(structured?.report ?? output)
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.operation !== "disassemble" ||
    !boundedText(report.path) ||
    !report.path ||
    typeof report.truncated !== "boolean" ||
    !Array.isArray(report.warnings) ||
    !report.warnings.every(boundedText)
  )
    return
  const result = record(report.result)
  if (
    !result ||
    !safeOffset(result.offset) ||
    (result.bitness !== 16 && result.bitness !== 32 && result.bitness !== 64) ||
    !Array.isArray(result.instructions) ||
    result.instructions.length > 4096
  )
    return
  const rows: BinarySnapshot["rows"] = []
  let offset = result.offset
  for (const value of result.instructions) {
    const instruction = record(value)
    if (
      !instruction ||
      !boundedText(instruction.address) ||
      !/^0x[\da-f]+$/i.test(instruction.address) ||
      !boundedText(instruction.text) ||
      !instruction.text
    )
      return
    const bytes = decodeBytes(instruction.bytes, 4096)
    if (!bytes?.length || offset - result.offset + bytes.length > 4096 || !safeOffset(offset + bytes.length)) return
    // Addresses are virtual, potentially 64-bit values; only byte counts advance file offsets.
    rows.push({ offset, address: instruction.address, bytes, text: instruction.text })
    offset += bytes.length
  }
  return {
    path: report.path,
    kind: "disassembly",
    rows,
    bitness: result.bitness,
    architecture: result.architecture === "arm64" ? "arm64" : "x86",
    warnings: [...report.warnings, ...(report.truncated ? ["Disassembly report was truncated."] : [])],
  }
}

function hexSnapshot(
  input: Record<string, unknown>,
  structured: Record<string, unknown> | undefined,
): BinarySnapshot | undefined {
  if (
    !structured ||
    !boundedText(structured.path) ||
    !structured.path ||
    !safeOffset(structured.offset) ||
    !safeOffset(structured.length) ||
    structured.length > 65536 ||
    !safeOffset(structured.offset + structured.length)
  )
    return
  const width = input.width ?? 16
  if (!safeOffset(width) || width < 8 || width > 32) return
  const nextOffset = structured.nextOffset
  if (nextOffset !== undefined && (!safeOffset(nextOffset) || nextOffset !== structured.offset + structured.length))
    return
  const bytes =
    structured.bytes !== undefined
      ? decodeBytes(structured.bytes, 65536)
      : historicalBytes(structured.content, structured.offset, width)
  if (!bytes || bytes.length !== structured.length) return
  const offset = structured.offset
  return {
    path: structured.path,
    kind: "hex",
    rows: Array.from({ length: Math.ceil(bytes.length / width) }, (_, index) => ({
      offset: offset + index * width,
      bytes: bytes.slice(index * width, (index + 1) * width),
    })),
    ...(nextOffset === undefined ? {} : { nextOffset }),
    warnings: [],
  }
}

function historicalBytes(content: unknown, offset: number, width: number) {
  if (!boundedText(content)) return
  if (!content) return []
  const lines = content.split("\n")
  if (lines.length > Math.ceil(65536 / width)) return
  const bytes: string[] = []
  for (const [index, line] of lines.entries()) {
    const match = /^0x([\da-f]+)  ([\da-f ]+)  \|([\x20-\x7e]*)\|$/i.exec(line)
    if (!match || Number.parseInt(match[1]!, 16) !== offset + bytes.length) return
    const row = match[2]!.trim().split(/ +/)
    if (
      !row.every((byte) => /^[\da-f]{2}$/i.test(byte)) ||
      row.length > width ||
      (index < lines.length - 1 && row.length !== width) ||
      bytes.length + row.length > 65536 ||
      match[3] !==
        row
          .map((byte) => {
            const value = Number.parseInt(byte, 16)
            return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : "."
          })
          .join("")
    )
      return
    bytes.push(...row.map((byte) => byte.toLowerCase()))
  }
  return bytes
}

function decodeBytes(value: unknown, limit: number) {
  if (typeof value !== "string" || value.length > limit * 2 || value.length % 2 || !/^[\da-f]*$/i.test(value)) return
  return value.toLowerCase().match(/../g) ?? []
}

function safeOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT && new TextEncoder().encode(value).length <= MAX_TEXT
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function parseReport(value: unknown) {
  if (!boundedText(value)) return
  try {
    return record(JSON.parse(value))
  } catch {
    return
  }
}
