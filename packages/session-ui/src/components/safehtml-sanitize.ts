import DOMPurify from "dompurify"
import { SafeHtml } from "@turenlabs/schema/safehtml"

export const SAFE_HTML_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export function sanitizeHtml(
  html: string,
  purifier: Pick<typeof DOMPurify, "isSupported" | "sanitize"> = DOMPurify,
): string | undefined {
  if (!purifier.isSupported || html.length > SafeHtml.MAX_BYTES) return
  const content = purifier.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    ADD_TAGS: ["style"],
    FORCE_BODY: true,
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "base",
      "link",
      "meta",
      "form",
      "foreignObject",
      "audio",
      "video",
      "source",
      "track",
    ],
    FORBID_ATTR: [
      "href",
      "xlink:href",
      "src",
      "srcset",
      "action",
      "formaction",
      "poster",
      "background",
      "ping",
      "target",
      "download",
    ],
    RETURN_DOM_FRAGMENT: true,
  })
  // A byte limit alone still permits thousands of tiny elements.
  if (content.querySelectorAll("*").length > 5000) return
  const container = content.ownerDocument.createElement("div")
  container.append(content)
  return container.innerHTML
}

export function safeHtmlDocument(
  html: string,
  purifier: Pick<typeof DOMPurify, "isSupported" | "sanitize"> = DOMPurify,
): string | undefined {
  const content = sanitizeHtml(html, purifier)
  if (content === undefined) return
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${SAFE_HTML_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:light dark}body{margin:16px;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box}svg{max-width:100%}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${content}</body></html>`
}
