import { createRequire } from "node:module"
import createDOMPurify from "dompurify"
import { JSDOM } from "jsdom"
import { safeHtmlDocument } from "../src/components/safehtml-sanitize"

const html = safeHtmlDocument(
  `
  <style>@import url(https://example.invalid/style.css);body{background:#eef7ff}svg{width:100%}p{background-image:url(https://example.invalid/pixel)}</style>
  <h1>Inline Source Map</h1>
  <details><summary>Source notes</summary><p>Measured in lines.</p></details>
  <label for="toggle">Show tests</label><input id="toggle" type="checkbox">
  <svg viewBox="0 0 600 120"><rect width="360" height="120" fill="#0f766e"/><rect x="360" width="240" height="120" fill="#2563eb"/><text x="20" y="60" fill="white">Source</text></svg>
  <script>top.document.body.dataset.compromised="yes"</script>
  <img src="https://example.invalid/leak" onerror="top.document.body.dataset.compromised='yes'">
  <a href="https://example.invalid" target="_top">Navigation</a>
`,
  createDOMPurify(new JSDOM("").window),
)
if (!html) throw new Error("Probe fixture failed sanitization")
const require = createRequire(new URL("../../desktop/package.json", import.meta.url))
const child = Bun.spawn([require("electron"), new URL("./safehtml-browser-probe.cjs", import.meta.url).pathname], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SAFE_HTML_DOCUMENT: Buffer.from(html).toString("base64") },
  stdout: "inherit",
  stderr: "inherit",
})
const timer = setTimeout(() => child.kill(), 30000)
const exit = await child.exited
clearTimeout(timer)
if (exit !== 0) throw new Error(`Safe HTML browser probe failed with exit ${exit}`)
