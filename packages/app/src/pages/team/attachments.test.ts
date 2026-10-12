import { describe, expect, test } from "bun:test"
import {
  TEAM_ATTACHMENT_BYTES,
  TEAM_ATTACHMENT_LIMIT,
  TEAM_ATTACHMENT_TOTAL_BYTES,
  teamAttachmentBlob,
  teamAttachmentInline,
  teamAttachmentMime,
  teamAttachmentProblem,
  teamAttachmentSize,
} from "./attachments"

const uri = (mime: string, text: string) => `data:${mime};base64,${btoa(text)}`
const attachment = (name: string, mime: string, text = "payload") => ({ name, mime, uri: uri(mime, text) })

describe("team attachment limits", () => {
  test("allows five attachments, 10 MiB each, and 20 MiB in total", () => {
    expect([TEAM_ATTACHMENT_LIMIT, TEAM_ATTACHMENT_BYTES, TEAM_ATTACHMENT_TOTAL_BYTES]).toEqual([
      5,
      10 * 1024 * 1024,
      20 * 1024 * 1024,
    ])
    const four = Array.from({ length: 4 }, () => ({ size: 1 }))
    expect(teamAttachmentProblem(four, { name: "five.png", size: TEAM_ATTACHMENT_BYTES })).toBeUndefined()
    expect(teamAttachmentProblem([...four, { size: 1 }], { name: "six.png", size: 1 })).toContain("up to 5")
  })

  test("rejects an oversized, empty, or over-budget file", () => {
    expect(teamAttachmentProblem([], { name: "big.bin", size: TEAM_ATTACHMENT_BYTES + 1 })).toContain("big.bin")
    expect(teamAttachmentProblem([], { name: "empty.txt", size: 0 })).toContain("empty.txt")
    const used = [{ size: TEAM_ATTACHMENT_BYTES }, { size: TEAM_ATTACHMENT_BYTES - 1 }]
    expect(teamAttachmentProblem(used, { name: "ok.txt", size: 1 })).toBeUndefined()
    expect(teamAttachmentProblem(used, { name: "over.txt", size: 2 })).toContain("20 MiB")
  })
})

describe("team attachment content", () => {
  test("measures only strict base64 data URIs that match the declared type", () => {
    expect(teamAttachmentSize(attachment("a.txt", "text/plain", "hello"))).toBe(5)
    expect(teamAttachmentSize(attachment("a.txt", "text/plain", "hell"))).toBe(4)
    for (const bad of [
      "https://example.com/a.png",
      "file:///etc/passwd",
      "data:image/png,plain",
      "data:image/png;base64,@@@@",
      "data:image/png;base64,aGVsbG8",
      "data:image/png;charset=utf-8;base64,aGVsbG8=",
      "data:text/html;base64,aGVsbG8=",
    ])
      expect(teamAttachmentSize({ name: "a.png", mime: "image/png", uri: bad })).toBeUndefined()
  })

  test("shows only passive raster images inline", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      expect(teamAttachmentInline(attachment("a", mime))).toBe(uri(mime, "payload"))
    for (const mime of ["image/svg+xml", "text/html", "application/pdf", "image/bmp", "application/xhtml+xml"])
      expect(teamAttachmentInline(attachment("a", mime))).toBeUndefined()
    expect(teamAttachmentInline({ name: "a.png", mime: "image/png", uri: "https://example.com/a.png" })).toBeUndefined()
    expect(
      teamAttachmentInline({ name: "a.png", mime: "image/png", uri: uri("image/svg+xml", "<svg/>") }),
    ).toBeUndefined()
  })

  test("downloads every type as an opaque octet-stream Blob", async () => {
    for (const mime of ["image/svg+xml", "text/html", "image/png"]) {
      const blob = teamAttachmentBlob(attachment("a", mime, "<script>alert(1)</script>"))
      expect(blob?.type).toBe("application/octet-stream")
      expect(await blob?.text()).toBe("<script>alert(1)</script>")
    }
    expect(teamAttachmentBlob({ name: "a", mime: "text/html", uri: "https://example.com/a.html" })).toBeUndefined()
  })

  test("normalizes unusable media types to octet-stream", () => {
    expect(teamAttachmentMime("image/png")).toBe("image/png")
    expect(teamAttachmentMime("")).toBe("application/octet-stream")
    expect(teamAttachmentMime("text/html; charset=utf-8")).toBe("application/octet-stream")
    expect(teamAttachmentMime("not a type")).toBe("application/octet-stream")
  })
})
