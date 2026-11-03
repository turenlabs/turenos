import assert from "node:assert/strict"
import { mock } from "bun:test"
import { plugin } from "bun"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { FilePart, UserMessage } from "@turenlabs/sdk/v2"

const compiler = await import("@babel/core")
const preset = await import("babel-preset-solid")
const animationPlugin = (await import("@turenlabs/session-ui/vite")).animationRuntimePlugin()
const animationRuntime = await animationPlugin.load.call({ addWatchFile() {} }, "\0virtual:turen-animation-runtime")
const licenses = await animationPlugin.load.call({ addWatchFile() {} }, "\0virtual:turen-visualization-licenses")
plugin({
  name: "sent-file-cards",
  setup(build) {
    build.module("virtual:turen-animation-runtime", () => ({
      exports: { default: JSON.parse(animationRuntime!.slice("export default ".length, -1)) },
      loader: "object",
    }))
    build.module("virtual:turen-visualization-licenses", () => ({
      exports: { default: JSON.parse(licenses!.slice("export default ".length, -1)) },
      loader: "object",
    }))
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const source =
        process.env.ATTACHMENT_BASE_COMPONENT &&
        /session-ui[\\/]src[\\/]components[\\/]message-part\.tsx$/.test(args.path)
          ? process.env.ATTACHMENT_BASE_COMPONENT
          : args.path
      const result = await compiler.transformAsync(await Bun.file(source).text(), {
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
await mock.module("@turenlabs/session-ui/context", () => ({ useData: () => ({ store: {} }) }))
let previews = 0
await mock.module("@turenlabs/ui/context/dialog", () => ({
  useDialog: () => ({
    show: () => {
      previews++
    },
  }),
}))
await mock.module("@turenlabs/ui/context/i18n", () => ({
  useI18n: () => ({ locale: () => "en-US", t: (key: string) => key }),
}))
await mock.module("@turenlabs/session-ui/markdown", () => ({ Markdown: () => document.createElement("div") }))
const { presentSessionV2Messages } = await import("../../src/pages/session/goal/session-v2-presentation")
const { UserMessageDisplay } = await import("@turenlabs/session-ui/message-part")
const dataImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN0AAAAASUVORK5CYII="
const projected = presentSessionV2Messages({
  sessionID: "session",
  directory: "/repo",
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
  messages: [
    {
      id: "message",
      type: "user",
      text: "Describe @mention.txt",
      time: { created: 1 },
      files: [
        { uri: "file:///repo/color.png", mime: "image/png", name: "/repo/color.png" },
        { uri: "file:///repo/alpha.txt", mime: "text/plain", name: "/repo/alpha.txt" },
        { uri: dataImage, mime: "image/png", name: "data.png" },
        {
          uri: "file:///repo/mention.txt",
          mime: "text/plain",
          name: "mention.txt",
          source: { text: "@mention.txt", start: 9, end: 21 },
        },
        { uri: "cleared:image/png", mime: "image/png", name: "missing.png" },
      ],
    },
  ],
})
const parts = projected.parts[0]!.parts
const opened: FilePart[] = []
document.body.setAttribute("data-new-layout", "")
const host = document.createElement("div")
document.body.append(host)
const dispose = render(
  () =>
    createComponent(UserMessageDisplay, {
      message: projected.messages[0] as UserMessage,
      parts,
      useV2Actions: true,
      actions: {
        openAttachment: (file: FilePart) => {
          opened.push(file)
        },
      },
    }),
  host,
)
const cards = Array.from(host.querySelectorAll<HTMLElement>('[data-component="attachment-card-v2"]'))
assert.equal(host.querySelector('[data-highlight="file"]')?.textContent, "@mention.txt")
assert.equal(cards.length, 2, `native files should render as cards: ${host.innerHTML}`)
assert.deepEqual(
  cards.map((card) => card.querySelector('[data-slot="attachment-card-v2-title"]')?.textContent),
  ["color.png", "alpha.txt"],
)
assert.equal(host.querySelectorAll("img").length, 1)
assert.equal(host.querySelector("img")?.getAttribute("src"), dataImage)
host.querySelector<HTMLElement>('[data-slot="user-message-attachment"]')!.click()
assert.equal(previews, 1)
cards.forEach((card) => card.click())
assert.deepEqual(opened, parts.filter((part) => part.type === "file").slice(0, 2))
dispose()
host.remove()
const mentionHost = document.createElement("div")
document.body.append(mentionHost)
const mention = {
  id: "mention",
  sessionID: "session",
  messageID: "message",
  type: "file" as const,
  mime: "text/plain",
  url: "file:///repo/alpha.txt",
  filename: "alpha.txt",
  source: { type: "file" as const, path: "/repo/alpha.txt", text: { value: "@alpha.txt", start: 0, end: 10 } },
}
const disposeMention = render(
  () =>
    createComponent(UserMessageDisplay, {
      message: projected.messages[0] as UserMessage,
      parts: [
        { id: "text", sessionID: "session", messageID: "message", type: "text", text: "@alpha.txt" },
        mention,
        { ...mention, id: "remote", url: "https://example.test/missing.png", source: undefined },
      ],
    }),
  mentionHost,
)
assert.equal(mentionHost.querySelector('[data-highlight="file"]')?.textContent, "@alpha.txt")
assert.equal(mentionHost.querySelector('[data-slot="user-message-attachments"]'), null)
assert.equal(mentionHost.querySelector("img"), null)
disposeMention()
mentionHost.remove()
const attachmentOnly = presentSessionV2Messages({
  sessionID: "session",
  directory: "/repo",
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
  messages: [
    {
      id: "image-only",
      type: "user",
      text: "",
      time: { created: 1 },
      files: [{ uri: "file:///repo/color.png", mime: "image/png", name: "/repo/color.png" }],
    },
  ],
})
const readOnlyHost = document.createElement("div")
document.body.append(readOnlyHost)
let readOnlyClicks = 0
const disposeReadOnly = render(
  () =>
    createComponent(UserMessageDisplay, {
      message: attachmentOnly.messages[0] as UserMessage,
      parts: attachmentOnly.parts[0]!.parts,
      actions: {
        canOpenAttachment: () => false,
        openAttachment: () => {
          readOnlyClicks++
        },
      },
    }),
  readOnlyHost,
)
const readOnlyCard = readOnlyHost.querySelector<HTMLElement>('[data-component="attachment-card-v2"]')!
assert.ok(readOnlyCard)
assert.equal(readOnlyCard.getAttribute("title"), "/repo/color.png")
if (!process.env.ATTACHMENT_ROUTE_RED) assert.equal(readOnlyCard.hasAttribute("data-clickable"), false)
readOnlyCard.click()
if (!process.env.ATTACHMENT_ROUTE_RED) assert.equal(readOnlyClicks, 0)
disposeReadOnly()
readOnlyHost.remove()
const failures: Array<{ variant: string; title: string; description?: string }> = []
await mock.module("@/utils/toast", () => ({ showToast: (toast: (typeof failures)[number]) => failures.push(toast) }))
const local = { type: "sidecar" as const, variant: "base" as const, http: { url: "http://127.0.0.1:4096" } }
const remote = { type: "ssh" as const, host: "remote", http: { url: "http://127.0.0.1:4097" } }
const [route, setRoute] = createSignal<typeof local | typeof remote>(local)
const [selected, setSelected] = createSignal<typeof local | typeof remote>(remote)
const serverModule = await import("../../src/context/server")
await mock.module("@/context/server", () => ({
  ...serverModule,
  useServer: () => ({
    get current() {
      return selected()
    },
  }),
}))
await mock.module("@/context/global", () => ({
  useGlobal: () => ({ ensureServerCtx: (server: typeof local | typeof remote) => ({ sdk: { server } }) }),
}))
await mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
const { ServerSDKProvider, useServerSDK } = await import("../../src/context/server-sdk")
const { createSessionAttachmentActions } = await import("../../src/pages/session/attachment-actions")
const [available, setAvailable] = createSignal(true)
const revealed: string[] = []

const downloads: Array<{ url: string; filename: string }> = []
let result: "success" | "missing" | "error" = "success"
const originalAnchorClick = HTMLAnchorElement.prototype.click
HTMLAnchorElement.prototype.click = function () {
  downloads.push({ url: this.getAttribute("href") ?? "", filename: this.download })
}
const platform = {
  get revealPath() {
    if (!available()) return undefined
    return async (path: string) => {
      revealed.push(path)
      if (result === "error") throw new Error("reveal failed")
      return result === "success"
    }
  },
}
let actions: ReturnType<typeof createSessionAttachmentActions>
const file = parts.find((part): part is FilePart => part.type === "file")!
const data = {
  ...file,
  id: "data-file",
  url: "data:text/plain;base64,SGVsbG8=",
  mime: "text/plain",
  filename: "/repo/data.txt",
}
const actionHost = document.createElement("div")
document.body.append(actionHost)
const disposeActions = render(
  () =>
    createComponent(ServerSDKProvider, {
      server: route,
      get children() {
        const serverSDK = useServerSDK()
        actions = createSessionAttachmentActions({ serverSDK, platform, revealFailedTitle: () => "Request failed" })
        return createComponent(UserMessageDisplay, {
          message: projected.messages[0] as UserMessage,
          parts: [...parts, data],
          useV2Actions: true,
          actions,
        })
      },
    }),
  actionHost,
)
const actionCards = Array.from(actionHost.querySelectorAll<HTMLElement>('[data-component="attachment-card-v2"]'))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(selected(), remote)
assert.equal(actionCards[0]!.dataset.clickable, "true")
actionCards[0]!.click()
await tick()
assert.deepEqual(revealed, ["/repo/color.png"])
const activateKey = (card: HTMLElement, key: string) => {
  card.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  card.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
}
for (const newLayout of [false, true]) {
  document.body.toggleAttribute("data-new-layout", newLayout)
  assert.equal(actionCards[0]!.getAttribute("role"), "button")
  assert.equal(actionCards[0]!.tabIndex, 0)
  actionCards[0]!.focus()
  assert.equal(document.activeElement, actionCards[0])
  for (const key of ["Enter", " "]) {
    const count = revealed.length
    activateKey(actionCards[0]!, key)
    await tick()
    assert.equal(revealed.length, count + 1, `${key} must reveal exactly once`)
    assert.equal(revealed.at(-1), "/repo/color.png")
  }
}
revealed.splice(1)
setRoute(remote)
setSelected(local)
assert.equal(selected(), local)
assert.equal(actionCards[0]!.hasAttribute("data-clickable"), false)
assert.equal(actionCards[0]!.hasAttribute("role"), false)
assert.equal(actionCards[0]!.hasAttribute("tabindex"), false)
activateKey(actionCards[0]!, "Enter")
activateKey(actionCards[0]!, " ")
actionCards[0]!.click()
actions.openAttachment(file)
await tick()
assert.deepEqual(revealed, ["/repo/color.png"])
assert.deepEqual(downloads, [])
assert.equal(actionCards[2]!.dataset.clickable, "true")
actionCards[2]!.click()
await tick()
assert.deepEqual(revealed, ["/repo/color.png"])
assert.deepEqual(downloads, [{ url: data.url, filename: "data.txt" }])
downloads.length = 0
setRoute(local)
setAvailable(false)
assert.equal(actionCards[0]!.hasAttribute("data-clickable"), false)
actionCards[0]!.click()
assert.deepEqual(revealed, ["/repo/color.png"])
actionCards[2]!.click()
assert.deepEqual(downloads, [{ url: data.url, filename: "data.txt" }])
downloads.length = 0
setAvailable(true)
actionCards[0]!.click()
setRoute(remote)
await tick()
assert.deepEqual(revealed, ["/repo/color.png"])
setRoute(local)
result = "missing"
actionCards[0]!.click()
await tick()
result = "error"
actionCards[0]!.click()
await tick()
assert.deepEqual(failures, [
  { variant: "error", title: "Request failed", description: "/repo/color.png" },
  { variant: "error", title: "Request failed", description: "/repo/color.png" },
])
assert.deepEqual(downloads, [])
assert.equal(actions.canOpenAttachment({ ...file, url: "https://example.test/file" }), false)
assert.equal(actions.canOpenAttachment({ ...file, filename: "relative.txt" }), false)
assert.equal(actions.canOpenAttachment({ ...file, filename: "C:\\repo\\file.txt" }), true)
assert.equal(actionCards[2]!.dataset.clickable, "true")
result = "success"
actionCards[2]!.click()
await tick()
assert.equal(revealed.at(-1), "/repo/data.txt")
assert.deepEqual(downloads, [])
result = "missing"
actionCards[2]!.click()
await tick()
result = "error"
actionCards[2]!.click()
await tick()
assert.deepEqual(downloads, [
  { url: data.url, filename: "data.txt" },
  { url: data.url, filename: "data.txt" },
])
assert.equal(failures.length, 2)
disposeActions()
actionHost.remove()
HTMLAnchorElement.prototype.click = originalAnchorClick
console.log("sent file cards checks passed")
process.exit(0)
