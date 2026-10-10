import { expect, test } from "bun:test"
import { FSUtil } from "../src/fs-util"

test("TypeScript sources are text, not MPEG transport streams", () => {
  for (const file of ["src/answer.ts", "a/b.MTS", "c.cts", "view.tsx"])
    expect(FSUtil.mimeType(file)).toBe("text/x-typescript")
})

test("other types keep their mime-types mapping and unknown files stay binary", () => {
  expect(FSUtil.mimeType("logo.png")).toBe("image/png")
  expect(FSUtil.mimeType("notes.md")).toBe("text/markdown")
  expect(FSUtil.mimeType("blob.unknownext")).toBe("application/octet-stream")
})
