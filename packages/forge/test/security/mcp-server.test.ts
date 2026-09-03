import { expect, test } from "bun:test"
import { MAX_RESULT_BYTES, serializeResult } from "@/security/mcp/server"

test("serialized MCP results remain within the byte cap after JSON escaping", () => {
  const result = serializeResult('\\"\n'.repeat(30_000))

  expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES)
  expect(JSON.parse(result)).toMatchObject({ truncated: true })
})
