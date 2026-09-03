import { tool } from "@turenlabs/plugin/tool"
import { define } from "@turenlabs/plugin/v2/effect"

const runtimeKey = "@turenlabs/plugin/runtime-sdk"
const entries: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ["", { tool }],
  ["/tool", { tool }],
  ["/v2/effect", { define }],
  ["/v2/effect/plugin", { define }],
  ["/v2/promise", { define }],
]
const modules = new Map(
  ["@turenlabs/plugin", "@opencode-ai/plugin"].flatMap((scope) =>
    entries.map(([path, exports]) => [scope + path, exports] as const),
  ),
)
const urls = new Map(Array.from(modules.keys(), (specifier, index) => [specifier, `turen:plugin-sdk/${index}`]))
const sources = new Map(
  Array.from(modules, ([specifier, exports]) => [
    urls.get(specifier),
    Object.keys(exports)
      .map(
        (name) =>
          `export const ${name} = globalThis[Symbol.for(${JSON.stringify(runtimeKey)})][${JSON.stringify(name)}]`,
      )
      .join("\n"),
  ]),
)

const registration = typeof Bun === "undefined" ? registerNode() : Promise.resolve(registerBun())

export function registerLocalPluginSdk() {
  return registration
}

function registerBun() {
  Bun.plugin({
    name: "turen-local-plugin-sdk",
    setup(builder) {
      for (const [specifier, exports] of modules) {
        builder.module(specifier, () => ({ exports, loader: "object" }))
      }
    },
  })
}

async function registerNode() {
  const key = Symbol.for(runtimeKey)
  if (!Object.getOwnPropertyDescriptor(globalThis, key)) {
    Object.defineProperty(globalThis, key, {
      configurable: false,
      enumerable: false,
      value: Object.freeze({ tool, define }),
      writable: false,
    })
  }

  const { registerHooks } = await import("node:module")
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = urls.get(specifier)
      if (!url) return nextResolve(specifier, context)
      return { shortCircuit: true, url }
    },
    load(url, context, nextLoad) {
      const source = sources.get(url)
      if (source === undefined) return nextLoad(url, context)
      return { format: "module", shortCircuit: true, source }
    },
  })
}
