import assert from "node:assert/strict"
import { mock } from "bun:test"
import { plugin } from "bun"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ForgeClient } from "../../../sdk/js/src/v2/gen/sdk.gen"
import { createClient } from "@turenlabs/sdk/v2/gen/client"
import type { Team } from "@turenlabs/schema/team"
import type { Part, SessionMessage } from "@turenlabs/sdk/v2"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
plugin({
  name: "team-rich-output-fixture",
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
const observerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver")
const observers: Array<{ target?: Element; callback: IntersectionObserverCallback }> = []
// Happy DOM cannot determine intersection. Control this native boundary in the isolated process.
Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  value: class {
    entry: (typeof observers)[number]
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback }
      observers.push(this.entry)
    }
    observe(target: Element) {
      this.entry.target = target
    }
    disconnect() {}
  },
})
const reveal = (host: HTMLElement) => {
  const entry = observers.find((item) => item.target === host.querySelector('[data-component="team-message-content"]'))!
  assert.ok(entry)
  entry.callback(
    [{ target: entry.target!, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  )
}
const imageResults: Promise<unknown>[] = []
await mock.module("@turenlabs/session-ui/markdown", () => ({
  Markdown: (props: {
    text: string
    resolveImage: (path: string) => Promise<unknown>
    onFileLink: (path: string) => void
  }) => {
    const node = document.createElement("div")
    node.textContent = props.text
    const button = document.createElement("button")
    button.textContent = "Preview report"
    button.onclick = () => props.onFileLink("report.txt")
    node.append(button)
    if (props.text.includes("image")) imageResults.push(props.resolveImage("diagram.png"))
    return node
  },
}))
await mock.module("@turenlabs/session-ui/message-part", () => ({
  Part: (props: { part: Part }) => {
    const node = document.createElement("p")
    node.dataset.tool = props.part.id
    node.textContent = "Successful rich output"
    return node
  },
}))
let preview: string | undefined
await mock.module("@turenlabs/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (component: () => unknown) => {
      const host = document.createElement("div")
      render(component, host)
      preview = host.textContent ?? undefined
    },
  }),
}))
await mock.module("@turenlabs/ui/dialog", () => ({ Dialog: (props: { children: unknown }) => props.children }))
await mock.module("@turenlabs/ui/context/file", () => ({
  useFileComponent: () => (props: { file: { contents: string } }) => {
    const node = document.createElement("p")
    node.textContent = props.file.contents
    return node
  },
}))
const files: Request[] = []
await mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "web",
    fetch: async (input: Parameters<typeof fetch>[0]) => {
      files.push(new Request(input))
      return new Response("On-demand file preview", { headers: { "Content-Type": "text/plain" } })
    },
  }),
}))
const source = (id: string): SessionMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  time: { created: 1, completed: 2 },
  content: [
    {
      id: "rich-tool",
      type: "tool",
      name: "safehtml",
      time: { created: 1, completed: 2 },
      state: { status: "completed", input: {}, content: [] },
    },
  ],
})
const requests: Request[] = []
let retryPending: ((response: Response) => void) | undefined
let retried = false
const makeClient = (baseUrl: string) =>
  new ForgeClient({
    client: createClient({
      baseUrl,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const request = new Request(input)
          requests.push(request)
          const path = new URL(request.url).pathname.split("/")
          if (path[4] === "message") {
            if (path[5] === "missing" && new URL(request.url).hostname === "first.test") {
              if (retried)
                return new Promise<Response>((resolve) => {
                  retryPending = resolve
                })
              retried = true
              return Response.json({ message: "Missing source" }, { status: 503 })
            }
            return Response.json({ data: source(path[5]!) })
          }
          return Response.json({ data: { id: path[3], location: { directory: "/actual" } } })
        },
        { preconnect() {} },
      ),
    }),
  })
