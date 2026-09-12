import { describe, expect, test } from "bun:test"
import createDOMPurify from "dompurify"
import { JSDOM } from "jsdom"
import { configureSanitizer, sanitizeMarkdown } from "./markdown-cache"

// Model output reaches `innerHTML` through this boundary. The purifier needs a real
// HTML parser — DOMPurify is inert without a window — so the suite binds the
// production config and hook to a jsdom-backed instance.
const { window } = new JSDOM("")
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue
  const descriptor = Object.getOwnPropertyDescriptor(window, key)
  if (descriptor) Object.defineProperty(globalThis, key, descriptor)
}
const purify = createDOMPurify(window)
configureSanitizer(purify)
const sanitize = (html: string) => sanitizeMarkdown(html, purify)

describe("sanitizeMarkdown", () => {
  test("strips script tags and their contents", () => {
    const html = sanitize(`<p>ok</p><script>alert(1)</script>`)
    expect(html).toContain("ok")
    expect(html).not.toContain("script")
    expect(html).not.toContain("alert")
  })

  test("strips style tags and their contents", () => {
    const html = sanitize(`<p>ok</p><style>body{display:none}</style>`)
    expect(html).not.toContain("style")
    expect(html).not.toContain("display:none")
  })

  test("strips event handler attributes", () => {
    const html = sanitize(`<img src="x" onerror="alert(1)"><a href="#" onclick="alert(1)">x</a>`)
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("onclick")
  })

  test("strips javascript: URLs", () => {
    const html = sanitize(`<a href="javascript:alert(1)">x</a>`)
    expect(html).not.toContain("javascript:")
  })

  test("strips iframes", () => {
    expect(sanitize(`<iframe src="https://evil.example"></iframe>`)).not.toContain("iframe")
  })

  test("preserves ordinary markup", () => {
    const html = sanitize(`<p>text <code>code</code> <a href="https://example.com">link</a></p>`)
    expect(html).toContain("<code>code</code>")
    expect(html).toContain('href="https://example.com"')
  })

  test("preserves opted-in SVG elements", () => {
    const html = sanitize(`<svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg>`)
    expect(html).toContain("<svg")
    expect(html).toContain('viewBox="0 0 10 10"')
    expect(html).toContain("<path")
    expect(html).toContain('d="M0 0h10"')
  })

  test("preserves MathML", () => {
    const html = sanitize(`<math><mi>x</mi><mo>+</mo><mn>1</mn></math>`)
    expect(html).toContain("<math")
    expect(html).toContain("<mi>x</mi>")
  })

  test("forces rel=noopener noreferrer on target=_blank links", () => {
    const html = sanitize(`<a href="https://example.com" target="_blank">x</a>`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain("noopener")
    expect(html).toContain("noreferrer")
  })

  test("merges rather than replaces an existing rel list", () => {
    const html = sanitize(`<a href="https://example.com" target="_blank" rel="nofollow">x</a>`)
    expect(html).toContain("nofollow")
    expect(html).toContain("noopener")
    expect(html).toContain("noreferrer")
  })

  test("does not force rel onto links without target=_blank", () => {
    const html = sanitize(`<a href="https://example.com">x</a>`)
    expect(html).not.toContain("noopener")
    expect(html).not.toContain("noreferrer")
  })

  test("returns empty output when the purifier has no DOM", () => {
    expect(sanitizeMarkdown("<p>ok</p>", { isSupported: false, sanitize: undefined as never, addHook: () => {} })).toBe("")
  })
})
