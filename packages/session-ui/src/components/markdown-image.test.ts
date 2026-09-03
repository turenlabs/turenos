import { describe, expect, test } from "bun:test"
import { localMarkdownImagePath } from "./markdown-image"

describe("localMarkdownImagePath", () => {
  test("accepts workspace-relative and absolute file paths", () => {
    expect(localMarkdownImagePath("provider-usage-dashboard.png")).toBe("provider-usage-dashboard.png")
    expect(localMarkdownImagePath("./artifacts/chart%20one.png?raw=1#preview")).toBe("./artifacts/chart one.png")
    expect(localMarkdownImagePath("/tmp/chart.png")).toBe("/tmp/chart.png")
    expect(localMarkdownImagePath("C:\\work\\chart.png")).toBe("C:\\work\\chart.png")
    expect(localMarkdownImagePath("file:///tmp/chart%20one.png")).toBe("/tmp/chart one.png")
    expect(localMarkdownImagePath("file:///C:/work/chart.png")).toBe("C:/work/chart.png")
    expect(localMarkdownImagePath("file://server/share/chart.png")).toBeUndefined()
  })

  test("leaves browser-resolvable sources alone", () => {
    expect(localMarkdownImagePath("https://example.com/chart.png")).toBeUndefined()
    expect(localMarkdownImagePath("data:image/png;base64,abc")).toBeUndefined()
    expect(localMarkdownImagePath("blob:http://localhost/id")).toBeUndefined()
    expect(localMarkdownImagePath("//cdn.example.com/chart.png")).toBeUndefined()
    expect(localMarkdownImagePath("#chart")).toBeUndefined()
  })
})
