import { describe, expect, test } from "bun:test"
import createDOMPurify from "dompurify"
import { JSDOM } from "jsdom"
import { safeHtmlDocument, SAFE_HTML_CSP } from "./safehtml-sanitize"

const purifier = createDOMPurify(new JSDOM("").window)
const sanitize = (html: string) => new JSDOM(safeHtmlDocument(html, purifier)).window.document

describe("safe HTML in chat", () => {
  test("preserves styled HTML, native controls, SVG, and source text", () => {
    const doc = sanitize(
      '<style>#extra:checked ~ p{color:teal}</style><label for="extra">More</label><input id="extra" type="checkbox"><details><summary>Measured data</summary><table><tr><td>240 lines</td></tr></table></details><svg viewBox="0 0 100 40"><rect width="100" height="40" fill="teal"/><text x="4" y="20">Source</text></svg>',
    )
    expect(doc.body.querySelector("style")?.textContent).toContain("#extra:checked")
    expect(doc.querySelector("label")?.getAttribute("for")).toBe("extra")
    expect(doc.querySelector("input")?.id).toBe("extra")
    expect(doc.querySelector("details summary")?.textContent).toBe("Measured data")
    expect(doc.querySelector("td")?.textContent).toBe("240 lines")
    expect(doc.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 100 40")
    expect(doc.querySelector("svg text")?.textContent).toBe("Source")
  })

  test("removes scripts, event handlers, navigation, embeds, and resource URLs", () => {
    const doc = sanitize(
      '<script>window.top.location="https://evil.invalid"</script><meta http-equiv="refresh" content="0;url=https://evil.invalid"><base href="https://evil.invalid"><link rel="stylesheet" href="https://evil.invalid"><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="file:///etc/passwd"></object><form action="https://evil.invalid"><input></form><a href="https://evil.invalid" target="_top" onclick="alert(1)">Link</a><img src="https://evil.invalid" srcset="https://evil.invalid 2x" onerror="alert(1)"><svg><a xlink:href="javascript:alert(1)">bad</a><foreignObject><div>embedded</div></foreignObject></svg>',
    )
    expect(doc.querySelector("script,iframe,object,embed,base,link,form,foreignObject")).toBeNull()
    expect(doc.querySelectorAll("meta")).toHaveLength(2)
    expect(doc.querySelector("[href],[src],[srcset],[onclick],[onerror],[target],[action]")).toBeNull()
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toBe(SAFE_HTML_CSP)
  })

  test("sets restrictive CSP before supplied content and never loads CSS resources", () => {
    const result = safeHtmlDocument(
      '<style>@import "https://evil.invalid/style.css";p{background:url(https://evil.invalid/pixel)}</style><p>ok</p>',
      purifier,
    )!
    expect(result.indexOf("Content-Security-Policy")).toBeLessThan(result.indexOf("@import"))
    expect(SAFE_HTML_CSP).toContain("default-src 'none'")
    expect(SAFE_HTML_CSP).toContain("script-src 'none'")
    expect(SAFE_HTML_CSP).toContain("img-src 'none'")
    expect(SAFE_HTML_CSP).toContain("form-action 'none'")
  })

  test("rejects excessive DOM size, oversized input, and an unsupported sanitizer", () => {
    expect(safeHtmlDocument("<i></i>".repeat(5001), purifier)).toBeUndefined()
    expect(safeHtmlDocument("x".repeat(512 * 1024 + 1), purifier)).toBeUndefined()
    expect(safeHtmlDocument("<p>ok</p>", { ...purifier, isSupported: false })).toBeUndefined()
  })
})
