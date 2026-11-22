import remend from "remend"

const capacity = 256 * 1024
const stock = { linkMode: "text-only" } as const
const withoutLinks = { ...stock, links: false, images: false }
let accelerated: ReturnType<typeof createMarkdownLinkRepair> | undefined
let loading = false

export function repairMarkdown(text: string) {
  if (!text.includes("[")) return remend(text, withoutLinks)
  if (accelerated) return accelerated(text)
  if (!loading && typeof window !== "undefined" && typeof WebAssembly !== "undefined") {
    loading = true
    void fetch(new URL("./markdown-links.wasm", import.meta.url))
      .then((response) => response.arrayBuffer())
      .then((bytes) => WebAssembly.instantiate(bytes))
      .then(({ instance }) => {
        accelerated = createMarkdownLinkRepair(instance)
      })
      .catch(() => undefined)
  }
  return remend(text, needsLinkRepair(text) ? stock : withoutLinks)
}

export function createMarkdownLinkRepair(instance: WebAssembly.Instance) {
  const wasm = instance.exports as {
    memory: WebAssembly.Memory
    input_ptr(): number
    output_ptr(): number
    repair_links(length: number): number
  }
  const encoder = new TextEncoder()
  let input = new Uint8Array(wasm.memory.buffer, wasm.input_ptr(), capacity)
  let offsets = new Uint32Array(wasm.memory.buffer, wasm.output_ptr(), 2)
  let fallback = false
  const options = {
    ...withoutLinks,
    handlers: [
      {
        name: "markdownLinks",
        // Replace the text-only link handler at its priority in Remend 1.3.0.
        priority: 20,
        handle(text: string) {
          if (!text.includes("[")) return text
          if (input.buffer !== wasm.memory.buffer)
            input = new Uint8Array(wasm.memory.buffer, wasm.input_ptr(), capacity)
          const copied = encoder.encodeInto(text, input)
          if (copied.read !== text.length) {
            fallback = true
            return text
          }

          const action = wasm.repair_links(copied.written)
          if (action === 0) return text
          if (offsets.buffer !== wasm.memory.buffer) offsets = new Uint32Array(wasm.memory.buffer, wasm.output_ptr(), 2)
          const start = offsets[0]
          if (action === 1) return text.slice(0, start) + text.slice(start + 1)
          if (action === 2) return text.slice(0, start) + text.slice(start + 1, offsets[1])
          if (action === 3) return text.slice(0, start)
          fallback = true
          return text
        },
      },
    ],
  }
  return (text: string) => {
    fallback = false
    // Remend invokes its handlers synchronously. If the module could not scan
    // the input, rerun from the original text to preserve the repair order.
    const repaired = remend(text, options)
    return fallback ? remend(text, needsLinkRepair(text) ? stock : withoutLinks) : repaired
  }
}

function needsLinkRepair(text: string) {
  // Remend can strip an unfinished HTML tag before repairing links. A closing
  // bracket or parenthesis inside that tag may disappear.
  if (text.includes("<")) return true

  // Remend checks the prefix for code at every opening bracket. If all opening
  // brackets and the last link destination close, that handler has no work.
  let brackets = 0
  let pendingDestination = false
  let afterBracket = false
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (char === "[") brackets++
    if (char === "]" && brackets > 0) brackets--
    if (char === "(" && afterBracket) pendingDestination = true
    if (char === ")") pendingDestination = false
    afterBracket = char === "]"
  }
  return brackets > 0 || pendingDestination
}