const [sdk, setSDK] = createSignal({
  client: makeClient("http://first.test"),
  server: { type: "http", http: { url: "http://first.test" } },
})
await mock.module("@/context/server-sdk", () => ({ useServerSDK: () => sdk }))
const { TeamMessageContent } = await import("@/pages/team/message-content")
const message = (id: string, ids: string[] = []): Team.Message => ({
  id,
  roomID: "room",
  seq: 1,
  kind: "teammate",
  author: "Lead",
  text: `Text ${id}`,
  time: 1,
  sessionID: id,
  sourceMessageIDs: ids,
})
const mounted: Array<() => void> = []
const mount = (value: Team.Message) => {
  const host = document.createElement("div")
  host.setAttribute("role", "log")
  document.body.append(host)
  const dispose = render(() => createComponent(TeamMessageContent, { message: value }), host)
  mounted.push(() => {
    dispose()
    host.remove()
  })
  return host
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function until(check: () => boolean, reason: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await flush()
  }
  assert.fail(`${reason}\n${document.body.textContent}\n${requests.map((request) => request.url).join("\n")}`)
}
try {
  const rich = mount(message("rich", ["assistant", "missing"]))
  const plain = mount(message("plain"))
  const image = mount({ ...message("image"), text: "Local image" })
  await flush()
  assert.equal(requests.length, 0, "Offscreen messages fetched Session data")
  assert.equal(files.length, 0, "Offscreen images fetched files")
  assert.ok(rich.textContent?.includes("Text rich"), "Offscreen text is not visible")
  reveal(plain)
  await flush()
  assert.equal(requests.length, 0, "Empty source IDs fetched metadata")
  plain.querySelector<HTMLButtonElement>("button")!.click()
  await until(() => !!preview, "File preview did not load")
  assert.equal(preview, "On-demand file preview")
  assert.equal(files.length, 1)
  assert.equal(new URL(files[0]!.url).searchParams.get("location[directory]"), "/actual")

  reveal(rich)
  await until(() => !!rich.textContent?.includes("Some rich output"), "Missing source did not show retry")
  const rendered = rich.querySelector('[data-tool="rich-tool"]')!
  assert.ok(rendered)
  const retry = [...rich.querySelectorAll("button")].find((button) => button.textContent === "Retry")!
  retry.click()
  await until(() => !!retryPending, "Retry did not fetch the failed source")
  assert.equal(rich.querySelector('[data-tool="rich-tool"]'), rendered, "Retry cleared successful output")
  retryPending?.(Response.json({ data: { ...source("missing"), content: [] } }))
  await until(() => !rich.textContent?.includes("Some rich output"), "Retry did not recover")
  assert.equal(rich.querySelector('[data-tool="rich-tool"]'), rendered, "Retry remounted successful output")
  const shared = mount(message("rich", ["assistant"]))
  const count = requests.length
  reveal(shared)
  await until(() => !!shared.querySelector('[data-tool="rich-tool"]'), "Shared output did not load")
  assert.equal(requests.length, count, "Shared source requests were not reused")

  reveal(image)
  await Promise.all(imageResults)
  assert.equal(files.length, 2, "Visible image did not load")
  const previous = requests.length
  setSDK({ client: makeClient("http://second.test"), server: { type: "http", http: { url: "http://second.test" } } })
  assert.equal(rich.querySelector('[data-tool="rich-tool"]'), null, "Server switch retained previous output")
  await until(
    () => requests.length > previous && !!rich.querySelector('[data-tool="rich-tool"]'),
    "Server switch did not load output",
  )
  assert.ok(requests.slice(previous).every((request) => new URL(request.url).hostname === "second.test"))
  console.log("Team rich output checks passed")
} finally {
  mounted.forEach((dispose) => dispose())
  if (observerDescriptor) Object.defineProperty(globalThis, "IntersectionObserver", observerDescriptor)
  else Reflect.deleteProperty(globalThis, "IntersectionObserver")
}
