import assert from "node:assert/strict"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "inline-visualization-fixture",
  setup(build) {
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
    selector: "iframe",
    spec: { version: 1, title: "Inline HTML", html: "<details><summary>Data</summary><p>240 lines</p></details>" },
  },
  {
    name: "visualize",
    selector: "[data-component=visualization-viewer] svg",
    spec: { version: 1, title: "Inline Chart", kind: "bar", items: [{ label: "Source", value: 240 }] },
  },
]

for (const entry of cases) {
  const host = document.createElement("div")
  document.body.append(host)
  const [state, setState] = createStore({ status: "running", metadata: {} as Record<string, unknown> })
  const dispose = render(
    () =>
      createComponent(InlineVisualizationTool, {
        tool: entry.name,
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
  assert.ok(host.querySelector(entry.selector), `${entry.name} completed body must render, not just its title`)
  if (entry.name === "safehtml") {
    assert.equal(host.querySelector("iframe")?.getAttribute("sandbox"), "")
    assert.ok(host.querySelector("iframe")?.srcdoc.includes("240 lines"))
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
