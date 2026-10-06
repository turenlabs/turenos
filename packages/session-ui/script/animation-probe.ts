import { createRequire } from "node:module"
import createDOMPurify from "dompurify"
import { JSDOM } from "jsdom"
import { Animation } from "@turenlabs/schema/animation"
import { Schema } from "effect"
import { animationRuntimePlugin } from "../animation.vite.js"
import { animationDocument } from "../src/components/animation-document"

const module = await animationRuntimePlugin().load.call({ addWatchFile() {} }, "\0virtual:turen-animation-runtime")
const runtime = JSON.parse(module!.slice("export default ".length, -1)) as string
const token = "a".repeat(32)
const spec = Schema.decodeUnknownSync(Animation.Spec)({
  version: 1,
  title: "Motion </script><script>top.document.body.dataset.compromised='yes'</script>",
  html: `
    <style>@import url(https://example.invalid/leak.css);svg{width:100%}p{background-image:url(https://example.invalid/pixel)}
      @keyframes spin{to{transform:rotate(360deg)}}#native-motion{animation:spin 1s linear infinite!important}
      @media(min-width:0px){#native-motion::before{content:'native';animation:spin 1s linear infinite!important}}
    </style>
    <div id="native-motion" style="animation:spin 1s linear infinite!important;transition:all 2s!important">Native motion is disabled.</div>
    <svg viewBox="0 0 100 30" onload="top.document.body.dataset.compromised='yes'">
      <circle id="ball" cx="10" cy="10" r="5" fill="#000"><animate attributeName="r" values="5;10;5" dur="1s" repeatCount="indefinite" /></circle>
      <text id="counter" x="10" y="25">0</text>
      <text id="tiny-counter" x="60" y="25">0.000001</text>
      <rect id="block" x="0" y="0" width="5" height="5" />
    </svg>
    <p>Bounded motion</p>
    <script nonce="${"b".repeat(32)}">top.document.body.dataset.compromised='yes'</script>
    <img src="https://example.invalid/leak" onerror="top.document.body.dataset.compromised='yes'">
    <a href="https://example.invalid" target="_top">Navigation</a>
  `,
  tracks: [
    { target: "ball", property: "cx", keyframes: [10, 90], duration: 1000 },
    { target: "counter", property: "textContent", keyframes: [0, 1000], duration: 1000 },
    { target: "tiny-counter", property: "textContent", keyframes: [0.000001, 0.000003], duration: 1000 },
    { target: "block", property: "translateX", keyframes: [0, 80], duration: 1000 },
    { target: "ball", property: "fill", keyframes: ["#000", "#fff"], duration: 1000 },
  ],
})
const html = animationDocument(spec, token, "b".repeat(32), runtime, createDOMPurify(new JSDOM("").window))
if (!html) throw new Error("Animation probe fixture failed sanitization")
const require = createRequire(new URL("../../desktop/package.json", import.meta.url))
const child = Bun.spawn([require("electron"), new URL("./animation-browser-probe.cjs", import.meta.url).pathname], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    ANIMATION_DOCUMENT: Buffer.from(html).toString("base64"),
    ANIMATION_TOKEN: token,
  },
  stdout: "inherit",
  stderr: "inherit",
})
const timer = setTimeout(() => child.kill(), 30000)
const exit = await child.exited
clearTimeout(timer)
if (exit !== 0) throw new Error(`Animation browser probe failed with exit ${exit}`)
