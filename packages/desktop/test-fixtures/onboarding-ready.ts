import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { mock } from "bun:test"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

const app = fileURLToPath(new URL("../../app/", import.meta.url))
const compiler = await import(Bun.resolveSync("@babel/core", app))
const preset = await import(Bun.resolveSync("babel-preset-solid", app))
plugin({
  name: "desktop-onboarding-ready",
  setup(build) {
    build.onLoad({ filter: /[\\/]renderer[\\/]onboarding\.tsx$/ }, async (args) => {
      const result = await compiler.transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[preset.default, { generate: "dom" }]],
      })
      return { contents: result.code, loader: "tsx" }
    })
  },
})

let pending = false
let evaluation = Promise.withResolvers<void>()
const completion = Promise.withResolvers<void>()
mock.module("@turenlabs/app", () => ({
  ServerConnection: { key: () => "local" },
  useProviders: () => ({ connected: () => [] }),
  useServer: () => ({ ready: { promise: evaluation.promise }, isLocal: () => true, list: [] }),
  useSettings: () => ({ general: { setOldLayoutEligible: () => undefined } }),
  useSettingsDialog: () => () => undefined,
  useTabs: () => ({ ready: {}, recentReady: {}, store: [] }),
}))
mock.module("@turenlabs/ui/logo", () => ({ Mark: () => null }))
mock.module("@turenlabs/ui/button", () => ({
  Button: (props: { children: string; onClick: () => void }) => {
    const button = document.createElement("button")
    button.textContent = props.children
    button.onclick = props.onClick
    return button
  },
}))
mock.module(fileURLToPath(new URL("../src/renderer/i18n/index.ts", import.meta.url)), () => ({
  t: (key: string) => key,
}))
Object.defineProperty(window, "api", {
  value: {
    isOldLayoutEligible: async () => false,
    isFirstLaunchOnboardingPending: async () => pending,
    finishFirstLaunchOnboarding: () => completion.promise,
  },
})
const { DesktopFirstLaunchOnboarding } = await import("../src/renderer/onboarding")
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const host = document.createElement("div")
document.body.append(host)
const ready: boolean[] = []
const mount = () =>
  render(
    () =>
      createComponent(DesktopFirstLaunchOnboarding, {
        initialUrl: "/",
        onReady: (value: boolean) => ready.push(value),
      }),
    host,
  )

const hidden = mount()
await tick()
assert.ok(!ready.includes(true), "must await onboarding evaluation")
evaluation.resolve()
await tick()
assert.equal(ready.at(-1), true, "hidden onboarding releases the ready gate")
hidden()
assert.equal(ready.at(-1), false, "unmounted onboarding closes the ready gate")

pending = true
evaluation = Promise.withResolvers<void>()
ready.length = 0
const visible = mount()
evaluation.resolve()
await tick()
assert.ok(document.querySelector(".desktop-onboarding"))
assert.ok(!ready.includes(true), "visible onboarding keeps the ready gate closed")
const skip = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "desktop.onboarding.skip")
assert.ok(skip)
skip.click()
await tick()
assert.ok(!ready.includes(true), "completion must persist before readiness")
completion.resolve()
await tick()
assert.equal(ready.at(-1), true)
assert.equal(document.querySelector(".desktop-onboarding"), null)
visible()

pending = false
evaluation = Promise.withResolvers<void>()
ready.length = 0
const stale = mount()
await tick()
stale()
evaluation.resolve()
await tick()
assert.ok(!ready.includes(true), "a late evaluation cannot reopen an unmounted ready gate")
host.remove()
console.log("onboarding ready gate: hidden, visible, completion, teardown verified")
