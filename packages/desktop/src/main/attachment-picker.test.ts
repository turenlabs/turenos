import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertAttachmentBudget,
  createPickedFileAuthorizations,
  MAX_ATTACHMENT_BYTES,
  PICKED_FILE_HEAD_BYTES,
  PICKED_FILE_PREVIEW_BYTES,
  readAttachment,
} from "./attachment-picker"

describe("assertAttachmentBudget", () => {
  test("accepts selections within the media ingest limit", () => {
    expect(() =>
      assertAttachmentBudget([{ size: MAX_ATTACHMENT_BYTES / 2 }, { size: MAX_ATTACHMENT_BYTES / 2 }]),
    ).not.toThrow()
  })

  test("rejects a file over the limit before it is read", () => {
    expect(() => assertAttachmentBudget([{ size: MAX_ATTACHMENT_BYTES + 1 }])).toThrow("256 MB limit")
  })

  test("reads an approved file through a bounded buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-attachment-"))
    const file = join(directory, "example.txt")
    try {
      await writeFile(file, "lorem ipsum")
      const result = await readAttachment(file)
      expect(new TextDecoder().decode(result.bytes)).toBe("lorem ipsum")
      expect(result.size).toBe(11)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reads only a mime head from an oversized file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-attachment-"))
    const file = join(directory, "oversized.txt")
    try {
      await writeFile(file, "lorem ipsum")
      await truncate(file, PICKED_FILE_PREVIEW_BYTES + 1)
      const result = await readAttachment(file)
      expect(result.size).toBe(PICKED_FILE_PREVIEW_BYTES + 1)
      expect(result.bytes.byteLength).toBe(PICKED_FILE_HEAD_BYTES)
      expect(new TextDecoder().decode(result.bytes).startsWith("lorem ipsum")).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("picked file authorizations", () => {
  const read = async (path: string) => ({ bytes: new TextEncoder().encode(path).buffer as ArrayBuffer, size: 0 })

  test("keeps concurrent picker selections isolated", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const first = authorizations.add(1, ["a.txt", "b.txt"])
    const second = authorizations.add(1, ["c.txt"])

    expect(new TextDecoder().decode((await authorizations.read(1, first, "a.txt")).bytes)).toBe("a.txt")
    expect(new TextDecoder().decode((await authorizations.read(1, second, "c.txt")).bytes)).toBe("c.txt")
    expect(new TextDecoder().decode((await authorizations.read(1, first, "b.txt")).bytes)).toBe("b.txt")
  })

  test("releases unread files for one picker without affecting another", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const first = authorizations.add(1, ["a.txt"])
    const second = authorizations.add(1, ["b.txt"])
    authorizations.release(1, first)

    await expect(authorizations.read(1, first, "a.txt")).rejects.toThrow("not selected")
    expect(new TextDecoder().decode((await authorizations.read(1, second, "b.txt")).bytes)).toBe("b.txt")
  })

  test("keeps picker tokens scoped to their renderer", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const token = authorizations.add(1, ["a.txt"])

    await expect(authorizations.read(2, token, "a.txt")).rejects.toThrow("not selected")
  })

  test("consumes each authorized path on read", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const token = authorizations.add(1, ["a.txt"])

    await authorizations.read(1, token, "a.txt")
    await expect(authorizations.read(1, token, "a.txt")).rejects.toThrow("not selected")
  })

  test("keeps picked paths revealable after the read authorization is consumed", async () => {
    const authorizations = createPickedFileAuthorizations(read)
    const token = authorizations.add(1, ["a.txt", "b.txt"])

    expect(authorizations.allowsReveal("a.txt")).toBe(true)
    expect(authorizations.allowsReveal("other.txt")).toBe(false)

    await authorizations.read(1, token, "a.txt")
    expect(authorizations.allowsReveal("a.txt")).toBe(true)

    authorizations.release(1, token)
    expect(authorizations.allowsReveal("b.txt")).toBe(true)
  })
})
