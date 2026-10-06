import type { Animation } from "@turenlabs/schema/animation"
import DOMPurify from "dompurify"
import { sanitizeHtml } from "./safehtml-sanitize"

export function animationDocument(
  spec: Animation.Spec,
  token: string,
  nonce: string,
  runtime: string,
  purifier: Pick<typeof DOMPurify, "isSupported" | "sanitize"> = DOMPurify,
) {
  if (!/^[a-f0-9]{32}$/.test(token) || !/^[a-f0-9]{32}$/.test(nonce)) return
  const html = sanitizeHtml(spec.html, purifier)
  if (html === undefined) return
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  const data = JSON.stringify({ ...spec, html: undefined, token }).replace(/</g, "\\u003c")
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><script type="application/json" nonce="${nonce}" id="turen-animation-data">${data}</script><style>:root{color-scheme:light dark}body{margin:16px;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box}svg{max-width:100%}pre{white-space:pre-wrap}</style></head><body><div id="turen-animation-root">${html}</div><script nonce="${nonce}">${runtime.replace(/<\/script/gi, "<\\/script")}</script></body></html>`
}
