import assert from "node:assert/strict"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
const animationPlugin = (await import("@turenlabs/session-ui/vite")).animationRuntimePlugin()
const animationRuntime = await animationPlugin.load.call({ addWatchFile() {} }, "\0virtual:turen-animation-runtime")
const visualizationLicenses = await animationPlugin.load.call(
  { addWatchFile() {} },
  "\0virtual:turen-visualization-licenses",
)
plugin({
  name: "inline-visualization-fixture",
  setup(build) {
    build.module("virtual:turen-animation-runtime", () => ({
      exports: { default: JSON.parse(animationRuntime!.slice("export default ".length, -1)) },
      loader: "object",
    }))
    build.module("virtual:turen-visualization-licenses", () => ({
      exports: { default: JSON.parse(visualizationLicenses!.slice("export default ".length, -1)) },
      loader: "object",
    }))
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const result = await compiler.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[preset.default, { generate: "dom" }]],
      })
      return { contents: result?.code ?? "", loader: "tsx" }
    })
  },
})

const { InlineVisualizationTool } = await import("@turenlabs/session-ui/inline-visualization-tool")
const cases = [
  {
    name: "safehtml",
    tool: "safehtml",
    selector: "iframe",
    spec: { version: 1, title: "Inline HTML", html: "<details><summary>Data</summary><p>240 lines</p></details>" },
  },
  {
    name: "visualize chart",
    tool: "visualize",
    selector: "[data-component=visualization-viewer] svg",
    spec: { version: 1, title: "Inline Chart", kind: "bar", items: [{ label: "Source", value: 240 }] },
  },
  {
    name: "visualize HTML",
    tool: "visualize",
    selector: "iframe",
    spec: { version: 1, title: "Inline HTML", html: "<p>240 lines</p>" },
  },
  {
    name: "animate",
    tool: "animate",
    selector: "iframe",
    spec: {
      version: 1,
      title: "Inline Motion",
      html: '<svg viewBox="0 0 100 20"><circle id="ball" cx="10" cy="10" r="5" /></svg>',
      tracks: [{ target: "ball", property: "cx", keyframes: [10, 90], duration: 1000 }],
    },
  },
]

for (const entry of cases) {
  const host = document.createElement("div")
  document.body.append(host)
  const [state, setState] = createStore({ status: "running", metadata: {} as Record<string, unknown> })
  const dispose = render(
    () =>
      createComponent(InlineVisualizationTool, {
        tool: entry.tool,
        input: {},
        hideDetails: true,
        get status() {
          return state.status
        },
        get metadata() {
          return state.metadata
        },
      }),
    host,
  )
  assert.equal(host.querySelector(entry.selector), null)
  setState({ status: "completed", metadata: { structured: entry.spec } })
  for (let attempt = 0; attempt < 100 && !host.querySelector(entry.selector); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(
    host.querySelector(entry.selector),
    `${entry.name} completed body must render, not just its title: ${host.textContent?.slice(0, 300)}`,
  )
  if (entry.tool === "safehtml" || entry.name === "visualize HTML") {
    assert.equal(host.querySelector("iframe")?.getAttribute("sandbox"), "")
    assert.ok(host.querySelector("iframe")?.srcdoc.includes("240 lines"))
  }
  if (entry.tool === "animate") {
    assert.equal(host.querySelector("iframe")?.getAttribute("sandbox"), "allow-scripts")
    assert.ok(host.querySelector("iframe")?.srcdoc.includes("script-src 'nonce-"))
    assert.ok(Array.from(host.querySelectorAll("button")).some((button) => button.textContent?.includes("Play")))
  }
  assert.ok(host.querySelector("[data-slot=collapsible-arrow]"))
  const trigger = host.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!
  trigger.click()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.querySelector(entry.selector), null)
  trigger.click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(host.querySelector(entry.selector), `${entry.name} must reopen`)
  dispose()
  host.remove()
}
console.log("inline visualization checks passed")
