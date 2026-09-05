import assert from "node:assert/strict"
import { plugin } from "bun"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

// Compile the real Solid component in an isolated process, as other UI fixtures do.
const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "binary-viewer-fixture",
  setup(build) {
    build.onLoad({ filter: /binary-viewer\.tsx$/ }, async (args) => {
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

const { BinaryViewer } = await import("@turenlabs/session-ui/binary-viewer")
const host = document.createElement("div")
document.body.append(host)
const dispose = render(
  () =>
    createComponent(BinaryViewer, {
      snapshot: {
        path: "sample.bin",
        kind: "disassembly",
        bitness: 64,
        warnings: ["Captured range only"],
        rows: Array.from({ length: 129 }, (_, index) => ({
          offset: 32 + index,
          address: `0x${(0xffffffffffff0000n + BigInt(index)).toString(16)}`,
          bytes: ["55"],
          text: "push rbp",
        })),
      },
    }),
  host,
)
const button = (text: string) => {
  const element = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === text)
  assert.ok(element, `Missing button ${text}`)
  return element
}
assert.equal(host.querySelectorAll("tbody tr").length, 128)
assert.ok(host.textContent?.includes("0xffffffffffff0000"))
assert.ok(host.textContent?.includes("Read-only snapshot / x86 64-bit"))
assert.equal(button("Copy selection").disabled, true)
button("0x00000020").click()
assert.equal(host.querySelectorAll("tr[data-selected]").length, 1)
assert.equal(button("Copy selection").disabled, false)
button("Hex").click()
assert.equal(host.querySelector("[data-slot=binary-ascii]")?.textContent, "U")
assert.equal(host.querySelector("tr[data-selected] [data-slot=binary-bytes]")?.textContent, "55")
button("Disassembly").click()
assert.equal(host.querySelector("tr[data-selected] [data-slot=binary-instruction]")?.textContent, "push rbp")
button("Next").click()
assert.equal(host.querySelectorAll("tbody tr").length, 1)
assert.equal(button("Next").disabled, true)
button("Previous").click()
assert.equal(host.querySelectorAll("tr[data-selected]").length, 1)
assert.ok(host.textContent?.includes("Only captured bytes are shown"))
dispose()
host.remove()
console.log("binary viewer checks passed")
