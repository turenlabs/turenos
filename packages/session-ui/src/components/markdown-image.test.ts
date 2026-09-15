import { describe, expect, test } from "bun:test"
import { localMarkdownPath } from "./markdown-image"

describe("localMarkdownPath", () => {
  test("accepts workspace-relative and absolute file paths", () => {
    expect(localMarkdownPath("provider-usage-dashboard.png")).toBe("provider-usage-dashboard.png")
    expect(localMarkdownPath("./artifacts/chart%20one.png?raw=1#preview")).toBe("./artifacts/chart one.png")
    expect(localMarkdownPath("/tmp/chart.png")).toBe("/tmp/chart.png")
    expect(localMarkdownPath("C:\\work\\chart.png")).toBe("C:\\work\\chart.png")
    expect(localMarkdownPath("file:///tmp/chart%20one.png")).toBe("/tmp/chart one.png")
    expect(localMarkdownPath("file:///C:/work/chart.png")).toBe("C:/work/chart.png")
    expect(localMarkdownPath("file://server/share/chart.png")).toBeUndefined()
  })

  test("leaves browser-resolvable sources alone", () => {
    expect(localMarkdownPath("https://example.com/chart.png")).toBeUndefined()
    expect(localMarkdownPath("data:image/png;base64,abc")).toBeUndefined()
    expect(localMarkdownPath("blob:http://localhost/id")).toBeUndefined()
    expect(localMarkdownPath("//cdn.example.com/chart.png")).toBeUndefined()
    expect(localMarkdownPath("#chart")).toBeUndefined()
  })
})
