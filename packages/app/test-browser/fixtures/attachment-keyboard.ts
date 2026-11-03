import assert from "node:assert/strict"
import { plugin } from "bun"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "attachment-keyboard",
  setup(build) {
    build.onLoad({ filter: /attachment-card-v2\.tsx$/ }, async (args) => {
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
const { AttachmentCardV2 } = await import("@turenlabs/session-ui/v2/attachment-card-v2")
const host = document.createElement("div")
document.body.append(host)
const [enabled, setEnabled] = createSignal(true)
let actions = 0
const dispose = render(() => createComponent(AttachmentCardV2, {
  title: "file.txt",
  get clickable() { return enabled() },
  onClick: () => { actions++ },
  children: "Text",
}), host)
const card = host.firstElementChild as HTMLElement
assert.equal(card.getAttribute("role"), "button")
assert.equal(card.tabIndex, 0)
card.focus()
assert.equal(document.activeElement, card)
for (const key of ["Enter", " "]) {
  const count = actions
  card.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  card.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true }))
  card.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
  assert.equal(actions, count + 1)
}
setEnabled(false)
assert.equal(card.hasAttribute("role"), false)
assert.equal(card.hasAttribute("tabindex"), false)
for (const key of ["Enter", " "]) {
  card.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
  card.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }))
}
card.click()
assert.equal(actions, 2)
dispose()
host.remove()
console.log("attachment keyboard checks passed")
